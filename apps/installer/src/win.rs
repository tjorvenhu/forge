//! Windows bits: UI language, the existing FORGE installation, WebView2, message boxes.

use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use serde::Serialize;
use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

/// Uninstall key the NSIS installer of FORGE writes (Tauri: Software\…\Uninstall\<productName>).
pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\FORGE";
const WEBVIEW2_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(Some(0)).collect()
}

pub fn german() -> bool {
    // primary language id 0x07: German
    unsafe { GetUserDefaultUILanguage() & 0x3ff == 0x07 }
}

fn reg_string(root: HKEY, key: &str, value: &str) -> Option<String> {
    let (k, v) = (wide(key), wide(value));
    let mut len: u32 = 0;
    unsafe {
        if RegGetValueW(root, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut len) != 0 || len == 0 {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        if RegGetValueW(root, k.as_ptr(), v.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len) != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

#[derive(Serialize, Clone)]
pub struct Installed {
    pub version: Option<String>,
    pub dir: String,
}

pub fn installed() -> Option<Installed> {
    let dir = reg_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallLocation")?.trim_matches('"').to_string();
    if dir.is_empty() || !PathBuf::from(&dir).join("forge-desktop.exe").exists() {
        return None;
    }
    Some(Installed { version: reg_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "DisplayVersion"), dir })
}

/// Where Tauri's per-user NSIS installer puts FORGE by default.
pub fn default_dir() -> String {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| format!(r"{}\AppData\Local", std::env::var("USERPROFILE").unwrap_or_default()));
    format!(r"{base}\FORGE")
}

/// Same places as the WebView2 check of Tauri's NSIS template.
pub fn webview2_installed() -> bool {
    let key = format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_GUID}");
    let key32 = format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_GUID}");
    [(HKEY_LOCAL_MACHINE, &key), (HKEY_LOCAL_MACHINE, &key32), (HKEY_CURRENT_USER, &key32)]
        .iter()
        .filter_map(|(root, k)| reg_string(*root, k, "pv"))
        .any(|v| !v.is_empty() && v != "0.0.0.0")
}

pub fn error_box(text: &str) {
    let (t, c) = (wide(text), wide("FORGE Setup"));
    unsafe {
        MessageBoxW(std::ptr::null_mut(), t.as_ptr(), c.as_ptr(), MB_OK | MB_ICONERROR);
    }
}
