//! The Print key while FORGE runs: FORGE's snipping tool instead of the one of Windows. A low-level
//! keyboard hook swallows the key, the whole virtual screen is captured at once (the frozen picture
//! the user selects and marks on), and an overlay window over all monitors does the rest. What the
//! user takes goes to the clipboard like with Windows, and to the composer of the FORGE window used last.
//!
//! Alt+Print and Win+Print stay with Windows (active window, save to file).
//!
//! macOS and Linux: a global shortcut (Cmd+Shift+2 on macOS, Print on Linux), the monitor under the
//! cursor is captured (monitors there can be scaled differently, without one common pixel grid).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

use crate::i18n::tr;

/// Label of the overlay window. Built hidden once the Print key is on, and then only hidden, so it opens at once.
pub const OVERLAY: &str = "screenshot";
/// To the overlay: a new capture is ready (payload: FrameInfo).
const FRAME: &str = "screenshot://frame";
/// To the overlay: Esc or Enter was pressed (payload: the key). The hook catches them, because the
/// overlay does not always get the keyboard focus from Windows.
const KEY: &str = "screenshot://key";
/// Log of the Print key in the app's log folder, to see on a user's machine which tool gets the key.
const LOG_FILE: &str = "screenshot.log";
const LOG_MAX_BYTES: u64 = 256 * 1024;
/// To the FORGE window used last: a picture was taken (payload: Taken).
const TAKEN: &str = "screenshot://taken";
/// To the FORGE window used last: the capture failed (payload: the message).
const FAILED: &str = "screenshot://error";
/// More are not worth hovering over; the list is in z-order, the front ones come first.
const MAX_WINDOWS: usize = 300;
/// How long the overlay may take to draw a capture before it is reloaded once.
const READY_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

/// Setting "Druck-Taste für Screenshots"; the main window hands it over once settings are loaded.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// From the capture until the overlay is hidden again.
static OVERLAY_OPEN: AtomicBool = AtomicBool::new(false);
/// Id of the last capture the overlay has drawn and shown.
static SHOWN: AtomicU64 = AtomicU64::new(0);
/// Another program has registered the key too (ShareX and the like), see `screenshot_key_status`.
static KEY_TAKEN: AtomicBool = AtomicBool::new(false);
static TRIGGER: OnceLock<Sender<Trigger>> = OnceLock::new();

enum Trigger {
    Capture,
    Key(&'static str),
    Prepare,
    #[cfg_attr(windows, allow(dead_code))]
    Shortcut(bool),
    Log(String),
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A capture of the whole virtual screen: BGRA rows from the top, alpha set to opaque.
struct Frame {
    id: u64,
    origin: (i32, i32),
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    info: FrameInfo,
}

/// What the overlay needs besides the picture; all positions relative to the frame's top-left corner.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameInfo {
    id: u64,
    width: u32,
    height: u32,
    monitors: Vec<Rect>,
    /// visible top-level windows, the front one first (mode "Fenster")
    windows: Vec<Rect>,
    cursor_x: i32,
    cursor_y: i32,
}

#[derive(Clone, Serialize)]
struct Taken {
    id: u64,
    width: u32,
    height: u32,
}

#[derive(Default)]
pub struct Screenshots {
    frame: Mutex<Option<Frame>>,
    /// the last picture taken, as BMP, until the FORGE window fetches it
    taken: Mutex<Option<(u64, Vec<u8>)>>,
    /// label of the FORGE window (main or a chat window) the user worked in last
    last_window: Mutex<Option<String>>,
    next_id: AtomicU64,
}

impl Screenshots {
    pub fn focused(&self, label: &str) {
        *self.last_window.lock().unwrap() = Some(label.to_owned());
    }
}

/// Starts the keyboard hook and the thread that captures; called once at startup.
pub fn start(app: &AppHandle) {
    let (tx, rx) = channel::<Trigger>();
    if TRIGGER.set(tx).is_err() {
        return;
    }
    hook::install(app);
    let app = app.clone();
    let log = app.path().app_log_dir().ok().map(|d| d.join(LOG_FILE));
    std::thread::Builder::new()
        .name("forge-screenshot".into())
        .spawn(move || {
            let mut log = log.and_then(|p| open_log(&p));
            for t in rx {
                let done = match t {
                    Trigger::Capture => capture(&app).inspect_err(|e| report(&app, e)),
                    Trigger::Prepare => overlay(&app).map(|_| ()),
                    Trigger::Key(key) => app.emit_to(OVERLAY, KEY, key).map_err(|e| e.to_string()),
                    Trigger::Shortcut(on) => hook::shortcut(&app, on),
                    Trigger::Log(line) => {
                        write_log(&mut log, &line);
                        Ok(())
                    }
                };
                if let Err(e) = done {
                    write_log(&mut log, &format!("Fehler: {e}"));
                }
            }
        })
        .ok();
}

/// A failed capture would otherwise only show in the log: the key seems to do nothing.
fn report(app: &AppHandle, message: &str) {
    let _ = app.emit_to(target(app), FAILED, message);
}

fn trigger(t: Trigger) {
    if let Some(tx) = TRIGGER.get() {
        let _ = tx.send(t);
    }
}

fn log(line: impl Into<String>) {
    trigger(Trigger::Log(line.into()));
}

/// Appends to the log of the last runs; starts over once it grew past LOG_MAX_BYTES.
fn open_log(path: &std::path::Path) -> Option<std::fs::File> {
    std::fs::create_dir_all(path.parent()?).ok()?;
    let fresh = std::fs::metadata(path).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(true);
    std::fs::OpenOptions::new().create(true).append(!fresh).write(true).truncate(fresh).open(path).ok()
}

fn write_log(file: &mut Option<std::fs::File>, line: &str) {
    use std::io::Write;
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Some(f) = file {
        let _ = writeln!(f, "{secs} {line}");
    }
}

/// The overlay window, built hidden on first use. Runs on the capture thread: building a webview on
/// the main thread from a command deadlocks on Windows.
fn overlay(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("index.html".into()))
        .title("FORGE Screenshot")
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .focused(false)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .initialization_script("window.__FORGE_SCREENSHOT__ = true;")
        .build()
        .map_err(|e| e.to_string())
}

