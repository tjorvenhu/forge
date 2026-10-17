//! Installs a downloaded FORGE update. Two kinds, both only from the update folder of the sidecar:
//!
//! - `*-setup.exe`: the full NSIS installer (with node, git and gh). Run with `/P /UPDATE /R /D=<folder>`:
//!   without questions, into the folder FORGE runs from, and FORGE starts again afterwards.
//! - `*_update_<runtime>.zip`: only `forge-desktop.exe` and the sidecar, a few MB. The bundled
//!   runtime stays; the sidecar only offers it when the installed runtime has the same key. A
//!   small PowerShell script swaps the files once FORGE has exited (a running exe cannot be
//!   overwritten), rolls back on failure and starts FORGE again.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// Runtime key (node, git, gh …) the release build was made for, from scripts/prepare-runtime.mjs via
/// release.yml. The sidecar compares it with the installed runtime (FullInstallService).
pub fn expected_runtime() -> Option<&'static str> {
    option_env!("FORGE_RUNTIME_KEY").map(str::trim).filter(|k| !k.is_empty())
}

/// What a release build misses in its runtime folder, for the start screen when the sidecar cannot
/// run at all. The sidecar checks the versions too (packages/sidecar/src/update/full-install.ts).
pub fn runtime_gaps(runtime: Option<&Path>) -> Vec<&'static str> {
    const PARTS: [(&str, &str); 6] = [
        ("node/node.exe", "Node.js"),
        ("git/cmd/git.exe", "Git"),
        ("gh/bin/gh.exe", "GitHub CLI"),
        ("python/python.exe", "Python"),
        ("sidecar/sidecar.mjs", "Hintergrunddienst"),
        ("VERSIONS.json", "Versionsliste"),
    ];
    match runtime {
        None => PARTS.iter().map(|(_, label)| *label).collect(),
        Some(dir) => PARTS.iter().filter(|(rel, _)| !dir.join(rel).exists()).map(|(_, label)| *label).collect(),
    }
}

/// Arguments for Tauri's NSIS installer. `/D=` must come last and unquoted, even with spaces:
/// NSIS takes the rest of the command line as the folder.
fn installer_args(install_dir: Option<&Path>) -> (Vec<&'static str>, Option<String>) {
    let dir = install_dir.map(|d| d.to_string_lossy().into_owned()).filter(|d| !d.is_empty() && !d.contains('"'));
    (vec!["/P", "/UPDATE", "/R"], dir.map(|d| format!("/D={d}")))
}

/// The files a small update may contain, relative to the installation folder.
const PATCH_FILES: [&str; 3] = ["forge-desktop.exe", "runtime/sidecar/sidecar.mjs", "update.json"];

pub enum Plan {
    Installer { file: PathBuf, install_dir: Option<PathBuf> },
    Patch { staged: PathBuf, script: PathBuf, install_dir: PathBuf, version: String },
}

/// Checks the downloaded file and gets it ready; nothing is changed in the installation yet.
pub fn prepare(path: &str) -> Result<Plan, String> {
    let dir = std::env::temp_dir().join("forge-update");
    let file = PathBuf::from(path).canonicalize().map_err(|_| "Update nicht gefunden".to_string())?;
    let allowed = dir.canonicalize().map_err(|_| "Kein Update heruntergeladen".to_string())?;
    if !file.starts_with(&allowed) {
        return Err("Ungültiges Update".into());
    }
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_ascii_lowercase();
    if name.ends_with("-setup.exe") {
        // A development build is no installation: there the installer keeps its own folder.
        let install_dir = if cfg!(debug_assertions) { None } else { std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) };
        return Ok(Plan::Installer { file, install_dir });
    }
    if !(name.ends_with(".zip") && name.contains("_update_")) {
        return Err("Ungültiges Update".into());
    }

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let install_dir = exe.parent().ok_or("Installationsordner unbekannt")?.to_path_buf();
    if !install_dir.join("runtime").join("VERSIONS.json").exists() {
        return Err("Kleine Updates gehen nur in der installierten App.".into());
    }

    let staged = dir.join("staged");
    let _ = std::fs::remove_dir_all(&staged);
    std::fs::create_dir_all(&staged).map_err(|e| e.to_string())?;
    let tar = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join("System32").join("tar.exe");
    let out = Command::new(tar)
        .arg("-xf")
        .arg(&file)
        .arg("-C")
        .arg(&staged)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Update lässt sich nicht entpacken: {e}"))?;
    if !out.status.success() {
        return Err(format!("Update lässt sich nicht entpacken: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    check_contents(&staged)?;
    let version = read_version(&staged.join("update.json"))?;

    let script = dir.join("apply-update.ps1");
    // With BOM: Windows PowerShell 5.1 reads a file without it in the ANSI code page.
    let mut text = vec![0xEF, 0xBB, 0xBF];
    text.extend_from_slice(APPLY_SCRIPT.as_bytes());
    std::fs::write(&script, text).map_err(|e| e.to_string())?;
    Ok(Plan::Patch { staged, script, install_dir, version })
}

/// Only the expected files, nothing else: an update must not be able to drop files anywhere.
fn check_contents(staged: &Path) -> Result<(), String> {
    let mut found = Vec::new();
    collect(staged, staged, &mut found)?;
    for rel in &found {
        if !PATCH_FILES.contains(&rel.as_str()) {
            return Err(format!("Unerwartete Datei im Update: {rel}"));
        }
    }
    for needed in ["forge-desktop.exe", "runtime/sidecar/sidecar.mjs", "update.json"] {
        if !found.iter().any(|f| f == needed) {
            return Err(format!("Im Update fehlt {needed}"));
        }
    }
    Ok(())
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out)?;
        } else {
            let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

fn read_version(file: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let v = json.get("version").and_then(|v| v.as_str()).ok_or("update.json ohne Version")?;
    // Goes into the script's arguments and the registry: digits and dots only.
    if v.is_empty() || !v.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err("Ungültige Version im Update".into());
    }
    Ok(v.to_string())
}

/// Starts what was prepared. The caller ends FORGE right after.
pub fn launch(plan: Plan) -> Result<(), String> {
    match plan {
        Plan::Installer { file, install_dir } => {
            // `/P` installs without questions, `/UPDATE` keeps the settings, `/R` starts FORGE again,
            // `/D=` keeps the folder (also one an update zip was unpacked to instead of installing).
            let (args, dir) = installer_args(install_dir.as_deref());
            let mut cmd = Command::new(&file);
            cmd.args(args);
            if let Some(d) = dir {
                cmd.raw_arg(d);
            }
            cmd.spawn().map_err(|e| format!("Installer startet nicht: {e}"))?;
        }
        Plan::Patch { staged, script, install_dir, version } => {
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File"])
                .arg(&script)
                .arg("-WaitPid")
                .arg(std::process::id().to_string())
                .arg("-Src")
                .arg(&staged)
                .arg("-Dst")
                .arg(&install_dir)
                .arg("-Version")
                .arg(&version);
            // Outside a job object FORGE may run in, so it survives FORGE's exit.
            let started = cmd.creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB).spawn();
            if started.is_err() {
                cmd.creation_flags(CREATE_NO_WINDOW).spawn().map_err(|e| format!("Update startet nicht: {e}"))?;
            }
        }
    }
    Ok(())
}

