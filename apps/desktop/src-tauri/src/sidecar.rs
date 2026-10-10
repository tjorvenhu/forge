//! Owns the Node sidecar process. The webview never gets a socket or shell:
//! it can only send protocol lines through `sidecar_send`, and receives
//! stdout lines as `sidecar://message` events.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const STDERR_TAIL_BYTES: usize = 8 * 1024;

#[derive(Default)]
pub struct Sidecar {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Mutex<Option<ChildStdin>>,
    generation: Arc<AtomicU64>,
    stderr_tail: Arc<Mutex<String>>,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
    stderr: String,
}

fn node_binary() -> String {
    std::env::var("FORGE_NODE").unwrap_or_else(|_| "node".into())
}

fn sidecar_script(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("FORGE_SIDECAR") {
        return Ok(PathBuf::from(p));
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/sidecar/dist/sidecar.mjs");
        if dev.exists() {
            return Ok(dev);
        }
    }
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("sidecar")
        .join("sidecar.mjs");
    if res.exists() {
        Ok(strip_verbatim(res))
    } else {
        Err(format!("Sidecar nicht gefunden: {}", res.display()))
    }
}

/// Tauri returns resource paths as `\\?\C:\...` on Windows; Node's module loader cannot resolve those.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

impl Sidecar {
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let script = sidecar_script(app)?;
        let mut cmd = Command::new(node_binary());
        cmd.arg("--no-warnings")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = script.parent() {
            cmd.current_dir(dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| {
            let msg = format!("Node.js konnte nicht gestartet werden ({e}). Ist Node.js ab 22.13 installiert?");
            let _ = app.emit("sidecar://exit", ExitPayload { code: None, stderr: msg.clone() });
            msg
        })?;

        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let stdout = child.stdout.take().ok_or("kein stdout")?;
        let stderr = child.stderr.take().ok_or("kein stderr")?;
        *self.stdin.lock().unwrap() = child.stdin.take();
        *self.child.lock().unwrap() = Some(child);
        self.stderr_tail.lock().unwrap().clear();

        let tail = self.stderr_tail.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let chunk = String::from_utf8_lossy(&buf[..n]);
                #[cfg(debug_assertions)]
                eprint!("{chunk}");
                let mut t = tail.lock().unwrap();
                t.push_str(&chunk);
                if t.len() > STDERR_TAIL_BYTES {
                    let cut = t.len() - STDERR_TAIL_BYTES;
                    let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                    t.drain(..cut);
                }
            }
        });

        let app_out = app.clone();
        let child_ref = self.child.clone();
        let gen_ref = self.generation.clone();
        let tail_ref = self.stderr_tail.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        let _ = app_out.emit("sidecar://message", l);
                    }
                    Err(_) => break,
                }
            }
            // stdout closed: the process is gone or going. Only report if this is still the current one.
            if gen_ref.load(Ordering::SeqCst) != gen {
                return;
            }
            let code = child_ref
                .lock()
                .unwrap()
                .take()
                .and_then(|mut c| c.wait().ok())
                .and_then(|s| s.code());
            let stderr = tail_ref.lock().unwrap().clone();
            let _ = app_out.emit("sidecar://exit", ExitPayload { code, stderr });
        });
        Ok(())
    }

    pub fn send(&self, line: &str) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or("Hintergrunddienst läuft nicht")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Senden fehlgeschlagen: {e}"))
    }

    pub fn is_running(&self) -> bool {
        match self.child.lock().unwrap().as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn restart(&self, app: &AppHandle) -> Result<(), String> {
        self.shutdown();
        self.start(app)
    }

    /// Closes stdin so the sidecar can stop its Claude processes, then kills it after a grace period.
    pub fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        drop(self.stdin.lock().unwrap().take());
        let child = self.child.lock().unwrap().take();
        if let Some(mut c) = child {
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = c.try_wait() {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