fn capture(app: &AppHandle) -> Result<(), String> {
    let w = overlay(app)?;
    // A second Print while the overlay is up does nothing; one that never came up (page failed) is replaced.
    if OVERLAY_OPEN.load(Ordering::SeqCst) && w.is_visible().unwrap_or(false) {
        return Ok(());
    }
    let shot = grab::virtual_screen(app)?;
    let origin = (shot.x, shot.y);
    let area = Rect { x: shot.x, y: shot.y, width: shot.width, height: shot.height };
    let relative = |r: Rect| Rect { x: r.x - origin.0, y: r.y - origin.1, ..r };
    let monitors = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Rect { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height })
        .filter(|m| overlaps(m, &area))
        .map(relative)
        .collect();
    let windows = grab::windows(&shot).into_iter().map(relative).collect();
    let cursor = app.cursor_position().map(|c| (c.x.round() as i32 - origin.0, c.y.round() as i32 - origin.1)).unwrap_or((0, 0));
    let state = app.state::<Screenshots>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let info = FrameInfo { id, width: shot.width, height: shot.height, monitors, windows, cursor_x: cursor.0, cursor_y: cursor.1 };
    *state.frame.lock().unwrap() = Some(Frame { id, origin, width: shot.width, height: shot.height, pixels: shot.pixels, info: info.clone() });
    OVERLAY_OPEN.store(true, Ordering::SeqCst);
    place(&w, origin, shot.width, shot.height);
    // The overlay shows itself once it has drawn the picture (screenshot_ready), so nothing blank flashes up.
    // A page still loading asks for the frame itself (screenshot_frame).
    w.emit_to(OVERLAY, FRAME, info).map_err(|e| e.to_string())?;
    watch(app.clone(), id);
    Ok(())
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    let right = |r: &Rect| r.x as i64 + r.width as i64;
    let bottom = |r: &Rect| r.y as i64 + r.height as i64;
    (a.x as i64) < right(b) && (b.x as i64) < right(a) && (a.y as i64) < bottom(b) && (b.y as i64) < bottom(a)
}

/// An overlay that does not draw the capture (page hung, listener lost) would leave the key without
/// any effect: it is reloaded once (the fresh page asks for the frame itself), then given up with a message.
fn watch(app: AppHandle, id: u64) {
    let waiting = move |app: &AppHandle| {
        OVERLAY_OPEN.load(Ordering::SeqCst) && SHOWN.load(Ordering::SeqCst) != id && app.state::<Screenshots>().frame.lock().unwrap().as_ref().is_some_and(|f| f.id == id)
    };
    std::thread::spawn(move || {
        std::thread::sleep(READY_WAIT);
        if !waiting(&app) {
            return;
        }
        log("Overlay hat nicht gezeichnet, wird neu geladen");
        if let Some(w) = app.get_webview_window(OVERLAY) {
            let _ = w.reload();
        }
        std::thread::sleep(READY_WAIT);
        if !waiting(&app) {
            return;
        }
        log("Overlay hat auch nach dem Neuladen nicht gezeichnet");
        hide(&app);
        report(&app, &tr!("The screenshot window did not open. Please press the key again.", "Das Screenshot-Fenster ist nicht aufgegangen. Drück die Taste bitte noch einmal."));
    });
}

/// Over the whole virtual screen, in physical pixels like the capture.
fn place(w: &tauri::WebviewWindow, origin: (i32, i32), width: u32, height: u32) {
    let _ = w.set_position(PhysicalPosition::new(origin.0, origin.1));
    let _ = w.set_size(PhysicalSize::new(width, height));
}

