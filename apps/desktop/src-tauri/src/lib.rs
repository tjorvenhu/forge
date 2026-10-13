mod chat_windows;
mod job;
mod sidecar;
mod terminal;
mod update;

use chat_windows::ChatWindows;
use sidecar::Sidecar;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;
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

/// A path clicked in a chat, shown in Explorer: a folder opens, a file is only selected in its folder.
/// Never handed to its default program, so a path in a message cannot start anything. Async: the
/// disk check can wait on a slow or network drive.
#[tauri::command]
async fn show_in_explorer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::PathBuf::from(&path);
    if path.len() > 4096 || !p.is_absolute() {
        return Err("Kein gültiger Pfad".into());
    }
    if p.is_dir() {
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    } else if p.exists() {
        app.opener().reveal_item_in_dir(&p).map_err(|e| e.to_string())
    } else {
        Err("Pfad nicht gefunden".into())
    }
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

/// Installs a downloaded update (full installer or small patch, see update.rs). Terminals and
/// sidecar end cleanly first; the installer or the swap script is started by the shell, not by the
/// sidecar, because the sidecar's job object would end it together with FORGE.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let plan = update::prepare(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Terminals>().shutdown();
        app.state::<Sidecar>().shutdown();
        update::launch(plan)?;
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
        .manage(ChatWindows::default())
        .invoke_handler(tauri::generate_handler![
            sidecar_send,
            sidecar_status,
            sidecar_restart,
            install_update,
            show_in_explorer,
            term_open,
            term_write,
            term_resize,
            term_close,
            chat_windows::open_chat_window,
            chat_windows::close_chat_window,
            chat_windows::chat_windows,
            chat_windows::update_chat_window,
            chat_windows::reattach_chat_window,
            chat_windows::set_always_on_top,
            chat_windows::show_main_window
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                let app = window.app_handle();
                // Chat windows belong to the main window: closing it quits FORGE as before.
                if window.label() == chat_windows::MAIN {
                    app.exit(0);
                } else if window.label().starts_with(chat_windows::PREFIX) {
                    app.state::<ChatWindows>().forget(app, window.label());
                    let _ = app.state::<Sidecar>().send(&chat_windows::unfocused_line(window.label()));
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Without a handler the plugin does not even watch for clicks on its notifications.
            let on_click = handle.clone();
            let _ = app.notification().on_action(move |performed| {
                if performed.action_id() != "tap" {
                    return;
                }
                let extra = performed.notification().map(|n| n.extra());
                let field = |key: &str| extra.and_then(|e| e.get(key)).and_then(|v| v.as_str()).map(str::to_owned);
                let (project, session) = (field("projectId"), field("sessionId"));
                let app = on_click.clone();
                // The handler runs on a notification thread; windows are moved on the main thread.
                let _ = on_click.run_on_main_thread(move || match (project, session) {
                    (Some(p), Some(s)) => chat_windows::open_session(&app, &p, &s),
                    _ => chat_windows::show_main(&app),
                });
            });
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
