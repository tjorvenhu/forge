//! Session chats detached from the main window into their own windows. The shell keeps the list of
//! open chat windows, so every webview can ask for it and hears about changes, also a window that
//! was opened after the others.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const PREFIX: &str = "chat-";
/// Window entry in tauri.conf.json with `"create": false`; size and backdrop of chat windows live there.
const TEMPLATE: &str = "chat";
/// Payload: ids of the sessions shown in chat windows.
const CHANGED: &str = "chat-windows://changed";
/// Sent to the main window: show this chat again.
const REATTACH: &str = "chat-windows://reattach";
/// Sent to the main window: open this session (a click on its Windows notification).
const OPEN_SESSION: &str = "chat-windows://open-session";

const MAX_ID: usize = 100;
const MAX_TITLE: usize = 200;
/// Same bound as a prompt in the protocol.
const MAX_DRAFT: usize = 200_000;

#[derive(Default)]
pub struct ChatWindows {
    /// window label -> session shown there; None while the window shows a new session not started yet
    shown: Mutex<HashMap<String, Option<String>>>,
    /// Setting "Im Vordergrund bleiben": holds for the main window and every chat window.
    on_top: AtomicBool,
}

/// What a chat window shows; handed to its webview before the page loads, and back to the main window.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTarget {
    project_id: String,
    session_id: Option<String>,
    #[serde(default)]
    draft: Option<String>,
}

/// Top-left corner of a new chat window in logical screen pixels (where a dragged tab was dropped).
#[derive(Clone, Copy, Deserialize)]
pub struct WindowPosition {
    x: f64,
    y: f64,
}

impl ChatTarget {
    fn validate(&self) -> Result<(), String> {
        let id_ok = |s: &str| !s.is_empty() && s.len() <= MAX_ID;
        if !id_ok(&self.project_id) || !self.session_id.as_deref().map_or(true, id_ok) {
            return Err("Ungültige Session".into());
        }
        if self.draft.as_ref().is_some_and(|d| d.len() > MAX_DRAFT) {
            return Err("Entwurf zu groß".into());
        }
        Ok(())
    }
}

/// Window labels allow only `a-zA-Z0-9-/:_`; session ids are UUIDs, anything else is dropped.
pub fn label_for(session_id: &str) -> Option<String> {
    let clean: String = session_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(MAX_ID).collect();
    (!clean.is_empty()).then(|| format!("{PREFIX}{clean}"))
}

/// First label from `base` that is not taken: a window whose chat moved on to another session
/// (fork, /clear) keeps its label.
fn free_label(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_owned();
    }
    (2..).map(|n| format!("{base}-{n}")).find(|l| !taken(l)).unwrap()
}

fn shown_sessions(map: &HashMap<String, Option<String>>) -> Vec<String> {
    map.values().flatten().cloned().collect()
}

fn label_of(map: &HashMap<String, Option<String>>, session_id: &str) -> Option<String> {
    map.iter().find(|(_, s)| s.as_deref() == Some(session_id)).map(|(l, _)| l.clone())
}

/// Where the cursor grabs a torn-off window, in logical pixels from its top-left corner: on the title bar.
const GRAB_X: f64 = 160.0;
const GRAB_Y: f64 = 16.0;

/// Places the hidden window under the cursor, shows it and hands the still running drag to Windows,
/// like dragging the title bar: the window moves with the mouse until the button is released.
/// Runs on the main thread and reads the cursor there: building the webview takes a few hundred ms,
/// a cursor read before that is stale, and the window would keep the distance the mouse travelled
/// meanwhile as a fixed offset for the whole drag. Without a held button the move loop would never end.
fn follow_cursor<R: Runtime>(app: &AppHandle<R>, w: WebviewWindow<R>) {
    let _ = app.run_on_main_thread(move || {
        if let Ok(c) = w.cursor_position() {
            let scale = w.monitor_from_point(c.x, c.y).ok().flatten().map_or_else(|| w.scale_factor().unwrap_or(1.0), |m| m.scale_factor());
            let _ = w.set_position(PhysicalPosition::new((c.x - GRAB_X * scale).round() as i32, (c.y - GRAB_Y * scale).round() as i32));
        }
        let _ = w.show();
        let _ = w.set_focus();
        if left_button_down() {
            let _ = w.start_dragging();
        }
    });
}