/// Above everything on the screen once shown, also above panels, the menu bar and full-screen apps.
fn raise(w: &tauri::WebviewWindow, origin: (i32, i32)) {
    #[cfg(target_os = "macos")]
    {
        let _ = origin;
        let win = w.clone();
        let _ = w.run_on_main_thread(move || {
            use objc2_app_kit::{NSScreenSaverWindowLevel, NSWindow, NSWindowCollectionBehavior};
            let Ok(ns) = win.ns_window() else { return };
            // SAFETY: Tauri hands out the NSWindow of this window; it lives as long as `win`, and this runs on the main thread.
            let ns = unsafe { &*(ns as *const NSWindow) };
            ns.setLevel(NSScreenSaverWindowLevel);
            ns.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
        });
    }
    // Window managers keep panels above normal windows, and Wayland ignores positions: full screen on the monitor does both.
    #[cfg(target_os = "linux")]
    let _ = w.set_fullscreen_on_monitor(tauri::PhysicalPosition::new(origin.0 as f64, origin.1 as f64));
    #[cfg(windows)]
    let _ = (w, origin);
}

fn hide(app: &AppHandle) {
    OVERLAY_OPEN.store(false, Ordering::SeqCst);
    app.state::<Screenshots>().frame.lock().unwrap().take();
    if let Some(w) = app.get_webview_window(OVERLAY) {
        #[cfg(target_os = "linux")]
        let _ = w.set_fullscreen(false);
        let _ = w.hide();
    }
}

/// The FORGE window to hand the picture to: the one used last, else the main window.
fn target(app: &AppHandle) -> String {
    let last = app.state::<Screenshots>().last_window.lock().unwrap().clone();
    last.filter(|l| app.get_webview_window(l).is_some()).unwrap_or_else(|| crate::chat_windows::MAIN.to_owned())
}

#[tauri::command]
pub fn screenshot_set_enabled(on: bool) {
    if ENABLED.swap(on, Ordering::SeqCst) != on {
        log(format!("Druck-Taste für FORGE: {}", if on { "an" } else { "aus" }));
        #[cfg(not(windows))]
        trigger(Trigger::Shortcut(on));
    }
    if on {
        trigger(Trigger::Prepare);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    /// what opens the snipping tool: "print", or "cmd-shift-2" on macOS
    key: &'static str,
    /// Another program has registered the key as well. On Windows FORGE still gets it first through
    /// its hook, except while a window with administrator rights is in front; elsewhere not at all.
    taken_by_other: bool,
    /// the screenshot tool that runs and most likely holds the key
    other: Option<&'static str>,
}

/// For the setting: whether the key really reaches FORGE.
#[tauri::command]
pub fn screenshot_key_status() -> KeyStatus {
    let taken = ENABLED.load(Ordering::SeqCst) && KEY_TAKEN.load(Ordering::SeqCst);
    KeyStatus { key: if cfg!(target_os = "macos") { "cmd-shift-2" } else { "print" }, taken_by_other: taken, other: if taken { hook::other_tool() } else { None } }
}

/// The same as the Print key (command palette).
#[tauri::command]
pub fn screenshot_start() {
    trigger(Trigger::Capture);
}

#[tauri::command]
pub fn screenshot_frame(state: tauri::State<'_, Screenshots>) -> Option<FrameInfo> {
    state.frame.lock().unwrap().as_ref().map(|f| f.info.clone())
}

/// The whole capture as BMP: the webview decodes it without any encoding step here.
#[tauri::command]
pub async fn screenshot_image(state: tauri::State<'_, Screenshots>, id: u64) -> Result<Response, String> {
    let frame = state.frame.lock().unwrap();
    let f = frame.as_ref().filter(|f| f.id == id).ok_or_else(|| tr!("Capture no longer available", "Aufnahme nicht mehr vorhanden"))?;
    Ok(Response::new(bmp::file(f.width, f.height, &f.pixels)))
}

/// The overlay has drawn the picture of this capture: now it may cover the screen.
#[tauri::command]
pub fn screenshot_ready(app: AppHandle, id: u64) {
    let state = app.state::<Screenshots>();
    let frame = state.frame.lock().unwrap();
    let Some(f) = frame.as_ref().filter(|f| f.id == id) else { return };
    SHOWN.store(id, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window(OVERLAY) {
        place(&w, f.origin, f.width, f.height);
        let _ = w.show();
        // A window spanning monitors with different scaling can be resized by Windows once shown.
        place(&w, f.origin, f.width, f.height);
        raise(&w, f.origin);
        // The window and then its webview: an active window alone does not give the page the keys.
        let _ = w.set_focus();
        let _ = w.as_ref().set_focus();
    }
}

#[tauri::command]
pub fn screenshot_cancel(app: AppHandle) {
    hide(&app);
}

/// The finished picture from the overlay: RGBA rows from the top as raw body, size in the headers
/// `x-width` and `x-height`; `x-forge: 1` also hands it to FORGE. Always goes to the clipboard.
#[tauri::command]
pub async fn screenshot_take(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let size = |k: &str| header(k).and_then(|v| v.parse::<u32>().ok()).filter(|n| *n > 0 && *n <= 100_000);
    let (Some(width), Some(height)) = (size("x-width"), size("x-height")) else {
        return Err(tr!("Invalid image size", "Ungültige Bildgröße"));
    };
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err(tr!("Image missing", "Bild fehlt"));
    };
    if rgba.len() != width as usize * height as usize * 4 {
        return Err(tr!("Image does not match the size", "Bild passt nicht zur Größe"));
    }
    let pixels = rgba_to_bgra(rgba);
    hide(&app);
    let clipboard = clip::set(width, height, &pixels);
    if header("x-forge").as_deref() == Some("1") {
        let state = app.state::<Screenshots>();
        let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        *state.taken.lock().unwrap() = Some((id, bmp::file(width, height, &pixels)));
        let _ = app.emit_to(target(&app), TAKEN, Taken { id, width, height });
    }
    clipboard
}

/// The picture for the window that got screenshot://taken, as BMP. Handed out once.
#[tauri::command]
pub async fn screenshot_taken(state: tauri::State<'_, Screenshots>, id: u64) -> Result<Response, String> {
    let mut taken = state.taken.lock().unwrap();
    match taken.take() {
        Some((t, bytes)) if t == id => Ok(Response::new(bytes)),
        other => {
            *taken = other;
            Err(tr!("Screenshot no longer available", "Screenshot nicht mehr vorhanden"))
        }
    }
}

/// Canvas pixels are RGBA, Windows bitmaps BGRA; transparent parts (outside a freehand cut) become white.
fn rgba_to_bgra(rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len());
    for p in rgba.chunks_exact(4) {
        let a = p[3] as u32;
        let over_white = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        out.extend_from_slice(&[over_white(p[2]), over_white(p[1]), over_white(p[0]), 255]);
    }
    out
}

