//! Ends a process together with everything it started (`pnpm dev`, Claude, test runners).
//!
//! Windows: job objects with KILL_ON_JOB_CLOSE: every process in the job, including everything it
//! starts later, ends when the job is terminated or closed, even if FORGE crashes.
//!
//! macOS and Linux: the process leads its own process group (see `own_group`; the shells of the
//! terminals lead their own session). Terminating sends SIGTERM to the group, SIGKILL to what is
//! left after a short grace. Dropping the job terminates too, like closing the job handle.

#[cfg(windows)]
pub use win::Job;

#[cfg(unix)]
pub use unix::{own_group, Job};

#[cfg(windows)]
mod win {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub struct Job(HANDLE);

    // SAFETY: a job handle is a kernel object handle; the job APIs may be called on it from any thread,
    // and it is closed exactly once in Drop.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        fn new() -> Result<Job, String> {
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
                Ok(job)
            }
        }

        fn assign(&self, process: HANDLE) -> Result<(), String> {
            // SAFETY: both handles are valid for the duration of the call.
            if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(())
        }

        pub fn for_child(child: &Child) -> Result<Job, String> {
            let job = Job::new()?;
            job.assign(child.as_raw_handle() as HANDLE)?;
            Ok(job)
        }

        /// For processes FORGE only knows by id, like the shell a pseudoconsole started.
        pub fn for_pid(pid: u32) -> Result<Job, String> {
            let job = Job::new()?;
            // SAFETY: the process handle is checked and closed right after use.
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let assigned = job.assign(process);
                CloseHandle(process);
                assigned?;
            }
            Ok(job)
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

#[cfg(unix)]
mod unix {
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    use libc::pid_t;

    /// How long the processes get for SIGTERM before SIGKILL.
    const GRACE: Duration = Duration::from_secs(2);

    pub struct Job {
        pgid: pid_t,
        /// The leader started its own session (the shell of a terminal). An interactive shell moves
        /// every command line into a process group of its own, so the whole session is ended.
        session: bool,
        ended: AtomicBool,
    }

