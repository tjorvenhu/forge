//! Embedded terminals: one PTY per tab, output streamed as `term://data` events.
//! Only two programs can be started: the user's shell or the Claude CLI.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::job::Job;

/// One terminal. Shared as Arc so a slow call on one terminal never holds the map lock.
struct Term {
    /// Dropping the master closes the pseudoconsole; under ConPTY that is what ends the output pipe.
    master: Mutex<Box<dyn MasterPty + Send>>,
    /// Keystrokes go to a writer thread: a full input pipe must not block the command.
    input: Sender<Vec<u8>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    /// Holds the shell and everything started in it. Killing only the shell would leave e.g. `pnpm dev`
    /// running and keep the folder locked; dropping the Term (also when the shell exits) ends them too.
    job: Option<Job>,
}

impl Term {
    fn kill(&self) {
        if let Some(job) = &self.job {
            job.terminate();
        }
        let _ = self.killer.lock().unwrap().kill();
    }
}

type TermMap = Arc<Mutex<HashMap<u32, Arc<Term>>>>;

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    terms: TermMap,
}

/// Parameters of `term_open` from the webview.
pub struct OpenRequest {
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub program: String,
    pub claude_path: Option<String>,
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

/// How long the exit event waits for the last output after the program ended.
const OUTPUT_DRAIN: Duration = Duration::from_secs(2);

fn default_shell() -> (String, Vec<String>) {
    // Absolute path: Windows PowerShell is not guaranteed to be on PATH.
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let ps = Path::new(&root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let exe = if ps.is_file() { ps.to_string_lossy().into_owned() } else { "powershell.exe".into() };
    (exe, vec!["-NoLogo".into()])
}

/// PATH entries in front of the user's PATH, as `bundledPathEntries` in the sidecar
/// (packages/sidecar/src/util/tools.ts): shipped git, gh and python, then the folder where
/// `pip install --user` puts scripts. In front, so the Store placeholder python.exe in WindowsApps
/// does not win.
fn runtime_path_entries(rt: &Path, user_base: Option<OsString>, appdata: Option<OsString>) -> Vec<PathBuf> {
    let mut parts: Vec<PathBuf> = vec![rt.join("git").join("cmd"), rt.join("gh").join("bin")];
    let python = rt.join("python");
    if !python.is_dir() {
        return parts;
    }
    parts.push(python);
    let version = std::fs::read_to_string(rt.join("VERSIONS.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("python").and_then(|p| p.as_str()).map(str::to_owned));
    let base = user_base.filter(|b| !b.is_empty()).map(PathBuf::from).or_else(|| appdata.map(|a| PathBuf::from(a).join("Python")));
    if let (Some(version), Some(base)) = (version, base) {
        let mut it = version.split('.');
        if let (Some(major), Some(minor)) = (it.next(), it.next()) {
            parts.push(base.join(format!("Python{major}{minor}")).join("Scripts"));
        }
    }
    parts
}

/// The webview may only start the real Claude CLI: an existing file named claude.exe or claude.cmd.
fn validate_claude_path(p: Option<String>) -> Result<String, String> {
    let p = p.ok_or("Claude Code nicht gefunden")?;
    let name = Path::new(&p).file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
    if !matches!(name.as_str(), "claude.exe" | "claude.cmd") || !Path::new(&p).is_file() {
        return Err("Ungültiger Pfad zur Claude-CLI".into());
    }
    Ok(p)
}

impl Terminals {
    pub fn open(&self, app: &AppHandle, runtime: Option<PathBuf>, req: OpenRequest) -> Result<u32, String> {
        let dir = Path::new(&req.cwd);
        if !dir.is_dir() {
            return Err(format!("Ordner existiert nicht: {}", req.cwd));
        }
        let (exe, args) = match req.program.as_str() {
            "shell" => default_shell(),
            "claude" => (validate_claude_path(req.claude_path)?, vec![]),
            _ => return Err("Unbekanntes Programm".into()),
        };

        let pty = native_pty_system();
        let size = PtySize { rows: req.rows, cols: req.cols, pixel_width: 0, pixel_height: 0 };
        let pair = pty.openpty(size).map_err(|e| e.to_string())?;
        let mut cmd = CommandBuilder::new(exe);
        cmd.args(args);
        cmd.cwd(dir);
        for k in STRIP_ENV {
            cmd.env_remove(k);
        }
        if let Some(rt) = runtime {
            let mut parts = runtime_path_entries(&rt, std::env::var_os("PYTHONUSERBASE"), std::env::var_os("APPDATA"));
            if let Some(cur) = std::env::var_os("PATH") {
                parts.extend(std::env::split_paths(&cur));
            }
            if let Ok(joined) = std::env::join_paths(parts) {
                cmd.env("PATH", joined);
            }
            // Same as the sidecar's sessionEnv: piped Python output in the ANSI code page fails on the first
            // character outside it.
            if rt.join("python").join("python.exe").is_file() && std::env::var_os("PYTHONUTF8").is_none() {
                cmd.env("PYTHONUTF8", "1");
            }
        }
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let killer = child.clone_killer();
        let job = child.process_id().and_then(|pid| Job::for_pid(pid).map_err(|e| eprintln!("[forge] terminal job object failed: {e}")).ok());

        let (input, keys) = mpsc::channel::<Vec<u8>>();
        thread::spawn(move || {
            for data in keys {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });

        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let term = Arc::new(Term { master: Mutex::new(pair.master), input, killer: Mutex::new(killer), job });
        self.terms.lock().unwrap().insert(id, term);

        let (drained_tx, drained_rx) = mpsc::channel::<()>();
        let app_data = app.clone();
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
                        let _ = app_data.emit("term://data", DataPayload { id, data });
                    }
                }
            }
            drop(drained_tx);
        });

        // The output pipe alone does not tell when the program ended: under ConPTY it stays open
        // until the pseudoconsole is closed. So the exit comes from the process itself.
        let app_exit = app.clone();
        let terms = self.terms.clone();
        thread::spawn(move || {
            let _ = child.wait();
            let removed = terms.lock().unwrap().remove(&id);
            drop(removed);
            let _ = drained_rx.recv_timeout(OUTPUT_DRAIN);
            let _ = app_exit.emit("term://exit", ExitPayload { id });
        });
        Ok(id)
    }