mod bmp {
    /// A 32-bit BMP file with rows from the top (negative height); browsers decode it as it is.
    pub fn file(width: u32, height: u32, pixels: &[u8]) -> Vec<u8> {
        let header = 14 + 40;
        let size = header + pixels.len();
        let mut out = Vec::with_capacity(size);
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(header as u32).to_le_bytes());
        out.extend_from_slice(&info_header(width as i32, -(height as i32), pixels.len()));
        out.extend_from_slice(pixels);
        out
    }

    /// BITMAPINFOHEADER for 32 bits per pixel, no compression.
    pub fn info_header(width: i32, height: i32, image_bytes: usize) -> [u8; 40] {
        let mut h = [0u8; 40];
        h[0..4].copy_from_slice(&40u32.to_le_bytes());
        h[4..8].copy_from_slice(&width.to_le_bytes());
        h[8..12].copy_from_slice(&height.to_le_bytes());
        h[12..14].copy_from_slice(&1u16.to_le_bytes());
        h[14..16].copy_from_slice(&32u16.to_le_bytes());
        h[20..24].copy_from_slice(&(image_bytes as u32).to_le_bytes());
        h
    }
}

#[cfg(windows)]
mod grab {
    use super::{Rect, MAX_WINDOWS};
    use crate::i18n::tr;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetSystemMetrics, GetWindowLongW, IsIconic, IsWindowVisible, GWL_EXSTYLE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        WS_EX_TRANSPARENT,
    };

    pub struct Shot {
        pub x: i32,
        pub y: i32,
        pub width: u32,
        pub height: u32,
        pub pixels: Vec<u8>,
    }

    /// All monitors at once, in physical pixels (FORGE runs DPI aware per monitor).
    pub fn virtual_screen(_app: &tauri::AppHandle) -> Result<Shot, String> {
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if w <= 0 || h <= 0 {
                return Err(tr!("No screen found", "Kein Bildschirm gefunden"));
            }
            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err(tr!("Could not read the screen", "Bildschirm nicht lesbar"));
            }
            let mem = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bitmap);
            let copied = BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT) != 0;
            SelectObject(mem, old);
            let mut pixels = vec![0u8; w as usize * h as usize * 4];
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let lines = if copied { GetDIBits(mem, bitmap, 0, h as u32, pixels.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS) } else { 0 };
            DeleteObject(bitmap);
            DeleteDC(mem);
            ReleaseDC(null_mut(), screen);
            if lines != h {
                return Err(tr!("Could not read the screen", "Bildschirm nicht lesbar"));
            }
            // GDI leaves the fourth byte at 0; as alpha that would be fully transparent.
            for px in pixels.chunks_exact_mut(4) {
                px[3] = 255;
            }
            Ok(Shot { x, y, width: w as u32, height: h as u32, pixels })
        }
    }

    /// Visible top-level windows in screen pixels, front to back. The frame DWM draws (without the
    /// invisible resize border and shadow), so a window snip has no transparent margin.
    pub fn windows(_shot: &Shot) -> Vec<Rect> {
        let mut out: Vec<Rect> = Vec::new();
        unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> i32 {
            let out = &mut *(data as *mut Vec<Rect>);
            if out.len() >= MAX_WINDOWS {
                return 0;
            }
            if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TRANSPARENT != 0 {
                return 1;
            }
            let mut cloaked = 0u32;
            let size = std::mem::size_of::<u32>() as u32;
            if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, (&mut cloaked as *mut u32).cast(), size) == 0 && cloaked != 0 {
                return 1;
            }
            let mut r: RECT = std::mem::zeroed();
            if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, (&mut r as *mut RECT).cast(), std::mem::size_of::<RECT>() as u32) != 0 {
                return 1;
            }
            if r.right - r.left >= 8 && r.bottom - r.top >= 8 {
                out.push(Rect { x: r.left, y: r.top, width: (r.right - r.left) as u32, height: (r.bottom - r.top) as u32 });
            }
            1
        }
        unsafe {
            EnumWindows(Some(each), (&mut out as *mut Vec<Rect>) as LPARAM);
        }
        out
    }
}

