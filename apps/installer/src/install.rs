//! Download, check and install: the signed full installer of FORGE runs silently into the chosen
//! folder, a newer small update follows the same way the app applies it (update.rs).

use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::releases::{self, Plan, Signed};
use crate::{log, t, win};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Files a small update may hold (PATCH_FILES in apps/desktop/src-tauri/src/update.rs).
const PATCH_FILES: [&str; 3] = ["forge-desktop.exe", "runtime/sidecar/sidecar.mjs", "update.json"];

// Share of the progress bar per step. The download is the long part on most connections.
const DOWNLOAD_END: f64 = 72.0;
const VERIFY_END: f64 = 76.0;
const INSTALL_END: f64 = 96.0;

pub fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .user_agent(concat!("FORGE-Setup/", env!("CARGO_PKG_VERSION")))
        .build()
}

#[derive(Serialize, Clone)]
struct Progress {
    step: &'static str,
    percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

#[derive(Serialize, Clone)]
struct Done {
    ok: bool,
    message: Option<String>,
}

fn progress(app: &AppHandle, step: &'static str, percent: f64, bytes: Option<(u64, u64)>) {
    let _ = app.emit("setup-progress", Progress { step, percent: percent.clamp(0.0, 100.0), received: bytes.map(|b| b.0), total: bytes.map(|b| b.1) });
}

/// Runs in its own thread; the window hears about it through setup-progress and setup-done.
pub fn run(app: AppHandle, plan: Plan, dir: String) {
    log(&format!("Installation von {} nach {dir}", plan.version));
    let result = steps(&app, &plan, &dir);
    let _ = std::fs::remove_dir_all(work_dir());
    match result {
        Ok(()) => {
            log("fertig");
            progress(&app, "finish", 100.0, None);
            let _ = app.emit("setup-done", Done { ok: true, message: None });
        }
        Err(e) => {
            log(&format!("Fehler: {e}"));
            let _ = app.emit("setup-done", Done { ok: false, message: Some(e) });
        }
    }
}

fn work_dir() -> PathBuf {
    std::env::temp_dir().join("forge-setup")
}

fn steps(app: &AppHandle, plan: &Plan, dir: &str) -> Result<(), String> {
    if dir.contains('"') || !Path::new(dir).is_absolute() {
        return Err(t("Ungültiger Zielordner.", "Invalid target folder."));
    }
    let work = work_dir();
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;

    let total = plan.download_bytes().max(1);
    let mut done = 0u64;
    let mut fetch = |s: &Signed| -> Result<PathBuf, String> {
        let file = work.join(&s.asset.name);
        let base = done;
        download(&s.asset.browser_download_url, &file, |n| {
            let got = base + n;
            progress(app, "download", DOWNLOAD_END * got as f64 / total as f64, Some((got, total)));
        })?;
        done += s.asset.size;
        Ok(file)
    };
    let installer = fetch(&plan.installer)?;
    let patch = plan.patch.as_ref().map(&mut fetch).transpose()?;

    progress(app, "verify", DOWNLOAD_END, None);
    check(&plan.installer, &installer, &work)?;
    if let (Some(s), Some(f)) = (&plan.patch, &patch) {
        check(s, f, &work)?;
    }
    progress(app, "verify", VERIFY_END, None);

    // For trying the setup on a machine whose FORGE must stay as it is: everything but the install.
    if std::env::var_os("FORGE_SETUP_DRY_RUN").is_some() {
        for i in 1..=20 {
            std::thread::sleep(Duration::from_millis(200));
            progress(app, "install", VERIFY_END + (INSTALL_END - VERIFY_END) * f64::from(i) / 20.0, None);
        }
        return Ok(());
    }
    run_installer(app, &installer, dir)?;
    if let Some(zip) = &patch {
        progress(app, "finish", INSTALL_END, None);
        apply_patch(zip, &work.join("patch"), Path::new(dir), &plan.version)?;
    }
    Ok(())
}

fn download(url: &str, file: &Path, mut on: impl FnMut(u64)) -> Result<(), String> {
    let failed = |e: String| format!("{}: {e}", t("Download fehlgeschlagen", "Download failed"));
    let res = agent().get(url).call().map_err(|e| failed(e.to_string()))?;
    let mut reader = res.into_reader();
    let mut out = File::create(file).map_err(|e| failed(e.to_string()))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut got = 0u64;
    let mut last = Instant::now();
    loop {
        let n = reader.read(&mut buf).map_err(|e| failed(e.to_string()))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| failed(e.to_string()))?;
        got += n as u64;
        if last.elapsed() >= Duration::from_millis(80) {
            on(got);
            last = Instant::now();
        }
    }
    on(got);
    Ok(())
}

