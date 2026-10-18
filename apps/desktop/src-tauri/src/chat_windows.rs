//! Session chats detached from the main window into their own windows. The shell keeps the list of
//! open chat windows, so every webview can ask for it and hears about changes, also a window that
//! was opened after the others.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const PREFIX: &str = "chat-";
/// Window entry in tauri.conf.json with `"create": false`; size and backdrop of chat windows live there.
const TEMPLATE: &str = "chat";
/// Payload: ChatWindowList.
const CHANGED: &str = "chat-windows://changed";
/// Sent to the main window: show this chat again.
const REATTACH: &str = "chat-windows://reattach";
/// Sent to the main window: open this session (a click on its Windows notification).
const OPEN_SESSION: &str = "chat-windows://open-session";

const MAX_ID: usize = 100;
const MAX_TITLE: usize = 200;
/// A prompt of the protocol's maximum length (2M UTF-16 units) in UTF-8 bytes.
const MAX_DRAFT: usize = 6_000_000;
/// Same bound as the composer.
const MAX_FILES: usize = 10;
/// All attachments of a draft together. Pasted files are uploaded and held as paths; data attachments travel as base64.
const MAX_FILES_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILE_NAME: usize = 260;

#[derive(Default)]
pub struct ChatWindows {
    /// window label -> session shown there; None while the window shows a new session not started yet
    shown: Mutex<HashMap<String, Option<String>>>,
    /// labels of the chat windows kept above other apps; each is pinned on its own
    pinned: Mutex<HashSet<String>>,
}

/// The chat windows as every webview sees them: sessions shown in their own window, and those of
/// them kept on top (the main window remembers them across an update restart, the phone asks).
#[derive(Clone, Serialize)]
pub struct ChatWindowList {
    sessions: Vec<String>,
    pinned: Vec<String>,
}

/// What a chat window shows; handed to its webview before the page loads, and back to the main window.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTarget {
    project_id: String,
    session_id: Option<String>,
    #[serde(default)]
    draft: Option<String>,
    /// Attachments of the draft; they move with it, so none stay behind as an old copy.
    #[serde(default)]
    files: Vec<DraftFile>,
}

/// An attachment as the composer holds it; the shell only passes it on and bounds its size.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftFile {
    name: String,
    #[serde(default)]
    is_image: bool,
    attachment: serde_json::Value,
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
        if self.files.len() > MAX_FILES || self.files.iter().any(|f| f.name.len() > MAX_FILE_NAME || !f.attachment.is_object()) {
            return Err("Ungültige Anhänge".into());
        }
        let bytes: usize = self.files.iter().map(|f| f.attachment.to_string().len()).sum();
        if bytes > MAX_FILES_BYTES {
            return Err("Anhänge zu groß für ein eigenes Fenster".into());
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
        if primary_button_down() {
            let _ = w.start_dragging();
        }
    });
}

/// Whether the primary mouse button (the one that drags) is held right now.
#[cfg(windows)]
fn primary_button_down() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    // GetAsyncKeyState reads physical buttons; with swapped buttons the primary one is the right.
    let key = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 { VK_RBUTTON } else { VK_LBUTTON };
    // High bit: the button is down right now.
    unsafe { (GetAsyncKeyState(key as i32) as u16 & 0x8000) != 0 }
}

#[cfg(not(windows))]
fn primary_button_down() -> bool {
    false
}

fn bring_to_front<R: Runtime>(w: &WebviewWindow<R>) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

impl ChatWindows {
    fn list(&self) -> ChatWindowList {
        let shown = self.shown.lock().unwrap();
        let pinned = self.pinned.lock().unwrap();
        let mut on_top: Vec<String> = pinned.iter().filter_map(|l| shown.get(l).cloned().flatten()).collect();
        on_top.sort();
        ChatWindowList { sessions: shown_sessions(&shown), pinned: on_top }
    }

    fn notify<R: Runtime>(&self, app: &AppHandle<R>) {
        let _ = app.emit(CHANGED, self.list());
    }