#[cfg(not(windows))]
mod grab {
    use super::{overlaps, Rect, MAX_WINDOWS};
    use crate::i18n::tr;
    use tauri::AppHandle;
    use xcap::image::imageops::{self, FilterType};

    pub struct Shot {
        pub x: i32,
        pub y: i32,
        pub width: u32,
        pub height: u32,
        pub pixels: Vec<u8>,
        /// top-left corner of the captured monitor in xcap's units (points on macOS, pixels on X11)
        units: (i32, i32),
        /// physical pixels per xcap unit
        scale: f64,
    }

    fn failed(e: impl std::fmt::Display) -> String {
        if cfg!(target_os = "macos") {
            tr!(
                "Could not read the screen ({e}). Allow FORGE under System Settings > Privacy & Security > Screen Recording and restart FORGE.",
                "Bildschirm nicht lesbar ({e}). Erlaube FORGE unter Systemeinstellungen > Datenschutz und Sicherheit > Bildschirmaufnahme und starte FORGE neu."
            )
        } else {
            tr!("Could not read the screen: {e}", "Bildschirm nicht lesbar: {e}")
        }
    }

    /// The monitor under the cursor, in physical pixels like the overlay window is placed.
    pub fn virtual_screen(app: &AppHandle) -> Result<Shot, String> {
        let screens = xcap::Monitor::all().map_err(failed)?;
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten())
            .ok_or_else(|| tr!("No screen found", "Kein Bildschirm gefunden"))?;
        let (px, py) = (monitor.position().x, monitor.position().y);
        let logical = ((px as f64 / monitor.scale_factor()).round() as i32, (py as f64 / monitor.scale_factor()).round() as i32);
        // xcap counts in points on macOS (Tauri's logical position) and in pixels on X11 (Tauri's physical one).
        let screen = screens
            .into_iter()
            .min_by_key(|s| {
                let (x, y) = (s.x().unwrap_or(0), s.y().unwrap_or(0));
                ((x - logical.0).abs() + (y - logical.1).abs()).min((x - px).abs() + (y - py).abs())
            })
            .ok_or_else(|| tr!("No screen found", "Kein Bildschirm gefunden"))?;
        let image = screen.capture_image().map_err(failed)?;
        let (width, height) = (monitor.size().width, monitor.size().height);
        if width == 0 || height == 0 {
            return Err(tr!("No screen found", "Kein Bildschirm gefunden"));
        }
        let image = if image.width() != width || image.height() != height { imageops::resize(&image, width, height, FilterType::Triangle) } else { image };
        let scale = width as f64 / screen.width().ok().filter(|w| *w > 0).unwrap_or(width) as f64;
        let mut pixels = image.into_raw();
        for p in pixels.chunks_exact_mut(4) {
            p.swap(0, 2);
            p[3] = 255;
        }
        Ok(Shot { x: px, y: py, width, height, pixels, units: (screen.x().unwrap_or(0), screen.y().unwrap_or(0)), scale })
    }

    /// Visible windows on the captured monitor, front to back, in the frame's pixels.
    pub fn windows(shot: &Shot) -> Vec<Rect> {
        let Ok(mut all) = xcap::Window::all() else { return Vec::new() };
        // macOS lists them front to back already; X11 does not promise an order.
        if cfg!(target_os = "linux") {
            all.sort_by_key(|w| std::cmp::Reverse(w.z().unwrap_or(0)));
        }
        let area = Rect { x: shot.x, y: shot.y, width: shot.width, height: shot.height };
        let px = |v: i32, origin: i32| (v - origin) as f64 * shot.scale;
        let mut out = Vec::new();
        for w in all {
            if out.len() >= MAX_WINDOWS {
                break;
            }
            if w.is_minimized().unwrap_or(true) {
                continue;
            }
            // On macOS the menu bar, the Dock and the like are windows too.
            if matches!(w.app_name().as_deref(), Ok("Window Server" | "Dock" | "Control Center" | "Notification Center" | "Kontrollzentrum" | "Mitteilungszentrale")) {
                continue;
            }
            let (Ok(x), Ok(y), Ok(width), Ok(height)) = (w.x(), w.y(), w.width(), w.height()) else { continue };
            let r = Rect {
                x: shot.x + px(x, shot.units.0).round() as i32,
                y: shot.y + px(y, shot.units.1).round() as i32,
                width: (width as f64 * shot.scale).round() as u32,
                height: (height as f64 * shot.scale).round() as u32,
            };
            if r.width >= 8 && r.height >= 8 && overlaps(&r, &area) {
                out.push(r);
            }
        }
        out
    }
}

