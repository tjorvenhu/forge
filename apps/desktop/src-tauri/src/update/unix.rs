//! Updates on macOS (app bundle) and Linux (AppImage). The parts without system calls (names, paths,
//! the checks of the unpacked bundle) are tested on every platform.

// macOS uses one half, Linux the other; the tests cover both everywhere.
#![allow(dead_code)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::i18n::tr;

const SCRIPT_NAME: &str = "apply-update.sh";
/// Next to the staged files, as on Windows.
const LOG_NAME: &str = "apply-update.log";
/// Top-level folder in the macOS update archive.
const BUNDLE: &str = "FORGE.app";

/// The `.app` around the running executable (`FORGE.app/Contents/MacOS/forge-desktop`); None
/// outside a bundle, like a dev build.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    let inside = macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && app.extension()? == "app";
    inside.then(|| app.to_path_buf())
}

/// The AppImage FORGE runs from; its runtime sets APPIMAGE. None for a .deb installation.
pub fn appimage() -> Option<PathBuf> {
    let p = PathBuf::from(std::env::var_os("APPIMAGE")?);
    (p.is_absolute() && p.is_file()).then_some(p)
}

/// A complete bundle as the release build makes it. A link instead of a folder could point anywhere.
fn check_bundle(app: &Path) -> Result<(), String> {
    let real_dir = std::fs::symlink_metadata(app).is_ok_and(|m| m.is_dir());
    let contents = app.join("Contents");
    if !real_dir || !contents.join("MacOS").join("forge-desktop").is_file() || !contents.join("Info.plist").is_file() {
        return Err(tr!("The update contains no complete FORGE.app.", "Im Update fehlt eine vollständige FORGE.app."));
    }
    Ok(())
}

/// Gatekeeper runs a quarantined app that was never moved from a read-only random copy
/// (App Translocation); that copy cannot be replaced.
fn check_bundle_location(app: &Path) -> Result<(), String> {
    if app.to_string_lossy().contains("/AppTranslocation/") {
        return Err(tr!(
            "Move FORGE to the Applications folder first, then start it again and update.",
            "Verschiebe FORGE zuerst in den Ordner Programme, starte es neu und aktualisiere dann."
        ));
    }
    Ok(())
}

/// Arguments of both scripts: FORGE's process id, what comes in, what is replaced, the log.
fn script_args(pid: u32, src: &Path, dst: &Path, log: &Path) -> Vec<OsString> {
    vec![pid.to_string().into(), src.into(), dst.into(), log.into()]
}

#[cfg(unix)]
fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return false };
    // SAFETY: a valid C string for the duration of the call.
    unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(unix)]
