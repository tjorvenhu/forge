//! Owns the Node sidecar process. The webview never gets a socket or shell:
//! it can only send protocol lines through `sidecar_send`, and receives
//! stdout lines as `sidecar://message` events.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const STDERR_TAIL_BYTES: usize = 8 * 1024;
/// How long the sidecar gets to stop its Claude processes and dev servers on its own. Must stay
/// above SHUTDOWN_LIMIT_MS in packages/sidecar/src/app.ts (5 s) plus time to end the processes.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(7);

#[derive(Default)]
pub struct Sidecar {
    child: Arc<Mutex<Option<Child>>>,
    /// Lines for the sidecar's stdin; a writer thread owns the pipe so a full pipe never blocks a command.
    input: Mutex<Option<Sender<String>>>,
    generation: Arc<AtomicU64>,
    stderr_tail: Arc<Mutex<String>>,
    job: Arc<Mutex<Option<job::Job>>>,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    code: Option<i32>,
    stderr: String,
}

mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Job object with KILL_ON_JOB_CLOSE: when FORGE ends in any way (even a crash), Windows
    /// ends every process in it, including grandchildren like `pnpm dev` or Claude.
    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object handle; it may be used and closed from any thread.
    unsafe impl Send for Job {}

    impl Job {
        pub fn for_child(child: &Child) -> Result<Job, String> {
            // SAFETY: plain Win32 calls with valid arguments; the handle is owned by Job and closed in Drop.
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let job = Job(handle);
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                if AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                Ok(job)
            }
        }

        pub fn terminate(&self) {
            // SAFETY: the handle is valid until Drop.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: closing the handle we own exactly once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Directory with the bundled tools (node, git, gh, sidecar). In dev builds the
/// prepared folder next to Cargo.toml is used when it exists.
pub fn runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime");
        if dev.exists() {
            return Some(dev);
        }
    }
    let res = app.path().resource_dir().ok()?.join("runtime");
    res.exists().then(|| strip_verbatim(res))
}

/// Development override only: a release build always runs the shipped node and sidecar.
fn dev_override(var: &str) -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(var).map(PathBuf::from)
}

fn node_binary(runtime: Option<&PathBuf>) -> PathBuf {
    if let Some(p) = dev_override("FORGE_NODE") {
        return p;
    }
    match runtime.map(|r| r.join("node").join("node.exe")) {
        Some(p) if p.exists() => p,
        _ => PathBuf::from("node"),
    }
}

fn sidecar_script(runtime: Option<&PathBuf>) -> Result<PathBuf, String> {
    if let Some(p) = dev_override("FORGE_SIDECAR") {
        return Ok(p);
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/sidecar/dist/sidecar.mjs");
        if dev.exists() {
            return Ok(dev);
        }
    }
    match runtime.map(|r| r.join("sidecar").join("sidecar.mjs")) {
        Some(p) if p.exists() => Ok(p),
        _ => Err("Sidecar nicht gefunden. Die Installation ist unvollständig.".into()),
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

/// Waits up to `grace` for the process to exit, then kills it.
fn wait_or_kill(child: &mut Child, grace: Duration) -> Option<ExitStatus> {
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    child.wait().ok()
}

impl Sidecar {
    pub fn start(&self, app: &AppHandle) -> Result<(), String> {
        let runtime = runtime_dir(app);
        let script = sidecar_script(runtime.as_ref())?;
        let mut cmd = Command::new(node_binary(runtime.as_ref()));
        if let Some(r) = &runtime {
            cmd.env("FORGE_RUNTIME_DIR", r);
        }
        cmd.arg("--no-warnings")
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(dir) = script.parent() {
            cmd.current_dir(dir);
        }
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| {
            let msg = format!("Node.js konnte nicht gestartet werden ({e}).");
            let _ = app.emit("sidecar://exit", ExitPayload { code: None, stderr: msg.clone() });
            msg
        })?;
        let job = job::Job::for_child(&child).map_err(|e| eprintln!("[forge] job object failed: {e}")).ok();

        let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let stdout = child.stdout.take().ok_or("kein stdout")?;
        let stderr = child.stderr.take().ok_or("kein stderr")?;
        let mut stdin = child.stdin.take().ok_or("kein stdin")?;
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            for line in rx {
                let sent = stdin.write_all(line.as_bytes()).and_then(|_| stdin.write_all(b"\n")).and_then(|_| stdin.flush());
                if sent.is_err() {
                    break;
                }
            }
            // Dropping stdin here tells the sidecar that FORGE is going away.
        });
        *self.input.lock().unwrap() = Some(tx);
        *self.child.lock().unwrap() = Some(child);
        *self.job.lock().unwrap() = job;
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
        let job_ref = self.job.clone();
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
            // Taken out first: waiting while holding the lock would block is_running() and shutdown().
            let child = child_ref.lock().unwrap().take();
            let code = child.and_then(|mut c| wait_or_kill(&mut c, SHUTDOWN_GRACE)).and_then(|s| s.code());
            // A crashed sidecar cannot stop its Claude processes and dev servers any more.
            if let Some(j) = job_ref.lock().unwrap().take() {
                j.terminate();
            }
            let stderr = tail_ref.lock().unwrap().clone();
            let _ = app_out.emit("sidecar://exit", ExitPayload { code, stderr });
        });
        Ok(())
    }

    /// Queues one protocol line; never blocks on the pipe.
    pub fn send(&self, line: &str) -> Result<(), String> {
        let guard = self.input.lock().unwrap();
        let tx = guard.as_ref().ok_or("Hintergrunddienst läuft nicht")?;
        tx.send(line.to_owned()).map_err(|_| "Hintergrunddienst läuft nicht".to_string())
    }

    pub fn is_running(&self) -> bool {
        match self.child.lock().unwrap().as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Closes stdin so the sidecar can stop its Claude processes, kills it after a grace period
    /// and then ends everything it left behind.
    pub fn shutdown(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        drop(self.input.lock().unwrap().take());
        let child = self.child.lock().unwrap().take();
        let job = self.job.lock().unwrap().take();
        if let Some(mut c) = child {
            wait_or_kill(&mut c, SHUTDOWN_GRACE);
        }
        if let Some(j) = job {
            j.terminate();
        }
    }
}