#[cfg(windows)]
mod clip {
    use crate::i18n::tr;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::CF_DIB;

    /// Puts the picture on the clipboard as a DIB, the format every Windows program can paste. Rows
    /// go from the bottom, which older programs expect.
    pub fn set(width: u32, height: u32, pixels: &[u8]) -> Result<(), String> {
        let header = super::bmp::info_header(width as i32, height as i32, pixels.len());
        let stride = width as usize * 4;
        unsafe {
            let mem = GlobalAlloc(GMEM_MOVEABLE, header.len() + pixels.len());
            if mem.is_null() {
                return Err(tr!("Not enough memory for the clipboard", "Kein Speicher für die Zwischenablage"));
            }
            let dst = GlobalLock(mem) as *mut u8;
            if dst.is_null() {
                GlobalFree(mem);
                return Err(tr!("Not enough memory for the clipboard", "Kein Speicher für die Zwischenablage"));
            }
            std::ptr::copy_nonoverlapping(header.as_ptr(), dst, header.len());
            for (i, row) in pixels.chunks_exact(stride).rev().enumerate() {
                std::ptr::copy_nonoverlapping(row.as_ptr(), dst.add(header.len() + i * stride), stride);
            }
            GlobalUnlock(mem);
            // Another program may hold the clipboard for a moment.
            let mut open = false;
            for _ in 0..10 {
                if OpenClipboard(null_mut()) != 0 {
                    open = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            if !open {
                GlobalFree(mem);
                return Err(tr!("Clipboard is in use", "Zwischenablage ist belegt"));
            }
            EmptyClipboard();
            let ok = !SetClipboardData(CF_DIB as u32, mem).is_null();
            CloseClipboard();
            if ok {
                Ok(())
            } else {
                GlobalFree(mem);
                Err(tr!("Could not write to the clipboard", "Zwischenablage nicht beschreibbar"))
            }
        }
    }
}

#[cfg(not(windows))]
mod clip {
    use crate::i18n::tr;

    /// On Linux the clipboard content is served by this process and goes away with the last instance.
    #[cfg(target_os = "linux")]
    static CLIPBOARD: std::sync::Mutex<Option<arboard::Clipboard>> = std::sync::Mutex::new(None);

    /// The picture as image on the clipboard; `pixels` are BGRA rows from the top.
    pub fn set(width: u32, height: u32, pixels: &[u8]) -> Result<(), String> {
        let mut rgba = pixels.to_vec();
        for p in rgba.chunks_exact_mut(4) {
            p.swap(0, 2);
        }
        let image = arboard::ImageData { width: width as usize, height: height as usize, bytes: rgba.into() };
        let unavailable = |e: arboard::Error| tr!("Could not write to the clipboard: {e}", "Zwischenablage nicht beschreibbar: {e}");
        #[cfg(target_os = "linux")]
        {
            let mut slot = CLIPBOARD.lock().unwrap_or_else(|e| e.into_inner());
            if slot.is_none() {
                *slot = Some(arboard::Clipboard::new().map_err(unavailable)?);
            }
            slot.as_mut().map(|c| c.set_image(image)).unwrap_or(Ok(())).map_err(unavailable)
        }
        #[cfg(not(target_os = "linux"))]
        arboard::Clipboard::new().and_then(|mut c| c.set_image(image)).map_err(unavailable)
    }
}

#[cfg(windows)]
mod hook {
    use super::{log, trigger, Trigger, ENABLED, KEY_TAKEN, OVERLAY_OPEN};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_HOTKEY_ALREADY_REGISTERED, INVALID_HANDLE_VALUE, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        GetCurrentThread, SetThreadInformation, SetThreadPriority, ThreadPowerThrottling, THREAD_POWER_THROTTLING_CURRENT_VERSION, THREAD_POWER_THROTTLING_EXECUTION_SPEED,
        THREAD_POWER_THROTTLING_STATE, THREAD_PRIORITY_TIME_CRITICAL,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT, VK_ESCAPE, VK_LWIN, VK_RETURN, VK_RWIN, VK_SNAPSHOT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL,
        WM_HOTKEY, WM_KEYDOWN, WM_SYSKEYDOWN, WM_TIMER,
    };

    /// Windows calls the newest low-level hook first. Screenshot tools started later (ShareX, Greenshot,
    /// Lightshot) would be in front of FORGE; renewing the hook every 2 s puts FORGE back in front, and also
    /// brings it back if Windows dropped it silently after a timeout.
    const RENEW_MS: u32 = 2_000;
    const HOTKEY_ID: i32 = 0x4647;

    /// Screenshot tools that register the Print key, the dedicated ones first. Dropbox and OneDrive
    /// do it when they are set to save screenshots.
    const TOOLS: [(&str, &str); 12] = [
        ("sharex.exe", "ShareX"),
        ("greenshot.exe", "Greenshot"),
        ("lightshot.exe", "Lightshot"),
        ("snagit32.exe", "Snagit"),
        ("snagiteditor.exe", "Snagit"),
        ("picpick.exe", "PicPick"),
        ("flameshot.exe", "Flameshot"),
        ("screenpresso.exe", "Screenpresso"),
        ("gyazo.exe", "Gyazo"),
        ("monosnap.exe", "Monosnap"),
        ("dropbox.exe", "Dropbox"),
        ("onedrive.exe", "OneDrive"),
    ];

    /// Print went down and its key up is still to come; some keyboards and remappers only send the key up.
    static PRINT_DOWN: AtomicBool = AtomicBool::new(false);

    unsafe fn set() -> HHOOK {
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), GetModuleHandleW(null_mut()), 0)
    }

    pub fn shortcut(_app: &tauri::AppHandle, _on: bool) -> Result<(), String> {
        Ok(())
    }

    fn taken(now: bool) {
        if KEY_TAKEN.swap(now, Ordering::SeqCst) != now {
            log(if now {
                format!("Druck-Taste ist auch bei einem anderen Programm registriert ({})", other_tool().unwrap_or("unbekannt"))
            } else {
                "Druck-Taste bei FORGE registriert".to_owned()
            });
        }
    }

    /// FORGE's own registration of the key, besides the hook. Windows skips the low-level hooks of normal
    /// programs while a window with administrator rights is in front, a registered key still arrives
    /// then; and tools started later cannot take it. Fails while another program (ShareX) holds the key,
    /// so it is tried again with every renewal.
    unsafe fn sync_hotkey(registered: &mut bool) {
        let want = ENABLED.load(Ordering::SeqCst);
        if want && !*registered {
            if RegisterHotKey(null_mut(), HOTKEY_ID, MOD_NOREPEAT, VK_SNAPSHOT as u32) != 0 {
                *registered = true;
                taken(false);
            } else if GetLastError() == ERROR_HOTKEY_ALREADY_REGISTERED {
                taken(true);
            }
        } else if !want && *registered {
            UnregisterHotKey(null_mut(), HOTKEY_ID);
            *registered = false;
        }
    }

    /// The running screenshot tool that most likely holds the key.
    pub fn other_tool() -> Option<&'static str> {
        let mut running = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut ok = Process32FirstW(snap, &mut entry) != 0;
            while ok {
                let len = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
                running.push(String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase());
                ok = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
        }
        TOOLS.iter().find(|(exe, _)| running.iter().any(|r| r == exe)).map(|(_, name)| *name)
    }

    /// The hook lives on its own thread with a message loop; Windows calls it there for every key.
    pub fn install(_app: &tauri::AppHandle) {
        std::thread::Builder::new()
            .name("forge-print-key".into())
            .spawn(|| unsafe {
                // Windows waits only briefly for a low-level hook; an answer that comes too late lets
                // the key through to other tools (ShareX) and gets the hook dropped. While FORGE starts
                // or captures, a thread of normal priority was late. Never slowed down for saving energy either.
                SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
                let no_throttling = THREAD_POWER_THROTTLING_STATE { Version: THREAD_POWER_THROTTLING_CURRENT_VERSION, ControlMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED, StateMask: 0 };
                SetThreadInformation(
                    GetCurrentThread(),
                    ThreadPowerThrottling,
                    (&no_throttling as *const THREAD_POWER_THROTTLING_STATE).cast(),
                    std::mem::size_of::<THREAD_POWER_THROTTLING_STATE>() as u32,
                );
                let mut hook = set();
                if hook.is_null() {
                    log(format!("Tastatur-Hook nicht gesetzt (Fehler {})", GetLastError()));
                } else {
                    log("Tastatur-Hook gesetzt");
                }
                let mut registered = false;
                sync_hotkey(&mut registered);
                // Without a window the timer posts WM_TIMER to this thread's queue, the hotkey WM_HOTKEY.
                SetTimer(null_mut(), 0, RENEW_MS, None);
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                    if msg.message == WM_HOTKEY {
                        // Only comes when the hook did not see the key; a swallowed key sends no WM_HOTKEY.
                        if msg.wParam == HOTKEY_ID as usize && ENABLED.load(Ordering::SeqCst) {
                            log("Druck über das Tastenkürzel, der Hook wurde nicht aufgerufen");
                            trigger(Trigger::Capture);
                        }
                        continue;
                    }
                    if msg.message != WM_TIMER {
                        continue;
                    }
                    sync_hotkey(&mut registered);
                    let fresh = set();
                    if fresh.is_null() {
                        continue;
                    }
                    if hook.is_null() {
                        log("Tastatur-Hook gesetzt");
                    } else {
                        UnhookWindowsHookEx(hook);
                    }
                    hook = fresh;
                }
            })
            .ok();
    }

    fn held(vk: u16) -> bool {
        unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
    }

    /// Has to return quickly, or Windows drops the hook: the work goes to the capture thread.
    unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == HC_ACTION as i32 {
            let k = &*(lparam as *const KBDLLHOOKSTRUCT);
            let down = wparam == WM_KEYDOWN as usize || wparam == WM_SYSKEYDOWN as usize;
            if k.vkCode == VK_SNAPSHOT as u32 {
                let enabled = ENABLED.load(Ordering::SeqCst);
                let alt = k.flags & LLKHF_ALTDOWN != 0;
                let win = held(VK_LWIN) || held(VK_RWIN);
                if down {
                    // How long after the key press Windows called the hook; from about 300 ms on it had already given up.
                    let late = GetTickCount().wrapping_sub(k.time);
                    log(format!("Druck gedrückt: an={enabled} alt={alt} win={win} eingespeist={} verzögert={late}ms", k.flags & LLKHF_INJECTED != 0));
                }
                if enabled && !alt && !win {
                    // Once per press: on the key down, or on the key up when no key down came.
                    // Down after up: a new press (repeats are skipped). Up without a down: the press.
                    if !PRINT_DOWN.swap(down, Ordering::SeqCst) {
                        trigger(Trigger::Capture);
                    }
                    // Key up is swallowed too: Windows and other tools act on it.
                    return 1;
                }
            }
            if OVERLAY_OPEN.load(Ordering::SeqCst) {
                let key = match k.vkCode as u16 {
                    VK_ESCAPE => Some("Escape"),
                    VK_RETURN => Some("Enter"),
                    _ => None,
                };
                if let Some(key) = key {
                    if down {
                        trigger(Trigger::Key(key));
                    }
                    return 1;
                }
            }
        }
        CallNextHookEx(null_mut(), code, wparam, lparam)
    }
}

