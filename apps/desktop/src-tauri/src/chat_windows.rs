//! Session chats detached from the main window into their own windows. The shell keeps the list of
//! open chat windows, so every webview can ask for it and hears about changes, also a window that
//! was opened after the others.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const PREFIX: &str = "chat-";
/// Window entry in tauri.conf.json with `"create": false`; size and backdrop of chat windows live there.
const TEMPLATE: &str = "chat";
/// Payload: ids of the sessions shown in chat windows.
const CHANGED: &str = "chat-windows://changed";
/// Sent to the main window: show this chat again.
const REATTACH: &str = "chat-windows://reattach";

const MAX_ID: usize = 100;
const MAX_TITLE: usize = 200;
/// Same bound as a prompt in the protocol.
const MAX_DRAFT: usize = 200_000;

#[derive(Default)]
pub struct ChatWindows {
    /// window label -> session shown there; None while the window shows a new session not started yet
    shown: Mutex<HashMap<String, Option<String>>>,
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
pub async fn open_chat_window(app: AppHandle, target: ChatTarget, title: String) -> Result<(), String> {
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
    let built = WebviewWindowBuilder::from_config(&app, &config)
        .and_then(|b| b.initialization_script(script).build());
    match built {
        Ok(w) => {
            let _ = w.set_focus();
            state.notify(&app);
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
