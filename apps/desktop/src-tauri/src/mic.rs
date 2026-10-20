//! Microphone access for dictation. macOS asks once per app and afterwards answers getUserMedia with
//! a silent denial, so FORGE asks AVFoundation itself and, when the user wants to be asked again,
//! resets its own old decision first. WebKitGTK denies every media request nobody answers.

#![cfg_attr(not(target_os = "macos"), allow(unused_variables))]

/// "granted", "denied" or "restricted" (blocked by a profile, the user cannot change it).
#[tauri::command]
pub async fn mic_access(app: tauri::AppHandle, ask_again: bool) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return Ok(mac::access(&app.config().identifier, ask_again).await.to_owned());
    #[cfg(not(target_os = "macos"))]
    Ok("granted".to_owned())
}

/// The microphone page of the privacy settings.
#[tauri::command]
pub fn mic_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Lets the window's pages use the microphone; video and screen requests keep WebKitGTK's denial.
#[cfg(target_os = "linux")]
pub fn allow_in(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|w| {
        use webkit2gtk::glib::object::Cast;
        use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt, WebViewExt};
        w.inner().connect_permission_request(|_, request| match request.downcast_ref::<UserMediaPermissionRequest>() {
            Some(media) if media.is_for_audio_device() && !media.is_for_video_device() => {
                request.allow();
                true
            }
            _ => false,
        });
    });
}

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    pub async fn access(bundle_id: &str, ask_again: bool) -> &'static str {
        let mut current = status();
        if ask_again && current == AVAuthorizationStatus::Denied {
            // Clears only FORGE's own entry; macOS then shows its question again.
            let reset = std::process::Command::new("/usr/bin/tccutil").args(["reset", "Microphone", bundle_id]).status();
            if reset.is_ok_and(|s| s.success()) {
                current = status();
            }
        }
        if current == AVAuthorizationStatus::NotDetermined {
            current = if request().await { AVAuthorizationStatus::Authorized } else { AVAuthorizationStatus::Denied };
        }
        match current {
            AVAuthorizationStatus::Authorized => "granted",
            AVAuthorizationStatus::Restricted => "restricted",
            _ => "denied",
        }
    }

    fn status() -> AVAuthorizationStatus {
        match unsafe { AVMediaTypeAudio } {
            Some(audio) => unsafe { AVCaptureDevice::authorizationStatusForMediaType(audio) },
            None => AVAuthorizationStatus::Authorized,
        }
    }

    /// Shows the system question and waits for the answer.
    async fn request() -> bool {
        // The block and the media type are not Send: they must be gone before the await.
        let answer = {
            let Some(audio) = (unsafe { AVMediaTypeAudio }) else { return true };
            let (tx, rx) = std::sync::mpsc::channel();
            let handler = RcBlock::new(move |granted: Bool| {
                let _ = tx.send(granted.as_bool());
            });
            unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &handler) };
            rx
        };
        tauri::async_runtime::spawn_blocking(move || answer.recv().unwrap_or(false)).await.unwrap_or(false)
    }
}