fn sha256(file: &Path) -> Result<String, String> {
    let mut f = File::open(file).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// SHA-256 as GitHub reports it (when it does) and always the release signature.
fn check(s: &Signed, file: &Path, work: &Path) -> Result<(), String> {
    let hash = sha256(file)?;
    if let Some(d) = s.asset.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        if !d.eq_ignore_ascii_case(&hash) {
            return Err(t("Die heruntergeladene Datei ist beschädigt (Prüfsumme falsch).", "The downloaded file is damaged (wrong checksum)."));
        }
    }
    let sig_file = work.join(format!("{}.sigfile", s.asset.name));
    download(&s.sig.browser_download_url, &sig_file, |_| {})?;
    let content = std::fs::read_to_string(&sig_file).map_err(|e| e.to_string())?;
    let sig = releases::signature_from(&s.sig.name, &content, &s.asset.name).unwrap_or_default();
    if !releases::verify(&s.asset.name, &hash, &sig) {
        return Err(t("Die Signatur der heruntergeladenen Datei stimmt nicht. FORGE wird nicht installiert.", "The signature of the downloaded file does not match. FORGE is not installed."));
    }
    log(&format!("geprüft: {}", s.asset.name));
    Ok(())
}

/// Tauri's NSIS installer, silent: `/S`, and `/D=` last and unquoted (NSIS takes the rest of the line).
/// It ends a running FORGE itself. Its progress is not visible from outside, so the bar moves on time,
/// and on the folder size for a fresh install.
fn run_installer(app: &AppHandle, installer: &Path, dir: &str) -> Result<(), String> {
    progress(app, "install", VERIFY_END, None);
    let fresh = !Path::new(dir).join("forge-desktop.exe").exists();
    // Size of an installation with the bundled runtime (0.1.104: about 540 MB).
    let expected = 540.0 * 1024.0 * 1024.0;
    let mut cmd = Command::new(installer);
    cmd.arg("/S");
    // Over an installation: as the app's own update does, without bringing back deleted shortcuts.
    if !fresh {
        cmd.arg("/UPDATE");
    }
    let mut child = cmd
        .raw_arg(format!("/D={dir}"))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("{}: {e}", t("Installer startet nicht", "Installer does not start")))?;
    let start = Instant::now();
    let mut shown = VERIFY_END;
    let mut ticks = 0u32;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(200));
        ticks += 1;
        let by_time = 1.0 - (-start.elapsed().as_secs_f64() / 25.0).exp();
        let by_size = if fresh && ticks % 5 == 0 { folder_size(Path::new(dir)) as f64 / expected } else { 0.0 };
        let share = by_time.max(by_size).min(0.97);
        shown = shown.max(VERIFY_END + (INSTALL_END - VERIFY_END) * share);
        progress(app, "install", shown, None);
    };
    log(&format!("Installer beendet mit {status}"));
    if !status.success() {
        return Err(match status.code() {
            Some(2) => t("Die Installation wurde abgebrochen. Läuft FORGE noch? Schließe es und versuche es erneut.", "The installation was cancelled. Is FORGE still running? Close it and try again."),
            code => format!("{} ({})", t("Die Installation ist fehlgeschlagen", "The installation failed"), code.map_or("?".into(), |c| c.to_string())),
        });
    }
    if !Path::new(dir).join("forge-desktop.exe").exists() {
        return Err(t("Nach der Installation fehlt forge-desktop.exe im Zielordner.", "forge-desktop.exe is missing in the target folder after the installation."));
    }
    Ok(())
}

fn folder_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(ft) if ft.is_dir() => folder_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// Unpacks a small update and copies its files over the fresh installation. FORGE is not running
/// here (the installer just ended it), so no swap dance as in update.rs is needed.
fn apply_patch(zip: &Path, staged: &Path, dir: &Path, version: &str) -> Result<(), String> {
    let failed = |e: String| format!("{}: {e}", t("Update lässt sich nicht einspielen", "Could not apply the update"));
    let _ = std::fs::remove_dir_all(staged);
    std::fs::create_dir_all(staged).map_err(|e| failed(e.to_string()))?;
    let tar = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join("System32").join("tar.exe");
    let out = Command::new(tar).arg("-xf").arg(zip).arg("-C").arg(staged).creation_flags(CREATE_NO_WINDOW).output().map_err(|e| failed(e.to_string()))?;
    if !out.status.success() {
        return Err(failed(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    for rel in PATCH_FILES.iter().filter(|r| **r != "update.json") {
        let from = staged.join(rel);
        if !from.exists() {
            return Err(failed(format!("{rel} fehlt")));
        }
        let to = dir.join(rel);
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| failed(e.to_string()))?;
        }
        std::fs::copy(&from, &to).map_err(|e| failed(format!("{rel}: {e}")))?;
    }
    if version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        let _ = Command::new("reg.exe")
            .args(["add", &format!(r"HKCU\{}", win::UNINSTALL_KEY), "/v", "DisplayVersion", "/d", version, "/f"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    log(&format!("Update {version} eingespielt"));
    Ok(())
}

/// Without WebView2 the setup window cannot show. Microsoft's bootstrapper installs it (with its own
/// small window), as the NSIS installer of FORGE would.
pub fn install_webview2() -> bool {
    let file = std::env::temp_dir().join("MicrosoftEdgeWebview2Setup.exe");
    if download("https://go.microsoft.com/fwlink/p/?LinkId=2124703", &file, |_| {}).is_err() {
        return false;
    }
    let ok = Command::new(&file).arg("/install").status().is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(&file);
    ok && win::webview2_installed()
}