    /// Starts the command as the leader of a new process group, so `Job::for_child` can end it with
    /// everything it starts. On Linux, `die_with_forge` also ends it when FORGE dies without cleaning
    /// up (macOS has no such signal; the sidecar ends when its stdin closes).
    pub fn own_group(cmd: &mut Command, die_with_forge: bool) {
        cmd.process_group(0);
        #[cfg(target_os = "linux")]
        if die_with_forge && on_main_thread() {
            let parent = unsafe { libc::getpid() };
            // SAFETY: only async-signal-safe calls between fork and exec.
            unsafe {
                cmd.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    // FORGE died before the signal was armed.
                    if libc::getppid() != parent {
                        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = die_with_forge;
    }

    /// PR_SET_PDEATHSIG fires when the forking thread ends, not the process. A restart of the sidecar
    /// runs on a pool thread that may end long before FORGE, so the signal is only armed from the
    /// main thread.
    #[cfg(target_os = "linux")]
    fn on_main_thread() -> bool {
        // SAFETY: plain syscalls without arguments.
        unsafe { libc::syscall(libc::SYS_gettid) as pid_t == libc::getpid() }
    }

    impl Job {
        fn leader(pid: u32) -> Result<Job, String> {
            let pid = pid_t::try_from(pid).map_err(|e| e.to_string())?;
            if pid <= 0 {
                return Err("invalid process id".into());
            }
            // SAFETY: plain syscalls on a process id.
            let (pgid, own, sid) = unsafe { (libc::getpgid(pid), libc::getpgrp(), libc::getsid(pid)) };
            if pgid < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            // Signals go to the whole group: never to FORGE's own or a foreign one.
            if pgid != pid || pgid == own {
                return Err(format!("process {pid} does not lead its own process group"));
            }
            Ok(Job { pgid, session: sid == pid, ended: AtomicBool::new(false) })
        }

        /// The child must have been started with `own_group`.
        pub fn for_child(child: &Child) -> Result<Job, String> {
            Job::leader(child.id())
        }

        /// For processes FORGE only knows by id, like the shell of a pseudo terminal (a session leader).
        pub fn for_pid(pid: u32) -> Result<Job, String> {
            Job::leader(pid)
        }

        pub fn terminate(&self) {
            if self.ended.swap(true, Ordering::SeqCst) {
                return;
            }
            let (pgid, session) = (self.pgid, self.session);
            signal(pgid, session, libc::SIGTERM);
            // Off the calling thread: terminals are closed from the main thread, and an interactive
            // shell ignores SIGTERM, so this mostly waits the full grace.
            thread::spawn(move || {
                let deadline = Instant::now() + GRACE;
                while Instant::now() < deadline && alive(pgid, session) {
                    thread::sleep(Duration::from_millis(50));
                }
                if alive(pgid, session) {
                    signal(pgid, session, libc::SIGKILL);
                }
            });
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    fn signal(pgid: pid_t, session: bool, sig: libc::c_int) {
        // SAFETY: kill and killpg take plain ids; pgid is never FORGE's own group (checked in leader).
        unsafe {
            libc::killpg(pgid, sig);
            if session {
                for pid in session_members(pgid) {
                    libc::kill(pid, sig);
                }
            }
        }
    }

    fn alive(pgid: pid_t, session: bool) -> bool {
        // SAFETY: signal 0 only checks whether the processes exist.
        let group = unsafe { libc::killpg(pgid, 0) } == 0;
        group || (session && !session_members(pgid).is_empty())
    }

    fn session_members(sid: pid_t) -> Vec<pid_t> {
        // SAFETY: getsid only reads.
        let me = unsafe { libc::getpid() };
        all_pids().into_iter().filter(|&p| p > 0 && p != me && unsafe { libc::getsid(p) } == sid).collect()
    }

    #[cfg(target_os = "linux")]
    fn all_pids() -> Vec<pid_t> {
        std::fs::read_dir("/proc")
            .map(|dir| dir.flatten().filter_map(|e| e.file_name().to_str()?.parse().ok()).collect())
            .unwrap_or_default()
    }

    #[cfg(target_os = "macos")]
    fn all_pids() -> Vec<pid_t> {
        // SAFETY: the buffer is sized from the first call; the second fills at most that many entries.
        unsafe {
            let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
            if n <= 0 {
                return Vec::new();
            }
            let mut pids: Vec<pid_t> = vec![0; n as usize + 64];
            let bytes = (pids.len() * std::mem::size_of::<pid_t>()) as libc::c_int;
            let got = libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes);
            pids.truncate(got.max(0) as usize);
            pids
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn all_pids() -> Vec<pid_t> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::Job;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[cfg(windows)]
    fn parent_with_child() -> Command {
        // cmd starts ping as its own child, and ping writes into the same pipe.
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "ping -n 30 127.0.0.1"]);
        cmd
    }

    #[cfg(unix)]
    fn parent_with_child() -> Command {
        // sh starts sleep as its own child (the trailing command keeps sh from exec'ing it).
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "sleep 30; true"]);
        super::own_group(&mut cmd, false);
        cmd
    }

    #[test]
    fn terminate_ends_the_process_and_what_it_started() {
        // Reading to the end only returns once both have exited; without the job, the child would keep
        // the pipe open for 30 seconds.
        let mut child = parent_with_child().stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("parent starts");
        let job = Job::for_pid(child.id()).expect("job created");
        std::thread::sleep(Duration::from_millis(500));
        let started = Instant::now();
        job.terminate();
        let mut out = Vec::new();
        child.stdout.take().expect("piped").read_to_end(&mut out).expect("pipe closes");
        child.wait().expect("parent ends");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn unknown_process_ids_are_reported() {
        assert!(Job::for_pid(0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn foreign_process_groups_are_refused() {
        // Without own_group the child shares the test's group; signalling it would hit the test itself.
        let mut child = Command::new("/bin/sh").args(["-c", "sleep 5"]).spawn().expect("sh starts");
        assert!(Job::for_child(&child).is_err());
        let _ = child.kill();
        let _ = child.wait();
    }
}
