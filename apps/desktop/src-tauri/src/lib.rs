mod job;
mod sidecar;
mod terminal;

use sidecar::Sidecar;
use tauri::{Manager, RunEvent};
use terminal::{OpenRequest, Terminals};

/// Upper bound for one protocol line from the UI (prompts are capped at 200k chars in the protocol).
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

// Commands without `async` run on the main thread. The ones below only queue data or do short
// system calls; everything that can wait on a process or a pipe runs elsewhere.

#[tauri::command]
fn sidecar_send(line: String, state: tauri::State<'_, Sidecar>) -> Result<(), String> {
    if line.len() > MAX_LINE_BYTES {
        return Err("Nachricht zu groß".into());
    }
    if line.contains('\n') {
        return Err("Ungültige Nachricht".into());
    }
    state.send(&line)
}

#[tauri::command]
fn sidecar_status(state: tauri::State<'_, Sidecar>) -> bool {
    state.is_running()
}

/// Shutdown waits up to the grace period, so the restart runs off the main thread.
#[tauri::command]
async fn sidecar_restart(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Sidecar>();
        state.shutdown();
        state.start(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Runs a downloaded FORGE installer and quits. Only an installer from the update folder of the
/// sidecar is accepted. The sidecar and the terminals are ended first and cleanly; the installer is
/// started by the shell, not by the sidecar, because the sidecar's job object would end it with FORGE.
/// `/P` installs without questions, `/UPDATE` keeps the settings, `/R` starts FORGE again.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let installer = std::path::PathBuf::from(&path);
    let dir = std::env::temp_dir().join("forge-update");
    let canonical = installer.canonicalize().map_err(|_| "Installer nicht gefunden".to_string())?;
    let allowed = dir.canonicalize().map_err(|_| "Kein Update heruntergeladen".to_string())?;
    let name_ok = canonical.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.to_ascii_lowercase().ends_with("-setup.exe"));
    if !canonical.starts_with(&allowed) || !name_ok {
        return Err("Ungültiger Installer".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Terminals>().shutdown();
        app.state::<Sidecar>().shutdown();
        std::process::Command::new(&canonical)
            .args(["/P", "/UPDATE", "/R"])
            .spawn()
            .map_err(|e| format!("Installer startet nicht: {e}"))?;
        app.exit(0);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn term_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, Terminals>,
    cwd: String,
    cols: u16,
    rows: u16,
    program: String,
    claude_path: Option<String>,
) -> Result<u32, String> {
    state.open(&app, sidecar::runtime_dir(&app), OpenRequest { cwd, cols, rows, program, claude_path })
}

#[tauri::command]
fn term_write(state: tauri::State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    state.write(id, &data)
}

#[tauri::command]
fn term_resize(state: tauri::State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(id, cols, rows)
}

#[tauri::command]
fn term_close(state: tauri::State<'_, Terminals>, id: u32) {
    state.close(id)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sidecar::default())
        .manage(Terminals::default())
        .invoke_handler(tauri::generate_handler![sidecar_send, sidecar_status, sidecar_restart, install_update, term_open, term_write, term_resize, term_close])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = app.state::<Sidecar>().start(&handle) {
                eprintln!("[forge] sidecar start failed: {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building FORGE");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Terminals>().shutdown();
            handle.state::<Sidecar>().shutdown();
        }
    });
}
