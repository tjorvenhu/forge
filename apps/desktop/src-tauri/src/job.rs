//! Windows job objects with KILL_ON_JOB_CLOSE: every process in the job, including everything it
//! starts later (`pnpm dev`, Claude, test runners), ends when the job is terminated or closed, even if
//! FORGE crashes.

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

#[cfg(test)]
mod tests {
    use super::Job;
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn terminate_ends_the_process_and_what_it_started() {
        // cmd starts ping as its own child, and ping writes into the same pipe. Reading to the end only
        // returns once both have exited; without the job, ping would keep it open for 30 seconds.
        let mut child = Command::new("cmd")
            .args(["/c", "ping -n 30 127.0.0.1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd starts");
        let job = Job::for_pid(child.id()).expect("job created");
        std::thread::sleep(Duration::from_millis(500));
        let started = Instant::now();
        job.terminate();
        let mut out = Vec::new();
        child.stdout.take().expect("piped").read_to_end(&mut out).expect("pipe closes");
        child.wait().expect("cmd ends");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn unknown_process_ids_are_reported() {
        assert!(Job::for_pid(0).is_err());
    }
}
