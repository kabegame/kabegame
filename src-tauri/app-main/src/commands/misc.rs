// 杂项命令

use serde::Serialize;
use std::fs;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDropSupportedTypes {
    archive_extensions: Vec<String>,
    plugin_extensions: Vec<String>,
}

#[tauri::command]
pub async fn get_file_drop_supported_types() -> Result<serde_json::Value, String> {
    let payload = FileDropSupportedTypes {
        archive_extensions: kabegame_core::archive::supported_types(),
        plugin_extensions: vec!["kgpg".to_string()],
    };
    Ok(serde_json::to_value(payload).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub async fn clear_user_data(app: AppHandle) -> Result<(), String> {
    let app_data_dir = kabegame_core::app_paths::kabegame_data_dir();

    if !app_data_dir.exists() {
        return Ok(()); // 目录不存在，无需清理
    }

    // 方案：创建清理标记文件，在应用重启后清理
    // 这样可以避免删除正在使用的文件
    let cleanup_marker = app_data_dir.join(".cleanup_marker");
    fs::write(&cleanup_marker, "1")
        .map_err(|e| format!("Failed to create cleanup marker: {}", e))?;

    // 延迟重启，确保响应已发送
    tokio::spawn(async move {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        app.restart();
    });

    Ok(())
}

#[tauri::command]
pub async fn start_dedupe_gallery_by_hash_batched(delete_files: bool) -> Result<(), String> {
    let ctx = crate::ipc::handlers::Store::global();
    ctx.dedupe_service
        .clone()
        .start_batched(
            std::sync::Arc::new(kabegame_core::storage::Storage::global().clone()),
            delete_files,
            10_000,
        )
        .await
}

#[tauri::command]
pub async fn cancel_dedupe_gallery_by_hash_batched() -> Result<bool, String> {
    let ctx = crate::ipc::handlers::Store::global();
    ctx.dedupe_service.cancel()
}

#[tauri::command]
pub async fn get_gallery_image(image_path: String) -> Result<Vec<u8>, String> {
    use std::path::Path;

    let path = Path::new(&image_path);
    if !path.exists() {
        return Err(format!("Image file not found: {}", image_path));
    }

    fs::read(&path).map_err(|e| format!("Failed to read image file: {}", e))
}

#[tauri::command]
pub async fn copy_image_to_clipboard(image_path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || {
            use std::path::Path;
            use windows_sys::Win32::Foundation::BOOL;
            use windows_sys::Win32::Graphics::Gdi::{BITMAPV5HEADER, BI_BITFIELDS};
            use windows_sys::Win32::System::DataExchange::{
                CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW,
                SetClipboardData,
            };
            use windows_sys::Win32::System::Memory::{
                GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
            };

            const LCS_SRGB: u32 = 0x7352_4742;
            const CF_DIBV5: u32 = 17;

            let path = Path::new(&image_path);
            if !path.exists() {
                return Err(format!("Image file not found: {}", image_path));
            }

            let bytes = fs::read(&path).map_err(|e| format!("Failed to read image file: {}", e))?;

            fn wide_null(s: &str) -> Vec<u16> {
                let mut v: Vec<u16> = s.encode_utf16().collect();
                v.push(0);
                v
            }

            unsafe fn set_clipboard_bytes(format: u32, data: &[u8]) -> Result<(), String> {
                if data.is_empty() {
                    return Ok(());
                }
                let size = data.len();
                let h = GlobalAlloc(GMEM_MOVEABLE, size);
                if h.is_null() {
                    return Err("GlobalAlloc failed".to_string());
                }
                let ptr = GlobalLock(h) as *mut u8;
                if ptr.is_null() {
                    return Err("GlobalLock failed".to_string());
                }
                std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, size);
                let _ = GlobalUnlock(h);
                if SetClipboardData(format, h as isize) == 0 {
                    return Err("SetClipboardData failed".to_string());
                }
                Ok(())
            }

            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();

            let extra_formats: &[&str] = if ext == "png" {
                &["PNG", "image/png"]
            } else if ext == "jpg" || ext == "jpeg" {
                &["JFIF", "image/jpeg"]
            } else {
                &[]
            };

            let dib_bytes: Option<Vec<u8>> = match image::load_from_memory(&bytes) {
                Ok(img) => {
                    let rgba = img.to_rgba8();
                    let w = rgba.width() as i32;
                    let h = rgba.height() as i32;
                    let pixel_bytes_len = (w as usize).saturating_mul(h as usize).saturating_mul(4);

                    if w <= 0
                        || h <= 0
                        || pixel_bytes_len == 0
                        || pixel_bytes_len > 256 * 1024 * 1024
                    {
                        None
                    } else {
                        let mut bgra = rgba.into_raw();
                        for px in bgra.chunks_exact_mut(4) {
                            let r = px[0];
                            let b = px[2];
                            px[0] = b;
                            px[2] = r;
                        }

                        let header = BITMAPV5HEADER {
                            bV5Size: std::mem::size_of::<BITMAPV5HEADER>() as u32,
                            bV5Width: w,
                            bV5Height: -h,
                            bV5Planes: 1,
                            bV5BitCount: 32,
                            bV5Compression: BI_BITFIELDS,
                            bV5SizeImage: pixel_bytes_len as u32,
                            bV5RedMask: 0x00FF0000,
                            bV5GreenMask: 0x0000FF00,
                            bV5BlueMask: 0x000000FF,
                            bV5AlphaMask: 0xFF000000,
                            bV5CSType: LCS_SRGB,
                            ..unsafe { std::mem::zeroed() }
                        };

                        let mut out =
                            Vec::with_capacity(std::mem::size_of::<BITMAPV5HEADER>() + bgra.len());
                        out.extend_from_slice(unsafe {
                            std::slice::from_raw_parts(
                                (&header as *const BITMAPV5HEADER) as *const u8,
                                std::mem::size_of::<BITMAPV5HEADER>(),
                            )
                        });
                        out.extend_from_slice(&bgra);
                        Some(out)
                    }
                }
                Err(_) => None,
            };

            unsafe {
                let mut opened: BOOL = 0;
                for _ in 0..8 {
                    opened = OpenClipboard(0);
                    if opened != 0 {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(15));
                }
                if opened == 0 {
                    return Err("OpenClipboard failed".to_string());
                }

                let _ = EmptyClipboard();

                for name in extra_formats {
                    let w = wide_null(name);
                    let fmt = RegisterClipboardFormatW(w.as_ptr());
                    if fmt != 0 {
                        let _ = set_clipboard_bytes(fmt, &bytes);
                    }
                }
                if let Some(dib) = dib_bytes {
                    let _ = set_clipboard_bytes(CF_DIBV5, &dib);
                }

                CloseClipboard();
            }

            Ok(())
        })
        .await
        .map_err(|e| format!("copy_image_to_clipboard join error: {e}"))?
    }

    #[cfg(target_os = "macos")]
    {
        // Tauri 命令默认在主线程上执行，可以直接使用 NSPasteboard
        use std::path::Path;
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::{NSData, NSString};

        let path = Path::new(&image_path);
        if !path.exists() {
            return Err(format!("Image file not found: {}", image_path));
        }

        let bytes = fs::read(&path).map_err(|e| format!("Failed to read image file: {}", e))?;

        unsafe {
            let pasteboard = NSPasteboard::generalPasteboard();

            // 清空剪贴板
            pasteboard.clearContents();

            // 根据文件扩展名确定类型
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();

            let type_str = if ext == "png" {
                "public.png"
            } else if ext == "jpg" || ext == "jpeg" {
                "public.jpeg"
            } else if ext == "gif" {
                "com.compuserve.gif"
            } else if ext == "tiff" || ext == "tif" {
                "public.tiff"
            } else {
                // 默认使用 PNG，或者尝试从文件内容判断
                "public.png"
            };

            let type_nsstring = NSString::from_str(type_str);
            let data = NSData::from_vec(bytes);

            let success = pasteboard.setData_forType(Some(&*data), &*type_nsstring);

            if success {
                Ok(())
            } else {
                Err("Failed to set clipboard data".to_string())
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = image_path;
        Err("copy_image_to_clipboard is only supported on Windows and macOS".to_string())
    }
}

#[tauri::command]
#[cfg(target_os = "linux")]
pub async fn read_file(path: String) -> tauri::ipc::Response {
  let data = tokio::fs::read(path).await.unwrap();
  tauri::ipc::Response::new(data)
}