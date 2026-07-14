use crate::crawler::downloader::compress;
use crate::storage::Storage;
use std::path::Path;

/// 把即将交给 Linux/Windows 原生壁纸后端的路径解析为桌面可渲染的路径。
/// 不兼容格式会惰性转码并把副本路径落库；任何错误均回退原始路径。
pub async fn ensure_native_wallpaper_path(file_path: &str) -> String {
    match resolve_native_wallpaper_path(file_path).await {
        Ok(path) => path,
        Err(e) => {
            eprintln!(
                "[wallpaper-compat] failed to resolve native wallpaper path ({}): {e}",
                file_path
            );
            file_path.to_string()
        }
    }
}

async fn resolve_native_wallpaper_path(file_path: &str) -> Result<String, String> {
    let Some(info) = Storage::find_image_by_path(file_path)? else {
        return Ok(file_path.to_string());
    };

    let storage = Storage::global();
    if let Some(path) = storage.get_image_wallpaper_compatible_path(&info.id)? {
        if Path::new(&path).exists() {
            return Ok(path);
        }
    }

    let source_path = Path::new(file_path);
    let mime = info
        .media_type
        .as_deref()
        .map(str::trim)
        .filter(|mime| !mime.is_empty())
        .map(str::to_owned)
        .or_else(|| crate::image_type::mime_type_from_path(source_path));
    if mime
        .as_deref()
        .is_some_and(crate::image_type::image_mime_native_wallpaper_safe)
    {
        return Ok(file_path.to_string());
    }

    let generated = compress::generate_wallpaper_compatible_image(source_path).await?;
    let generated_path = generated.to_string_lossy().into_owned();
    storage.replace_image_wallpaper_compatible_path(&info.id, &generated_path)?;
    Ok(generated_path)
}
