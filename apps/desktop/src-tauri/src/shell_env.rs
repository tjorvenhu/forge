//! macOS and Linux start an app from Finder, the Dock or a desktop launcher with a minimal PATH
//! (launchd: `/usr/bin:/bin:/usr/sbin:/sbin`): no Homebrew, no `~/.local/bin` where Claude Code
//! installs itself. At start FORGE takes the PATH of the user's login shell, so the sidecar, Claude
//! and the terminals find the same tools as in a terminal window.

// The parsing is plain string work and tested on every platform; only `apply` runs on unix.
#![cfg_attr(windows, allow(dead_code))]

use std::path::{Path, PathBuf};

const MARKER: &str = "__FORGE_ENV__";

/// Printed by the login shell. `env` instead of `$PATH`: fish joins its PATH list with spaces, the
/// exported variable is always colon separated. The marker skips whatever the profile prints.
const PROBE: &str = "echo; echo __FORGE_ENV__; /usr/bin/env";

/// The user's shell for the terminals and the PATH probe.
pub fn user_shell() -> String {
    let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" };
    std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
        .or_else(|| Path::new(fallback).is_file().then(|| fallback.to_owned()))
        .unwrap_or_else(|| "/bin/sh".into())
}

/// Runs once at the very start, before any thread: setting variables races with readers otherwise.
#[cfg(unix)]
pub fn apply() {
    let probe = login_shell_env(&user_shell());
    let current = std::env::var("PATH").ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let extras: Vec<PathBuf> = extra_dirs(home.as_deref()).into_iter().filter(|d| d.is_dir()).collect();
    let shell_path = probe.as_deref().and_then(|out| shell_var(out, "PATH"));
    let merged = merge(shell_path.as_deref(), current.as_deref(), &extras);
    if !merged.is_empty() && current.as_deref() != Some(merged.as_str()) {
        std::env::set_var("PATH", merged);
    }
    // Without a locale, a terminal shows every character outside ASCII as an escape and Python writes
    // ASCII. Terminal.app sets LANG the same way.
    let locale_set = ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|v| std::env::var_os(v).is_some_and(|s| !s.is_empty()));
    if !locale_set {
        let lang = probe.as_deref().and_then(|out| shell_var(out, "LANG")).filter(|l| !l.is_empty());
        if let Some(lang) = lang.or_else(|| cfg!(target_os = "macos").then(|| "en_US.UTF-8".to_owned())) {
            std::env::set_var("LANG", lang);
        }
    }
}

/// Output of `PROBE` in an interactive login shell, or None after a few seconds (a profile that
/// waits for input, a broken shell).
#[cfg(unix)]
fn login_shell_env(shell: &str) -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    let mut cmd = Command::new(shell);
    cmd.args(["-i", "-l", "-c", PROBE]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // A session without a terminal: an interactive shell started from a terminal (dev) would
    // otherwise take it over or stop on SIGTTOU. The new session also lets the timeout end it all.
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    let out = rx.recv_timeout(Duration::from_secs(3));
    if out.is_err() {
        // SAFETY: the child leads its own session and group (setsid above).
        unsafe {
            libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
        }
    }
    let _ = child.wait();
    out.ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// A variable from the `env` listing after the last marker line.
fn shell_var(output: &str, name: &str) -> Option<String> {
    let (_, listing) = output.rsplit_once(&format!("\n{MARKER}\n"))?;
    let prefix = format!("{name}=");
    listing.lines().find_map(|l| l.strip_prefix(&prefix)).map(str::to_owned)
}

/// Folders where Claude Code and Homebrew put their programs, also when no profile adds them.
fn extra_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = home {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

/// The login shell's order first, then what FORGE was started with, then the extra folders; each
/// entry once.
fn merge(shell: Option<&str>, current: Option<&str>, extras: &[PathBuf]) -> String {
    let mut seen: Vec<String> = Vec::new();
    let listed = [shell, current].into_iter().flatten().flat_map(|p| p.split(':')).map(str::to_owned);
    let extra = extras.iter().map(|p| p.to_string_lossy().into_owned());
    for entry in listed.chain(extra) {
        let trimmed = entry.trim_end_matches('/');
        let entry = if trimmed.is_empty() { entry.as_str() } else { trimmed };
        if !entry.is_empty() && !seen.iter().any(|s| s == entry) {
            seen.push(entry.to_owned());
        }
    }
    seen.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_variables_after_the_marker() {
        let out = "Welcome!\nPATH=/fake\n\n__FORGE_ENV__\nHOME=/Users/a\nPATH=/opt/homebrew/bin:/usr/bin:/bin\nLANG=de_DE.UTF-8\nXPATH=/x\n";
        assert_eq!(shell_var(out, "PATH").as_deref(), Some("/opt/homebrew/bin:/usr/bin:/bin"));
        assert_eq!(shell_var(out, "LANG").as_deref(), Some("de_DE.UTF-8"));
        assert_eq!(shell_var(out, "TERM"), None);
        assert_eq!(shell_var("PATH=/usr/bin\n", "PATH"), None);
    }

    #[test]
    fn merge_keeps_the_shell_order_and_drops_duplicates() {
        let extras = [PathBuf::from("/Users/a/.local/bin"), PathBuf::from("/usr/local/bin")];
        let merged = merge(Some("/opt/homebrew/bin:/usr/bin:/bin:/usr/bin/"), Some("/usr/bin:/bin:/usr/sbin:/sbin"), &extras);
        assert_eq!(merged, "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/a/.local/bin:/usr/local/bin");
        assert_eq!(merge(None, Some("/usr/bin::/bin"), &[]), "/usr/bin:/bin");
        assert_eq!(merge(None, None, &[]), "");
    }

    #[test]
    fn extra_dirs_include_claude_and_homebrew() {
        let dirs = extra_dirs(Some(Path::new("/home/a")));
        assert_eq!(dirs[0], Path::new("/home/a").join(".local").join("bin"));
        assert_eq!(dirs[1], Path::new("/home/a").join(".claude").join("local"));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert_eq!(extra_dirs(None).len(), 2);
    }
}