    fn get(&self, id: u32) -> Result<Arc<Term>, String> {
        self.terms.lock().unwrap().get(&id).cloned().ok_or_else(|| "Terminal nicht gefunden".to_string())
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        self.get(id)?.input.send(data.as_bytes().to_vec()).map_err(|_| "Terminal ist beendet".to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let term = self.get(id)?;
        let master = term.master.lock().unwrap();
        master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
    }

    pub fn close(&self, id: u32) {
        let removed = self.terms.lock().unwrap().remove(&id);
        if let Some(t) = removed {
            t.kill();
        }
    }

    pub fn shutdown(&self) {
        let all: Vec<Arc<Term>> = self.terms.lock().unwrap().drain().map(|(_, t)| t).collect();
        for t in all {
            t.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::runtime_path_entries;
    use std::path::PathBuf;

    #[test]
    fn python_and_its_user_scripts_come_after_git_and_gh() {
        let rt = std::env::temp_dir().join(format!("forge-term-rt-{}", std::process::id()));
        std::fs::create_dir_all(rt.join("python")).unwrap();
        std::fs::write(rt.join("VERSIONS.json"), r#"{"node":"24.21.0","python":"3.14.8"}"#).unwrap();
        let parts = runtime_path_entries(&rt, None, Some(r"C:\Users\x\AppData\Roaming".into()));
        assert_eq!(
            parts,
            vec![
                rt.join("git").join("cmd"),
                rt.join("gh").join("bin"),
                rt.join("python"),
                PathBuf::from(r"C:\Users\x\AppData\Roaming\Python\Python314\Scripts"),
            ]
        );
        let custom = runtime_path_entries(&rt, Some(r"D:\pyuser".into()), Some(r"C:\Users\x\AppData\Roaming".into()));
        assert_eq!(custom.last(), Some(&PathBuf::from(r"D:\pyuser\Python314\Scripts")));
        std::fs::remove_dir_all(&rt).unwrap();
        assert_eq!(runtime_path_entries(&rt, None, None), vec![rt.join("git").join("cmd"), rt.join("gh").join("bin")]);
    }
}