#[cfg(windows)]
fn left_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    // High bit: the button is down right now (physical button, like the drag that started it).
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

fn bring_to_front<R: Runtime>(w: &WebviewWindow<R>) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

impl ChatWindows {
    fn notify<R: Runtime>(&self, app: &AppHandle<R>) {
        let list = shown_sessions(&self.shown.lock().unwrap());
        let _ = app.emit(CHANGED, list);
    }

    /// A chat window was closed (by the user or because FORGE quits).
    pub fn forget<R: Runtime>(&self, app: &AppHandle<R>, label: &str) {
        let removed = self.shown.lock().unwrap().remove(label).is_some();
        if removed {
            self.notify(app);
        }
    }
}

/// Shows the session in its own window, or brings the window that already shows it to the front.
/// Async: building a webview from a synchronous command deadlocks on Windows (WebView2).
#[tauri::command]
pub async fn open_chat_window(app: AppHandle, target: ChatTarget, title: String, position: Option<WindowPosition>, drag: Option<bool>) -> Result<(), String> {
    let drag = drag.unwrap_or(false);
    target.validate()?;
    let session_id = target.session_id.clone().ok_or("Ungültige Session")?;
    let base = label_for(&session_id).ok_or("Ungültige Session")?;
    let mut config = app.config().app.windows.iter().find(|w| w.label == TEMPLATE).cloned().ok_or("Fenstervorlage fehlt")?;
    // serde_json output is a valid JS expression; the page reads it before any of its own scripts run.
    let script = format!("window.__FORGE_CHAT__ = {};", serde_json::to_string(&target).map_err(|e| e.to_string())?);
    let state = app.state::<ChatWindows>();
    // Looked up and reserved under one lock: a double click must not open two windows.
    let reserved = {
        let mut shown = state.shown.lock().unwrap();
        match label_of(&shown, &session_id) {
            Some(existing) => Err(existing),
            None => {
                let label = free_label(&base, |l| shown.contains_key(l) || app.get_webview_window(l).is_some());
                shown.insert(label.clone(), Some(session_id));
                Ok(label)
            }
        }
    };
    let label = match reserved {
        Ok(label) => label,
        Err(existing) => {
            // Without a window it is still being built by the first call.
            if let Some(w) = app.get_webview_window(&existing) {
                bring_to_front(&w);
            }
            return Ok(());
        }
    };
    config.label = label.clone();
    config.title = window_title(&title);
    config.always_on_top = state.on_top.load(Ordering::Relaxed);
    let cursor = if drag { app.cursor_position().ok() } else { None };
    if let Some(c) = cursor {
        // Torn-off tab: the window appears with its title bar under the cursor.
        let scale = app.monitor_from_point(c.x, c.y).ok().flatten().map_or(1.0, |m| m.scale_factor());
        config.x = Some(c.x / scale - GRAB_X);
        config.y = Some(c.y / scale - GRAB_Y);
        config.center = false;
        // Shown by follow_cursor once it sits under the cursor, not first at the stale spot.
        config.visible = false;
    } else if let Some(p) = position.filter(|p| p.x.is_finite() && p.y.is_finite()) {
        config.x = Some(p.x);
        config.y = Some(p.y);
        config.center = false;
    }
    let built = WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|b| b.initialization_script(script).build());
    match built {
        Ok(w) => {
            state.notify(&app);
            if cursor.is_some() {
                follow_cursor(&app, w);
            } else {
                let _ = w.set_focus();
            }
            Ok(())
        }
        Err(e) => {
            state.shown.lock().unwrap().remove(&label);
            Err(format!("Fenster konnte nicht geöffnet werden ({e})."))
        }
    }
}

pub fn window_title(session_title: &str) -> String {
    let t: String = session_title.trim().chars().take(MAX_TITLE).collect();
    if t.is_empty() {
        "FORGE".into()
    } else {
        format!("FORGE · {t}")
    }
}

/// Closes the chat window of a session; the main window shows the chat again.
#[tauri::command]
pub fn close_chat_window(app: AppHandle, session_id: String) {
    let label = label_of(&app.state::<ChatWindows>().shown.lock().unwrap(), &session_id);
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.close();
    }
}

/// Ids of the sessions shown in chat windows.
#[tauri::command]
pub fn chat_windows(state: tauri::State<'_, ChatWindows>) -> Vec<String> {
    shown_sessions(&state.shown.lock().unwrap())
}