#[cfg(not(windows))]
mod hook {
    use super::{log, trigger, Trigger, KEY_TAKEN};
    use crate::i18n::tr;
    use std::sync::atomic::Ordering;
    use tauri::{AppHandle, Manager};
    use tauri_plugin_global_shortcut::{Code, GlobalShortcut, Modifiers, Shortcut, ShortcutState};

    /// macOS keeps Cmd+Shift+3 to 6 for its own screenshots and its keyboards have no Print key; 2 is free.
    fn key() -> Shortcut {
        if cfg!(target_os = "macos") {
            Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Digit2)
        } else {
            Shortcut::new(None, Code::PrintScreen)
        }
    }

    pub fn install(app: &AppHandle) {
        let plugin = tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|_app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    trigger(Trigger::Capture);
                }
            })
            .build();
        if let Err(e) = app.plugin(plugin) {
            log(format!("Tastenkürzel nicht verfügbar: {e}"));
        }
    }

    /// Registers or releases the key; runs on the capture thread. Fails when another program has it,
    /// or under Wayland, which has no global shortcuts for programs.
    pub fn shortcut(app: &AppHandle, on: bool) -> Result<(), String> {
        let Some(shortcuts) = app.try_state::<GlobalShortcut<tauri::Wry>>() else {
            KEY_TAKEN.store(on, Ordering::SeqCst);
            return Err(tr!("Global shortcuts are not available", "Globale Tastenkürzel sind nicht verfügbar"));
        };
        if !on {
            KEY_TAKEN.store(false, Ordering::SeqCst);
            let _ = shortcuts.unregister(key());
            return Ok(());
        }
        if shortcuts.is_registered(key()) {
            return Ok(());
        }
        match shortcuts.register(key()) {
            Ok(()) => {
                KEY_TAKEN.store(false, Ordering::SeqCst);
                log("Tastenkürzel registriert");
                Ok(())
            }
            Err(e) => {
                KEY_TAKEN.store(true, Ordering::SeqCst);
                Err(format!("Tastenkürzel nicht registriert: {e}"))
            }
        }
    }

    pub fn other_tool() -> Option<&'static str> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turns_canvas_pixels_into_opaque_bitmap_pixels() {
        // red opaque, blue half transparent, fully transparent
        let rgba = [255, 0, 0, 255, 0, 0, 255, 128, 10, 20, 30, 0];
        assert_eq!(rgba_to_bgra(&rgba), vec![0, 0, 255, 255, 255, 127, 127, 255, 255, 255, 255, 255]);
    }

    #[test]
    fn keeps_only_monitors_that_touch_the_capture() {
        let shot = Rect { x: 0, y: 0, width: 1920, height: 1080 };
        assert!(overlaps(&Rect { x: -100, y: 500, width: 200, height: 10 }, &shot));
        assert!(!overlaps(&Rect { x: 1920, y: 0, width: 2560, height: 1440 }, &shot));
        assert!(!overlaps(&Rect { x: 0, y: -1080, width: 1920, height: 1080 }, &shot));
    }

    #[test]
    fn writes_a_top_down_bmp() {
        let pixels: Vec<u8> = (0..4u8).flat_map(|i| [i, 0, 0, 255]).collect();
        let file = bmp::file(2, 2, &pixels);
        assert_eq!(&file[0..2], b"BM");
        assert_eq!(u32::from_le_bytes(file[2..6].try_into().unwrap()) as usize, file.len());
        assert_eq!(i32::from_le_bytes(file[18..22].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(file[22..26].try_into().unwrap()), -2);
        assert_eq!(&file[54..], &pixels[..]);
    }
}