/// Swaps the files after FORGE exited. Old files are kept as `.forge-old` until all new ones are in
/// place; any failure puts the old ones back. FORGE starts again in every case.
const APPLY_SCRIPT: &str = r#"param([int]$WaitPid, [string]$Src, [string]$Dst, [string]$Version)
$ErrorActionPreference = 'Stop'
try { Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 300
$log = Join-Path (Split-Path $Src) 'apply-update.log'
"$(Get-Date -Format o) Update auf $Version" | Out-File $log -Encoding utf8
$moved = @()
$ok = $false
try {
  $files = Get-ChildItem -Path $Src -Recurse -File | Where-Object { $_.Name -ne 'update.json' }
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($Src.Length).TrimStart('\')
    $target = Join-Path $Dst $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    if (Test-Path $target) {
      for ($i = 0; $i -lt 40; $i++) {
        try { Move-Item -Force -LiteralPath $target -Destination "$target.forge-old"; break } catch { Start-Sleep -Milliseconds 250 }
      }
      $moved += $target
    }
    Copy-Item -Force -LiteralPath $f.FullName -Destination $target
    "kopiert $rel" | Out-File $log -Append -Encoding utf8
  }
  $ok = $true
} catch {
  "Fehler: $_" | Out-File $log -Append -Encoding utf8
  foreach ($t in $moved) {
    if (Test-Path "$t.forge-old") { Move-Item -Force -LiteralPath "$t.forge-old" -Destination $t }
  }
}
if ($ok) {
  foreach ($t in $moved) { Remove-Item -Force -LiteralPath "$t.forge-old" -ErrorAction SilentlyContinue }
  try {
    Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      if ($p.DisplayName -eq 'FORGE') { Set-ItemProperty -Path $_.PSPath -Name DisplayVersion -Value $Version }
    }
  } catch {}
  "fertig" | Out-File $log -Append -Encoding utf8
}
Start-Process -FilePath (Join-Path $Dst 'forge-desktop.exe')
Remove-Item -Recurse -Force -LiteralPath $Src -ErrorAction SilentlyContinue
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_keeps_the_folder_unquoted_and_last() {
        let (args, dir) = installer_args(Some(Path::new(r"C:\Users\Max Muster\AppData\Local\FORGE")));
        assert_eq!(args, ["/P", "/UPDATE", "/R"]);
        assert_eq!(dir.as_deref(), Some(r"/D=C:\Users\Max Muster\AppData\Local\FORGE"));
        assert_eq!(installer_args(None).1, None);
        assert_eq!(installer_args(Some(Path::new(r#"C:\a"b"#))).1, None);
    }

    #[test]
    fn names_what_the_runtime_misses() {
        let dir = std::env::temp_dir().join(format!("forge-gaps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sidecar")).unwrap();
        std::fs::write(dir.join("sidecar").join("sidecar.mjs"), "").unwrap();
        // An unpacked update zip: only the sidecar.
        assert_eq!(runtime_gaps(Some(&dir)), ["Node.js", "Git", "GitHub CLI", "Python", "Versionsliste"]);
        for rel in ["node/node.exe", "git/cmd/git.exe", "gh/bin/gh.exe", "python/python.exe", "VERSIONS.json"] {
            let p = dir.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "{}").unwrap();
        }
        assert!(runtime_gaps(Some(&dir)).is_empty());
        assert_eq!(runtime_gaps(None).len(), 6);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