fn check_writable(target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| tr!("Install folder unknown", "Installationsordner unbekannt"))?;
    if !writable(parent) {
        return Err(tr!(
            "FORGE cannot replace itself in {}. Move it to a folder you can write to.",
            "FORGE kann sich in {} nicht selbst ersetzen. Verschiebe es in einen Ordner mit Schreibrecht.",
            parent.display()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn write_script(dir: &Path, text: &str) -> Result<PathBuf, String> {
    let script = dir.join(SCRIPT_NAME);
    std::fs::write(&script, text).map_err(|e| e.to_string())?;
    Ok(script)
}

/// `*.app.tar.gz` with `FORGE.app` at the top, unpacked next to the download.
#[cfg(target_os = "macos")]
pub fn prepare(dir: &Path, file: PathBuf, name: &str) -> Result<super::Plan, String> {
    use std::process::Command;

    if !name.ends_with(".app.tar.gz") {
        return Err(tr!("Invalid update", "Ungültiges Update"));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let target = bundle_of(&exe).ok_or_else(|| tr!("Updates only work in the installed app.", "Updates gehen nur in der installierten App."))?;
    check_bundle_location(&target)?;
    check_writable(&target)?;

    let staged = dir.join("staged");
    let _ = std::fs::remove_dir_all(&staged);
    std::fs::create_dir_all(&staged).map_err(|e| e.to_string())?;
    let out = Command::new("/usr/bin/tar")
        .arg("-xzf")
        .arg(&file)
        .arg("-C")
        .arg(&staged)
        .output()
        .map_err(|e| tr!("Could not unpack the update: {e}", "Update lässt sich nicht entpacken: {e}"))?;
    if !out.status.success() {
        return Err(tr!("Could not unpack the update: {}", "Update lässt sich nicht entpacken: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    check_bundle(&staged.join(BUNDLE))?;
    let script = write_script(dir, MAC_SCRIPT)?;
    Ok(super::Plan::Swap { script, args: script_args(std::process::id(), &staged, &target, &dir.join(LOG_NAME)) })
}

/// `*.AppImage`, only when FORGE runs from an AppImage; a package installation updates through its
/// package manager.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn prepare(dir: &Path, file: PathBuf, name: &str) -> Result<super::Plan, String> {
    if !name.ends_with(".appimage") {
        return Err(tr!("Invalid update", "Ungültiges Update"));
    }
    let target = appimage().ok_or_else(|| {
        tr!(
            "FORGE only updates itself as an AppImage. Install the new version through your package manager.",
            "FORGE aktualisiert sich nur als AppImage selbst. Installiere die neue Version über deine Paketverwaltung."
        )
    })?;
    check_writable(&target)?;
    let script = write_script(dir, LINUX_SCRIPT)?;
    Ok(super::Plan::Swap { script, args: script_args(std::process::id(), &file, &target, &dir.join(LOG_NAME)) })
}

#[cfg(unix)]
pub fn launch(plan: super::Plan) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let super::Plan::Swap { script, args } = plan;
    let mut cmd = Command::new("/bin/sh");
    cmd.arg(&script).args(&args).current_dir("/").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // Set by the AppImage runtime for its mount, which is gone once FORGE has exited; the new
    // AppImage sets its own.
    for var in ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] {
        cmd.env_remove(var);
    }
    // A session of its own: the script outlives FORGE and no signal for FORGE's group reaches it.
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().map_err(|e| tr!("Update does not start: {e}", "Update startet nicht: {e}"))?;
    Ok(())
}

/// `sh apply-update.sh <pid> <staged dir with FORGE.app> <target .app> <log>`. The old bundle is kept
/// as `.forge-old` until the new one is in place; on failure it goes back. FORGE starts again in
/// every case.
const MAC_SCRIPT: &str = r#"pid="$1"; staged="$2"; dst="$3"; log="$4"
src="$staged/FORGE.app"
old="$dst.forge-old"
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
sleep 0.3
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Update nach $dst" > "$log"
ok=0
if [ -d "$src" ] && [ -d "$dst" ]; then
  rm -rf "$old"
  if mv "$dst" "$old" 2>>"$log"; then
    if mv "$src" "$dst" 2>>"$log"; then
      ok=1
    else
      echo "Fehler: neue App nicht eingesetzt, alte zurück" >> "$log"
      mv "$old" "$dst" 2>>"$log"
    fi
  else
    echo "Fehler: alte App nicht verschoben" >> "$log"
  fi
else
  echo "Fehler: $src oder $dst fehlt" >> "$log"
fi
if [ "$ok" = 1 ]; then
  /usr/bin/xattr -dr com.apple.quarantine "$dst" 2>/dev/null
  rm -rf "$old"
  echo "fertig" >> "$log"
fi
rm -rf "$staged"
/usr/bin/open -n "$dst"
"#;

/// `sh apply-update.sh <pid> <new AppImage> <target AppImage> <log>`. The new file is copied next
/// to the target and renamed over it, so the target is always complete; the old one stays as
/// `.forge-old` until then. FORGE starts again in every case.
const LINUX_SCRIPT: &str = r#"pid="$1"; new="$2"; dst="$3"; log="$4"
tmp="$dst.forge-new"
old="$dst.forge-old"
i=0
while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i + 1)); done
sleep 0.3
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) Update nach $dst" > "$log"
ok=0
rm -f "$tmp" "$old"
if cp -f "$new" "$tmp" 2>>"$log" && chmod 755 "$tmp" 2>>"$log"; then
  ln -f "$dst" "$old" 2>/dev/null || cp -pf "$dst" "$old" 2>>"$log"
  if mv -f "$tmp" "$dst" 2>>"$log"; then
    ok=1
  else
    echo "Fehler: neue AppImage nicht eingesetzt" >> "$log"
  fi
else
  echo "Fehler: neue AppImage nicht kopiert" >> "$log"
fi
rm -f "$tmp"
if [ "$ok" = 1 ]; then
  rm -f "$old"
  echo "fertig" >> "$log"
elif [ ! -e "$dst" ] && [ -e "$old" ]; then
  mv -f "$old" "$dst" 2>>"$log"
else
  rm -f "$old"
fi
cd "$HOME" 2>/dev/null || cd /
nohup "$dst" >/dev/null 2>&1 &
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-update-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_the_bundle_around_the_executable() {
        let exe = Path::new("/Applications/FORGE.app/Contents/MacOS/forge-desktop");
        assert_eq!(bundle_of(exe), Some(PathBuf::from("/Applications/FORGE.app")));
        assert_eq!(bundle_of(Path::new("/Users/a/My Apps/FORGE 2.app/Contents/MacOS/forge-desktop")), Some(PathBuf::from("/Users/a/My Apps/FORGE 2.app")));
        // cargo run / tauri dev
        assert_eq!(bundle_of(Path::new("/Users/a/forge/target/debug/forge-desktop")), None);
        assert_eq!(bundle_of(Path::new("/Applications/FORGE/Contents/MacOS/forge-desktop")), None);
        assert_eq!(bundle_of(Path::new("forge-desktop")), None);
    }

    #[test]
    fn refuses_a_translocated_bundle() {
        assert!(check_bundle_location(Path::new("/private/var/folders/x/T/AppTranslocation/1234/d/FORGE.app")).is_err());
        assert!(check_bundle_location(Path::new("/Applications/FORGE.app")).is_ok());
    }

    #[test]
    fn checks_the_unpacked_bundle() {
        let dir = temp("bundle");
        let app = dir.join(BUNDLE);
        assert!(check_bundle(&app).is_err());
        std::fs::create_dir_all(app.join("Contents").join("MacOS")).unwrap();
        std::fs::write(app.join("Contents").join("MacOS").join("forge-desktop"), "").unwrap();
        assert!(check_bundle(&app).is_err());
        std::fs::write(app.join("Contents").join("Info.plist"), "").unwrap();
        assert!(check_bundle(&app).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scripts_get_pid_source_target_and_log() {
        let args = script_args(42, Path::new("/tmp/forge-update/staged"), Path::new("/Applications/FORGE.app"), Path::new("/tmp/forge-update/apply-update.log"));
        let args: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["42", "/tmp/forge-update/staged", "/Applications/FORGE.app", "/tmp/forge-update/apply-update.log"]);
        for script in [MAC_SCRIPT, LINUX_SCRIPT] {
            assert!(script.starts_with(r#"pid="$1"; "#) && script.contains(r#"dst="$3"; log="$4""#));
            assert!(!script.contains('\r'));
        }
        assert!(MAC_SCRIPT.contains("/usr/bin/open -n \"$dst\""));
        assert!(LINUX_SCRIPT.contains("nohup \"$dst\""));
    }

    /// A process id that is surely gone.
    #[cfg(unix)]
    fn ended_pid() -> u32 {
        let mut c = std::process::Command::new("/bin/sh").args(["-c", "true"]).spawn().unwrap();
        let pid = c.id();
        c.wait().unwrap();
        pid
    }

    #[cfg(unix)]
    fn run(script: &str, dir: &Path, src: &Path, dst: &Path) -> String {
        let file = dir.join(SCRIPT_NAME);
        std::fs::write(&file, script).unwrap();
        let log = dir.join(LOG_NAME);
        let status = std::process::Command::new("/bin/sh").arg(&file).args(script_args(ended_pid(), src, dst, &log)).status().unwrap();
        assert!(status.success());
        std::fs::read_to_string(&log).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn mac_script_swaps_the_bundle() {
        let dir = temp("mac");
        let staged = dir.join("staged");
        let dst = dir.join("Apps").join("FORGE.app");
        for (app, v) in [(staged.join(BUNDLE), "new"), (dst.clone(), "old")] {
            std::fs::create_dir_all(app.join("Contents")).unwrap();
            std::fs::write(app.join("Contents").join("Info.plist"), v).unwrap();
        }
        // The relaunch would really start the app.
        let script = MAC_SCRIPT.replace("/usr/bin/open -n", "true");
        let log = run(&script, &dir, &staged, &dst);
        assert!(log.ends_with("fertig\n"), "{log}");
        assert_eq!(std::fs::read_to_string(dst.join("Contents").join("Info.plist")).unwrap(), "new");
        assert!(!dir.join("Apps").join("FORGE.app.forge-old").exists());
        assert!(!staged.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn mac_script_keeps_the_old_bundle_without_a_new_one() {
        let dir = temp("mac-missing");
        let dst = dir.join("FORGE.app");
        std::fs::create_dir_all(dst.join("Contents")).unwrap();
        let script = MAC_SCRIPT.replace("/usr/bin/open -n", "true");
        let log = run(&script, &dir, &dir.join("staged"), &dst);
        assert!(log.contains("Fehler"), "{log}");
        assert!(dst.join("Contents").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn linux_script_replaces_the_appimage_and_starts_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("linux");
        let dst = dir.join("FORGE.AppImage");
        let new = dir.join("download.AppImage");
        let started = dir.join("started");
        std::fs::write(&dst, "#!/bin/sh\nexit 1\n").unwrap();
        std::fs::write(&new, format!("#!/bin/sh\ntouch '{}'\n", started.display())).unwrap();
        let log = run(LINUX_SCRIPT, &dir, &new, &dst);
        assert!(log.ends_with("fertig\n"), "{log}");
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), std::fs::read_to_string(&new).unwrap());
        assert_eq!(std::fs::metadata(&dst).unwrap().permissions().mode() & 0o777, 0o755);
        assert!(!dir.join("FORGE.AppImage.forge-old").exists());
        assert!(!dir.join("FORGE.AppImage.forge-new").exists());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !started.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(started.exists(), "the new AppImage was not started");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
