//! The Print key while FORGE runs: FORGE's snipping tool instead of the one of Windows. A low-level
//! keyboard hook swallows the key, the whole virtual screen is captured at once (the frozen picture
//! the user selects and marks on), and an overlay window over all monitors does the rest. What the
//! user takes goes to the clipboard like with Windows, and to the composer of the FORGE window used last.
//!
//! Alt+Print and Win+Print stay with Windows (active window, save to file).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

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
/// More are not worth hovering over; the list is in z-order, the front ones come first.
const MAX_WINDOWS: usize = 300;

/// Setting "Druck-Taste für Screenshots"; the main window hands it over once settings are loaded.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// From the capture until the overlay is hidden again.
static OVERLAY_OPEN: AtomicBool = AtomicBool::new(false);
static TRIGGER: OnceLock<Sender<Trigger>> = OnceLock::new();

enum Trigger {
    Capture,
    Key(&'static str),
    Prepare,
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
    let app = app.clone();
    let log = app.path().app_log_dir().ok().map(|d| d.join(LOG_FILE));
    std::thread::Builder::new()
        .name("forge-screenshot".into())
        .spawn(move || {
            let mut log = log.and_then(|p| open_log(&p));
            for t in rx {
                let done = match t {
                    Trigger::Capture => capture(&app),
                    Trigger::Prepare => overlay(&app).map(|_| ()),
                    Trigger::Key(key) => app.emit_to(OVERLAY, KEY, key).map_err(|e| e.to_string()),
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
    hook::install();
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
    let shot = grab::virtual_screen()?;
    let origin = (shot.x, shot.y);
    let relative = |r: Rect| Rect { x: r.x - origin.0, y: r.y - origin.1, ..r };
    let monitors = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| relative(Rect { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height }))
        .collect();
    let windows = grab::windows().into_iter().map(relative).collect();
    let cursor = app.cursor_position().map(|c| (c.x.round() as i32 - origin.0, c.y.round() as i32 - origin.1)).unwrap_or((0, 0));
    let state = app.state::<Screenshots>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let info = FrameInfo { id, width: shot.width, height: shot.height, monitors, windows, cursor_x: cursor.0, cursor_y: cursor.1 };
    *state.frame.lock().unwrap() = Some(Frame { id, origin, width: shot.width, height: shot.height, pixels: shot.pixels, info: info.clone() });
    OVERLAY_OPEN.store(true, Ordering::SeqCst);
    place(&w, origin, shot.width, shot.height);
    // The overlay shows itself once it has drawn the picture (screenshot_ready), so nothing blank flashes up.
    // A page still loading asks for the frame itself (screenshot_frame).
    w.emit_to(OVERLAY, FRAME, info).map_err(|e| e.to_string())
}

/// Over the whole virtual screen, in physical pixels like the capture.
fn place(w: &tauri::WebviewWindow, origin: (i32, i32), width: u32, height: u32) {
    let _ = w.set_position(PhysicalPosition::new(origin.0, origin.1));
    let _ = w.set_size(PhysicalSize::new(width, height));
}

fn hide(app: &AppHandle) {
    OVERLAY_OPEN.store(false, Ordering::SeqCst);
    app.state::<Screenshots>().frame.lock().unwrap().take();
    if let Some(w) = app.get_webview_window(OVERLAY) {
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
    }
    if on {
        trigger(Trigger::Prepare);
    }
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
    let f = frame.as_ref().filter(|f| f.id == id).ok_or("Aufnahme nicht mehr vorhanden")?;
    Ok(Response::new(bmp::file(f.width, f.height, &f.pixels)))
}

/// The overlay has drawn the picture of this capture: now it may cover the screen.
#[tauri::command]
pub fn screenshot_ready(app: AppHandle, id: u64) {
    let state = app.state::<Screenshots>();
    let frame = state.frame.lock().unwrap();
    let Some(f) = frame.as_ref().filter(|f| f.id == id) else { return };
    if let Some(w) = app.get_webview_window(OVERLAY) {
        place(&w, f.origin, f.width, f.height);
        let _ = w.show();
        // A window spanning monitors with different scaling can be resized by Windows once shown.
        place(&w, f.origin, f.width, f.height);
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
        return Err("Ungültige Bildgröße".into());
    };
    let InvokeBody::Raw(rgba) = request.body() else {
        return Err("Bild fehlt".into());
    };
    if rgba.len() != width as usize * height as usize * 4 {
        return Err("Bild passt nicht zur Größe".into());
    }
    let pixels = rgba_to_bgra(rgba);
    hide(&app);
    let clipboard = clip::set_dib(width, height, &pixels);
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
            Err("Screenshot nicht mehr vorhanden".into())
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
    pub fn virtual_screen() -> Result<Shot, String> {
        unsafe {
            let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            if w <= 0 || h <= 0 {
                return Err("Kein Bildschirm gefunden".into());
            }
            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err("Bildschirm nicht lesbar".into());
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
                return Err("Bildschirm nicht lesbar".into());
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
    pub fn windows() -> Vec<Rect> {
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
    pub struct Shot {
        pub x: i32,
        pub y: i32,
        pub width: u32,
        pub height: u32,
        pub pixels: Vec<u8>,
    }
    pub fn virtual_screen() -> Result<Shot, String> {
        Err("Screenshots gibt es nur unter Windows".into())
    }
    pub fn windows() -> Vec<super::Rect> {
        Vec::new()
    }
}

#[cfg(windows)]
mod clip {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::CF_DIB;

    /// Puts the picture on the clipboard as a DIB, the format every Windows program can paste. Rows
    /// go from the bottom, which older programs expect.
    pub fn set_dib(width: u32, height: u32, pixels: &[u8]) -> Result<(), String> {
        let header = super::bmp::info_header(width as i32, height as i32, pixels.len());
        let stride = width as usize * 4;
        unsafe {
            let mem = GlobalAlloc(GMEM_MOVEABLE, header.len() + pixels.len());
            if mem.is_null() {
                return Err("Kein Speicher für die Zwischenablage".into());
            }
            let dst = GlobalLock(mem) as *mut u8;
            if dst.is_null() {
                GlobalFree(mem);
                return Err("Kein Speicher für die Zwischenablage".into());
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
                return Err("Zwischenablage ist belegt".into());
            }
            EmptyClipboard();
            let ok = !SetClipboardData(CF_DIB as u32, mem).is_null();
            CloseClipboard();
            if ok {
                Ok(())
            } else {
                GlobalFree(mem);
                Err("Zwischenablage nicht beschreibbar".into())
            }
        }
    }
}

#[cfg(not(windows))]
mod clip {
    pub fn set_dib(_width: u32, _height: u32, _pixels: &[u8]) -> Result<(), String> {
        Err("Zwischenablage nur unter Windows".into())
    }
}

#[cfg(windows)]
mod hook {
    use super::{log, trigger, Trigger, ENABLED, OVERLAY_OPEN};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{GetLastError, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LWIN, VK_RETURN, VK_RWIN, VK_SNAPSHOT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetMessageW, SetTimer, SetWindowsHookExW, UnhookWindowsHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, LLKHF_ALTDOWN, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL,
        WM_KEYDOWN, WM_SYSKEYDOWN, WM_TIMER,
    };

    /// Windows calls the newest low-level hook first. Screenshot tools started later (ShareX, Greenshot,
    /// Lightshot) would be in front of FORGE; renewing the hook puts FORGE back in front, and also
    /// brings it back if Windows dropped it silently after a timeout.
    const RENEW_MS: u32 = 5_000;

    /// Print went down and its key up is still to come; some keyboards and remappers only send the key up.
    static PRINT_DOWN: AtomicBool = AtomicBool::new(false);

    unsafe fn set() -> HHOOK {
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), GetModuleHandleW(null_mut()), 0)
    }

    /// The hook lives on its own thread with a message loop; Windows calls it there for every key.
    pub fn install() {
        std::thread::Builder::new()
            .name("forge-print-key".into())
            .spawn(|| unsafe {
                let mut hook = set();
                if hook.is_null() {
                    log(format!("Tastatur-Hook nicht gesetzt (Fehler {})", GetLastError()));
                } else {
                    log("Tastatur-Hook gesetzt");
                }
                // Without a window the timer posts WM_TIMER to this thread's queue.
                SetTimer(null_mut(), 0, RENEW_MS, None);
                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
                    if msg.message != WM_TIMER {
                        continue;
                    }
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
                    log(format!(
                        "Druck gedrückt: an={enabled} alt={alt} win={win} eingespeist={}",
                        k.flags & LLKHF_INJECTED != 0
                    ));
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
    pub fn install() {}
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
