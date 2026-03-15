use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "android")]
use async_trait::async_trait;
#[cfg(target_os = "android")]
use std::sync::{Arc, OnceLock};

#[cfg(target_os = "android")]
use image::codecs::gif::{GifEncoder, Repeat};
#[cfg(target_os = "android")]
use image::{Delay, Frame as ImageFrame};
#[cfg(target_os = "android")]
use std::fs::File;
#[cfg(target_os = "android")]
use std::io::BufWriter;

/// 视频预览压缩结果。
pub struct VideoCompressResult {
    pub preview_path: PathBuf,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[cfg(target_os = "android")]
#[async_trait]
pub trait AndroidVideoCompressProvider: Send + Sync + 'static {
    async fn compress_video_for_preview(
        &self,
        input_path: &Path,
        output_path: &Path,
    ) -> Result<VideoCompressResult, String>;
}

#[cfg(target_os = "android")]
static ANDROID_VIDEO_COMPRESS_PROVIDER: OnceLock<Arc<dyn AndroidVideoCompressProvider>> =
    OnceLock::new();

#[cfg(target_os = "android")]
pub fn set_android_video_compress_provider(
    provider: Arc<dyn AndroidVideoCompressProvider>,
) -> Result<(), String> {
    ANDROID_VIDEO_COMPRESS_PROVIDER
        .set(provider)
        .map_err(|_| "Android video compress provider already initialized".to_string())
}

#[cfg(target_os = "android")]
fn get_android_video_compress_provider() -> Option<Arc<dyn AndroidVideoCompressProvider>> {
    ANDROID_VIDEO_COMPRESS_PROVIDER.get().cloned()
}

/// 将视频转换为用于列表/预览的小 mp4。
pub async fn compress_video_for_preview(input_path: &Path) -> Result<VideoCompressResult, String> {
    let thumbnails_dir = crate::app_paths::AppPaths::global().thumbnails_dir();
    tokio::fs::create_dir_all(&thumbnails_dir)
        .await
        .map_err(|e| format!("Failed to create thumbnails directory: {e}"))?;

    #[cfg(target_os = "android")]
    let out_path = thumbnails_dir.join(format!("{}.gif", uuid::Uuid::new_v4()));
    #[cfg(not(target_os = "android"))]
    let out_path = thumbnails_dir.join(format!("{}.mp4", uuid::Uuid::new_v4()));

    #[cfg(target_os = "android")]
    {
        if let Some(provider) = get_android_video_compress_provider() {
            return provider
                .compress_video_for_preview(input_path, &out_path)
                .await;
        }

        // 安卓兜底：若压缩插件未注册，则先拷贝原视频，避免下载链路中断。
        tokio::fs::copy(input_path, &out_path)
            .await
            .map_err(|e| format!("Android fallback copy failed: {e}"))?;
        return Ok(VideoCompressResult {
            preview_path: out_path,
            width: None,
            height: None,
        });
    }

    #[cfg(not(target_os = "android"))]
    {
        let in_path = input_path.to_path_buf();
        let out_path_for_task = out_path.clone();
        tokio::task::spawn_blocking(move || {
            run_ffmpeg_sidecar(&in_path, &out_path_for_task)?;
            Ok::<(), String>(())
        })
        .await
        .map_err(|e| format!("Video compress task join error: {e}"))??;

        Ok(VideoCompressResult {
            preview_path: out_path,
            width: None,
            height: None,
        })
    }
}

#[cfg(not(target_os = "android"))]
fn run_ffmpeg_sidecar(input_path: &Path, output_path: &Path) -> Result<(), String> {
    let ffmpeg_path = resolve_ffmpeg_sidecar_path()?;
    let mut cmd = std::process::Command::new(&ffmpeg_path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: 不弹出黑色控制台窗口
    let status = cmd
        .arg("-y")
        .arg("-i")
        .arg(input_path)
        .arg("-vf")
        .arg("scale='min(1280,iw)':-2")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("veryfast")
        .arg("-crf")
        .arg("30")
        .arg("-movflags")
        .arg("+faststart")
        .arg("-an")
        .arg("-f")
        .arg("mov")
        .arg(output_path)
        .status()
        .map_err(|e| format!("Failed to run ffmpeg sidecar: {e}"))?;
    if !status.success() {
        return Err(format!(
            "ffmpeg sidecar exited with non-zero status: {status}"
        ));
    }
    Ok(())
}

/// 解析 ffmpeg sidecar 路径。Tauri externalBin 会将二进制复制到与主程序同目录，且去掉 target triple 后缀，故运行时名为 `ffmpeg` 或 `ffmpeg.exe`。
#[cfg(not(target_os = "android"))]
fn resolve_ffmpeg_sidecar_path() -> Result<PathBuf, String> {
    let app_paths = crate::app_paths::AppPaths::global();
    let exe_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    // 1. 与主程序同目录（Tauri externalBin 复制目标）
    if let Some(exe_dir) = app_paths.exe_dir() {
        let p = exe_dir.join(exe_name);
        if p.is_file() {
            return Ok(p);
        }
    }

    // 2. 开发时：仅执行过 build-ffmpeg.sh、未 cargo build 时，二进制在 sidecar/ 下且带 target triple 名
    if let Some(repo_root) = crate::app_paths::repo_root_dir() {
        let sidecar_dir = repo_root
            .join("src-tauri")
            .join("app-main")
            .join("sidecar");
        if let Ok(rd) = std::fs::read_dir(&sidecar_dir) {
            for e in rd.flatten() {
                let name = e.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("ffmpeg-") && (name_str.ends_with(".exe") || !name_str.contains('.')) {
                    let path = e.path();
                    if path.is_file() {
                        return Ok(path);
                    }
                }
            }
        }
    }

    Err(format!(
        "ffmpeg sidecar not found. Run `bun run build:ffmpeg` and ensure `externalBin` is set in tauri.conf (non-light mode)."
    ))
}

/// 将目录下 frame_000.png, frame_001.png, ... 编码为动图 GIF（4fps），仅 Android 使用。
#[cfg(target_os = "android")]
pub fn encode_frames_dir_to_gif(frame_dir: &Path, output_path: &Path) -> Result<(), String> {
    let mut entries: Vec<_> = std::fs::read_dir(frame_dir)
        .map_err(|e| format!("读取帧目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|x| x.eq_ignore_ascii_case("png"))
                .unwrap_or(false)
                && e.file_name()
                    .to_string_lossy()
                    .starts_with("frame_")
        })
        .collect();
    entries.sort_by_key(|e| e.file_name());
    if entries.is_empty() {
        return Err("帧目录下没有 frame_*.png".to_string());
    }

    // 4fps = 250ms 每帧
    let delay = Delay::from_numer_denom_ms(250, 1);

    let out_file = File::create(output_path).map_err(|e| format!("创建 GIF 文件失败: {e}"))?;
    let mut encoder = GifEncoder::new_with_speed(BufWriter::new(out_file), 10);
    encoder
        .set_repeat(Repeat::Infinite)
        .map_err(|e| format!("set_repeat 失败: {e}"))?;

    for entry in entries {
        let path = entry.path();
        let img = image::open(&path).map_err(|e| format!("加载帧 {} 失败: {e}", path.display()))?;
        let rgba = img.to_rgba8();
        let frame = ImageFrame::from_parts(rgba, 0, 0, delay);
        encoder
            .encode_frame(frame)
            .map_err(|e| format!("编码帧 {} 失败: {e}", path.display()))?;
    }

    Ok(())
}
