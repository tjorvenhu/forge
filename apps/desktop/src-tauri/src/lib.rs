mod sidecar;

use sidecar::Sidecar;
use tauri::{Manager, RunEvent};

/// Upper bound for one protocol line from the UI (prompts are capped at 200k chars in the protocol).
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

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

#[tauri::command]
fn sidecar_restart(app: tauri::AppHandle, state: tauri::State<'_, Sidecar>) -> Result<(), String> {
    state.restart(&app)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![sidecar_send, sidecar_status, sidecar_restart])
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
            handle.state::<Sidecar>().shutdown();
        }
    });
}
