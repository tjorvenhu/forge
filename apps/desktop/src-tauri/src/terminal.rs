//! Embedded terminals: one PTY per tab, output streamed as `term://data` events.
//! Only two programs can be started: the user's shell or the Claude CLI.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    terms: Arc<Mutex<HashMap<u32, Term>>>,
}

#[derive(Clone, Serialize)]
struct DataPayload {
    id: u32,
    data: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: u32,
}

/// Session variables of a parent Claude Code process must not leak into the terminal.
const STRIP_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
];

fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        ("powershell.exe".into(), vec!["-NoLogo".into()])
    } else {
        (std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()), vec!["-l".into()])
    }
}

impl Terminals {
    pub fn open(
        &self,
        app: &AppHandle,
        runtime: Option<PathBuf>,
        cwd: &str,
        cols: u16,
        rows: u16,
        program: &str,
        claude_path: Option<String>,
    ) -> Result<u32, String> {
        let dir = Path::new(cwd);
        if !dir.is_dir() {
            return Err(format!("Ordner existiert nicht: {cwd}"));
        }
        let (exe, args) = match program {
            "shell" => default_shell(),
            "claude" => {
                let p = claude_path.ok_or("Claude Code nicht gefunden")?;
                let name = Path::new(&p).file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
                if !(name == "claude" || name == "claude.exe") || !Path::new(&p).is_file() {
                    return Err("Ungültiger Pfad zur Claude-CLI".into());
                }
                (p, vec![])
            }
            _ => return Err("Unbekanntes Programm".into()),
        };

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(exe);
        cmd.args(args);
        cmd.cwd(dir);
        for k in STRIP_ENV {
            cmd.env_remove(k);
        }
        if let Some(rt) = runtime {
            let mut parts: Vec<PathBuf> = vec![rt.join("git").join("cmd"), rt.join("gh").join("bin")];
            if let Some(cur) = std::env::var_os("PATH") {
                parts.extend(std::env::split_paths(&cur));
            }
            if let Ok(joined) = std::env::join_paths(parts) {
                cmd.env("PATH", joined);
            }
        }
        cmd.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.terms.lock().unwrap().insert(id, Term { master: pair.master, writer, child });

        let app2 = app.clone();
        let terms = self.terms.clone();
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        // Emit only complete UTF-8 sequences; keep a split character for the next read.
                        let valid = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) if e.error_len().is_none() => e.valid_up_to(),
                            Err(_) => pending.len(),
                        };
                        let chunk: Vec<u8> = pending.drain(..valid).collect();
                        let data = String::from_utf8_lossy(&chunk).into_owned();
                        let _ = app2.emit("term://data", DataPayload { id, data });
                    }
                }
            }
            terms.lock().unwrap().remove(&id);
            let _ = app2.emit("term://exit", ExitPayload { id });
        });
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut terms = self.terms.lock().unwrap();
        let t = terms.get_mut(&id).ok_or("Terminal nicht gefunden")?;
        t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        t.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let terms = self.terms.lock().unwrap();
        let t = terms.get(&id).ok_or("Terminal nicht gefunden")?;
        t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
    }

    pub fn close(&self, id: u32) {
        if let Some(mut t) = self.terms.lock().unwrap().remove(&id) {
            let _ = t.child.kill();
        }
    }

    pub fn shutdown(&self) {
        for (_, mut t) in self.terms.lock().unwrap().drain() {
            let _ = t.child.kill();
        }
    }
}