    fn pin<R: Runtime>(&self, app: &AppHandle<R>, w: &WebviewWindow<R>, on: bool) -> Result<(), String> {
        w.set_always_on_top(on).map_err(|e| e.to_string())?;
        let changed = {
            let mut pinned = self.pinned.lock().unwrap();
            if on {
                pinned.insert(w.label().to_owned())
            } else {
                pinned.remove(w.label())
            }
        };
        if changed {
            self.notify(app);
        }
        Ok(())
    }

    /// A chat window was closed (by the user or because FORGE quits).
    pub fn forget<R: Runtime>(&self, app: &AppHandle<R>, label: &str) {
        self.pinned.lock().unwrap().remove(label);
        let removed = self.shown.lock().unwrap().remove(label).is_some();
        if removed {
            self.notify(app);
        }
    }
}

/// Shows the session in its own window, or brings the window that already shows it to the front.
/// True when a new window took the draft; an existing window keeps its own.
/// pinned: the new window stays above other apps (after an update restart, or pinned from the phone).
/// Async: building a webview from a synchronous command deadlocks on Windows (WebView2).
#[tauri::command]
pub async fn open_chat_window(app: AppHandle, target: ChatTarget, title: String, position: Option<WindowPosition>, drag: Option<bool>, pinned: Option<bool>) -> Result<bool, String> {
    let drag = drag.unwrap_or(false);
    let pinned = pinned.unwrap_or(false);
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
                if pinned {
                    state.pin(&app, &w, true)?;
                }
                bring_to_front(&w);
            }
            return Ok(false);
        }
    };
    config.label = label.clone();
    config.title = window_title(&title);
    // Pinned one by one; the main window's setting does not carry over.
    config.always_on_top = pinned;
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
            if pinned {
                state.pinned.lock().unwrap().insert(label.clone());
            }
            state.notify(&app);
            if cursor.is_some() {
                follow_cursor(&app, w);
            } else {
                let _ = w.set_focus();
            }
            Ok(true)
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

/// Closes the chat window of a session (deleted, or it did not answer a recall); the main window
/// shows the chat again. Destroyed, not closed: a close would ask the webview first, which hands its
/// draft back (a deleted session must not come back) or never answers when it hangs.
#[tauri::command]
pub fn close_chat_window(app: AppHandle, session_id: String) {
    let label = label_of(&app.state::<ChatWindows>().shown.lock().unwrap(), &session_id);
    if let Some(w) = label.and_then(|l| app.get_webview_window(&l)) {
        let _ = w.destroy();
    }
}

/// The sessions shown in chat windows, and those of them kept on top.
#[tauri::command]
pub fn chat_windows(state: tauri::State<'_, ChatWindows>) -> ChatWindowList {
    state.list()
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

/// Setting "Im Vordergrund bleiben": keeps the main window above other apps, or lets it go. Chat
/// windows are pinned one by one (chat_window_on_top).
#[tauri::command]
pub fn set_always_on_top(app: AppHandle, on: bool) {
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.set_always_on_top(on);
    }
}

/// Pins a chat window above other apps (Some(true)), lets it go (Some(false)) or only asks; returns
/// whether it stays on top now. Without session_id the calling chat window means itself; the main
/// window names the session (palette, phone).
#[tauri::command]
pub fn chat_window_on_top(app: AppHandle, window: WebviewWindow, session_id: Option<String>, on: Option<bool>) -> Result<bool, String> {
    let state = app.state::<ChatWindows>();
    let target = match session_id {
        Some(id) => {
            let label = label_of(&state.shown.lock().unwrap(), &id).ok_or("Die Session ist in keinem eigenen Fenster offen.")?;
            app.get_webview_window(&label).ok_or("Das Fenster ist schon geschlossen.")?
        }
        None if window.label().starts_with(PREFIX) => window,
        None => return Err("Kein Chat-Fenster".into()),
    };
    if let Some(on) = on {
        state.pin(&app, &target, on)?;
    }
    target.is_always_on_top().map_err(|e| e.to_string())
}