/// A chat window reports what it shows: another session after a fork or /clear (None while a new
/// session has not started yet), or a new title. Only chat windows can call this for themselves.
#[tauri::command]
pub fn update_chat_window(app: AppHandle, window: WebviewWindow, session_id: Option<String>, title: String) -> Result<(), String> {
    if session_id.as_ref().is_some_and(|s| s.is_empty() || s.len() > MAX_ID) {
        return Err("Ungültige Session".into());
    }
    let state = app.state::<ChatWindows>();
    let changed = {
        let mut shown = state.shown.lock().unwrap();
        let Some(entry) = shown.get_mut(window.label()) else {
            return Ok(());
        };
        let changed = *entry != session_id;
        *entry = session_id;
        changed
    };
    if changed {
        state.notify(&app);
    }
    window.set_title(&window_title(&title)).map_err(|e| e.to_string())
}

/// Keeps every FORGE window above other apps, or lets them go; chat windows opened later follow.
#[tauri::command]
pub fn set_always_on_top(app: AppHandle, on: bool) {
    app.state::<ChatWindows>().on_top.store(on, Ordering::Relaxed);
    for w in app.webview_windows().values() {
        let _ = w.set_always_on_top(on);
    }
}

/// A click on a Windows notification that names no session.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window(MAIN) {
        bring_to_front(&main);
    }
}

/// A click on the Windows notification of a session: the window that shows it comes to the front,
/// its chat window if it has one, otherwise the main window with that session open.
pub fn open_session<R: Runtime>(app: &AppHandle<R>, project_id: &str, session_id: &str) {
    let label = label_of(&app.state::<ChatWindows>().shown.lock().unwrap(), session_id);
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        bring_to_front(&w);
        return;
    }
    let Some(main) = app.get_webview_window(MAIN) else { return };
    let target = ChatTarget { project_id: project_id.to_owned(), session_id: Some(session_id.to_owned()), draft: None };
    if target.validate().is_ok() {
        let _ = app.emit_to(MAIN, OPEN_SESSION, target);
    }
    bring_to_front(&main);
}

/// Called by a chat window: the main window shows that chat again and comes to the front, the
/// chat window closes.
#[tauri::command]
pub async fn reattach_chat_window(app: AppHandle, window: WebviewWindow, target: ChatTarget) -> Result<(), String> {
    target.validate()?;
    if !window.label().starts_with(PREFIX) {
        return Err("Kein Chat-Fenster".into());
    }
    let main = app.get_webview_window(MAIN).ok_or("Hauptfenster fehlt")?;
    app.emit_to(MAIN, REATTACH, target).map_err(|e| e.to_string())?;
    bring_to_front(&main);
    window.close().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_keeps_uuid() {
        assert_eq!(label_for("0b4e7a2c-9f1d-4c3e-8a77-2f0c1d5e6b9a").as_deref(), Some("chat-0b4e7a2c-9f1d-4c3e-8a77-2f0c1d5e6b9a"));
    }

    #[test]
    fn label_drops_disallowed_chars() {
        assert_eq!(label_for("a b/c:d.e_f").as_deref(), Some("chat-abcde_f"));
        assert_eq!(label_for("../ "), None);
        assert_eq!(label_for(""), None);
        assert_eq!(label_for(&"x".repeat(500)).map(|l| l.len()), Some(PREFIX.len() + MAX_ID));
    }

    #[test]
    fn free_label_adds_suffix() {
        assert_eq!(free_label("chat-a", |_| false), "chat-a");
        assert_eq!(free_label("chat-a", |l| l == "chat-a" || l == "chat-a-2"), "chat-a-3");
    }

    #[test]
    fn title_without_dashes() {
        assert_eq!(window_title("  Fix  "), "FORGE · Fix");
        assert_eq!(window_title(""), "FORGE");
    }

    #[test]
    fn target_validation() {
        let t = |p: &str, s: Option<&str>| ChatTarget { project_id: p.into(), session_id: s.map(Into::into), draft: None };
        assert!(t("p", Some("s")).validate().is_ok());
        assert!(t("p", None).validate().is_ok());
        assert!(t("", Some("s")).validate().is_err());
        assert!(t("p", Some("")).validate().is_err());
    }
}
