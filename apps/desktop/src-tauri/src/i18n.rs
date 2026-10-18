//! Language of the texts Rust hands to the UI (errors, window titles). The UI sends its language at
//! start (`set_language`); the choice is kept in a small file so that texts from before the first UI
//! call, like a failed sidecar start, are already in the right language. Default is English.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

static GERMAN: AtomicBool = AtomicBool::new(false);

const FILE: &str = "language";

pub fn is_german() -> bool {
    GERMAN.load(Ordering::Relaxed)
}

/// English or German text as a `String`; the arguments go into whichever text is picked.
macro_rules! tr {
    ($en:literal, $de:literal $(, $arg:expr)* $(,)?) => {
        if crate::i18n::is_german() { format!($de $(, $arg)*) } else { format!($en $(, $arg)*) }
    };
}
pub(crate) use tr;

/// English or German text that lives for the whole run, for APIs that hand out `&'static str`.
pub fn pick(en: &'static str, de: &'static str) -> &'static str {
    if is_german() {
        de
    } else {
        en
    }
}

/// Reads the saved language; called once at start, before the sidecar.
pub fn load(app: &tauri::AppHandle) {
    let saved = app.path().app_config_dir().ok().and_then(|dir| std::fs::read_to_string(dir.join(FILE)).ok());
    GERMAN.store(saved.is_some_and(|s| s.trim() == "de"), Ordering::Relaxed);
}

#[tauri::command]
pub fn set_language(app: tauri::AppHandle, language: String) {
    let german = language == "de";
    if GERMAN.swap(german, Ordering::Relaxed) == german {
        return;
    }
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join(FILE), if german { "de" } else { "en" });
    }
}