/// A click on a Windows notification that names no session.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window(MAIN) {
        bring_to_front(&main);
    }
}

/// Called by a chat window that opens something in the main window (a file path in its chat).
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    show_main(&app);
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
    let target = ChatTarget { project_id: project_id.to_owned(), session_id: Some(session_id.to_owned()), draft: None, files: Vec::new() };
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
    // Not close(): the window would hand its (now empty) draft back a second time on the way out.
    window.destroy().map_err(|e| e.to_string())
}

/// Protocol line for the sidecar: a closed chat window no longer has the focus. The webview is
/// gone and cannot report its blur itself.
pub fn unfocused_line(label: &str) -> String {
    serde_json::json!({
        "id": "shell-presence",
        "method": "app.presence",
        "params": { "window": label, "focused": false, "active": false },
    })
    .to_string()
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
    fn list_names_pinned_sessions() {
        let w = ChatWindows::default();
        w.shown.lock().unwrap().extend([("chat-a".to_owned(), Some("a".to_owned())), ("chat-b".to_owned(), Some("b".to_owned())), ("chat-new".to_owned(), None)]);
        w.pinned.lock().unwrap().extend(["chat-b".to_owned(), "chat-new".to_owned(), "chat-gone".to_owned()]);
        let list = w.list();
        assert_eq!(list.pinned, vec!["b".to_owned()]);
        let mut sessions = list.sessions;
        sessions.sort();
        assert_eq!(sessions, vec!["a".to_owned(), "b".to_owned()]);
    }

    #[test]
    fn title_without_dashes() {
        assert_eq!(window_title("  Fix  "), "FORGE · Fix");
        assert_eq!(window_title(""), "FORGE");
    }

    #[test]
    fn target_validation() {
        let t = |p: &str, s: Option<&str>| ChatTarget { project_id: p.into(), session_id: s.map(Into::into), draft: None, files: Vec::new() };
        assert!(t("p", Some("s")).validate().is_ok());
        assert!(t("p", None).validate().is_ok());
        assert!(t("", Some("s")).validate().is_err());
        assert!(t("p", Some("")).validate().is_err());
    }

    #[test]
    fn draft_files_are_bounded() {
        let file = |attachment: serde_json::Value| DraftFile { name: "a.png".into(), is_image: true, attachment };
        let t = |files: Vec<DraftFile>| ChatTarget { project_id: "p".into(), session_id: Some("s".into()), draft: None, files };
        let small = serde_json::json!({ "kind": "path", "path": "C:/a.png" });
        assert!(t(vec![file(small.clone())]).validate().is_ok());
        assert!(t(vec![file(serde_json::json!("C:/a.png"))]).validate().is_err());
        assert!(t((0..=MAX_FILES).map(|_| file(small.clone())).collect()).validate().is_err());
        let big = serde_json::json!({ "kind": "data", "name": "a.png", "mediaType": "image/png", "base64": "A".repeat(MAX_FILES_BYTES) });
        assert!(t(vec![file(big)]).validate().is_err());
    }

    #[test]
    fn target_reads_files_from_the_webview() {
        let t: ChatTarget = serde_json::from_str(r#"{"projectId":"p","sessionId":"s","files":[{"name":"a","isImage":false,"attachment":{"kind":"path","path":"a"}}]}"#).unwrap();
        assert_eq!(t.files.len(), 1);
        let old: ChatTarget = serde_json::from_str(r#"{"projectId":"p","sessionId":null}"#).unwrap();
        assert!(old.files.is_empty());
    }

    #[test]
    fn unfocused_line_is_a_presence_request() {
        let v: serde_json::Value = serde_json::from_str(&unfocused_line("chat-a")).unwrap();
        assert_eq!(v["method"], "app.presence");
        assert_eq!(v["params"], serde_json::json!({ "window": "chat-a", "focused": false, "active": false }));
    }
}
