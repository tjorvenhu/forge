//! FORGE Setup: one small installer that never changes. It looks up the newest FORGE release on
//! GitHub, downloads the signed full installer (and a newer small update), checks both against the
//! release signature and installs them. The window is HTML (ui/), the work happens here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod install;
mod releases;
mod win;

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

static GERMAN: OnceLock<bool> = OnceLock::new();

/// Text in the language of Windows.
pub fn t(de: &str, en: &str) -> String {
    if *GERMAN.get_or_init(win::german) { de } else { en }.to_string()
}

/// %TEMP%\forge-setup.log, for support when an installation fails.
pub fn log(line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("forge-setup.log")) {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let _ = writeln!(f, "{secs} {line}");
    }
}

#[derive(Default)]
struct Setup {
    plan: Mutex<Option<releases::Plan>>,
    running: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Info {
    lang: &'static str,
    default_dir: String,
    installed: Option<win::Installed>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolved {
    version: String,
    download_bytes: u64,
}

#[tauri::command]
fn info() -> Info {
    let installed = win::installed();
    Info {
        lang: if win::german() { "de" } else { "en" },
        default_dir: installed.as_ref().map_or_else(win::default_dir, |i| i.dir.clone()),
        installed,
    }
}

#[tauri::command]
async fn resolve(setup: State<'_, Setup>) -> Result<Resolved, String> {
    let plan = tauri::async_runtime::spawn_blocking(|| releases::fetch().and_then(|r| releases::pick(&r))).await.map_err(|e| e.to_string())??;
    log(&format!("gefunden: {} ({}{})", plan.version, plan.installer.asset.name, plan.patch.as_ref().map_or(String::new(), |p| format!(" + {}", p.asset.name))));
    let resolved = Resolved { version: plan.version.clone(), download_bytes: plan.download_bytes() };
    *setup.plan.lock().unwrap() = Some(plan);
    Ok(resolved)
}

/// A chosen folder gets a FORGE subfolder unless it is one already, as most installers do.
#[tauri::command]
async fn pick_dir(app: AppHandle, current: Option<String>) -> Option<String> {
    let mut dialog = app.dialog().file().set_title(t("Zielordner für FORGE", "Folder for FORGE"));
    if let Some(parent) = current.as_deref().and_then(|c| Path::new(c).parent()).filter(|p| p.exists()) {
        dialog = dialog.set_directory(parent);
    }
    let picked = dialog.blocking_pick_folder()?.into_path().ok()?;
    let is_forge = picked.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("FORGE"));
    Some(if is_forge { picked } else { picked.join("FORGE") }.to_string_lossy().into_owned())
}

#[tauri::command]
fn install(app: AppHandle, setup: State<'_, Setup>, dir: String) -> Result<(), String> {
    let plan = setup.plan.lock().unwrap().clone().ok_or_else(|| t("Noch keine Version gefunden.", "No version found yet."))?;
    if setup.running.swap(true, Ordering::SeqCst) {
        return Err(t("Die Installation läuft schon.", "The installation is already running."));
    }
    std::thread::spawn(move || {
        install::run(app.clone(), plan, dir);
        app.state::<Setup>().running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
fn launch(app: AppHandle, dir: String) -> Result<(), String> {
    std::process::Command::new(Path::new(&dir).join("forge-desktop.exe"))
        .current_dir(&dir)
        .spawn()
        .map_err(|e| format!("{}: {e}", t("FORGE startet nicht", "FORGE does not start")))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn quit(app: AppHandle, setup: State<'_, Setup>) {
    // Closing in the middle would leave a half installed FORGE behind.
    if !setup.running.load(Ordering::SeqCst) {
        app.exit(0);
    }
}

#[tauri::command]
fn minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

fn main() {
    if !win::webview2_installed() && !install::install_webview2() {
        win::error_box(&t(
            "FORGE braucht Microsoft Edge WebView2, und es ließ sich nicht installieren. Installiere es von https://developer.microsoft.com/microsoft-edge/webview2 und starte FORGE Setup erneut.",
            "FORGE needs Microsoft Edge WebView2, and it could not be installed. Install it from https://developer.microsoft.com/microsoft-edge/webview2 and start FORGE Setup again.",
        ));
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Setup::default())
        .invoke_handler(tauri::generate_handler![info, resolve, pick_dir, install, launch, quit, minimize, open_url])
        .run(tauri::generate_context!())
        .expect("FORGE Setup startet nicht");
}
