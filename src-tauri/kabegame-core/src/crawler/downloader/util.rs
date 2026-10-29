use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;
use url::Url;
/// 在阻塞线程中计算文件 SHA256，使用大缓冲区顺序读，避免 tokio 小缓冲 + 多次 await 的开销。
pub async fn compute_file_hash(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to open file for hash: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file
            .read(&mut buffer)
            .await
            .map_err(|e| format!("Failed to read file for hash: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[allow(dead_code)]
pub fn compute_bytes_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

pub const MAX_SAFE_FILENAME_LEN: usize = 180;

/// 将字符串裁剪到不超过 `max_len` 字节。`max_len` 是**字节**预算(多数文件系统按字节
/// 限制文件名长度,如 ext4/APFS 的 255 字节),但裁剪点会回退到最近的 UTF-8 字符边界,
/// 避免把一个多字节字符(如中文)截断成非法 UTF-8。
pub fn clamp_utf8_len(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    let mut end = max_len;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

pub fn is_windows_reserved_device_name(stem: &str) -> bool {
    let u = stem
        .trim()
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    if matches!(u.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if (u.starts_with("COM") || u.starts_with("LPT")) && u.len() == 4 {
        return matches!(
            u.chars().nth(3),
            Some('1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9')
        );
    }
    false
}

/// 跨平台文件名非法字符:Windows 保留的 `< > : " / \ | ? *`、路径分隔符,以及任意控制字符
/// (含 Unicode 控制字符)。其余字符——包括中文、日文假名、韩文、重音拉丁等——一律保留,
/// 因此生成的文件名可以宽松地承载多语言标题,同时在 Windows/macOS/Linux 上都合法。
fn is_forbidden_filename_char(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control()
}

pub fn sanitize_stem_for_filename(stem: &str) -> String {
    let mut out: String = stem
        .chars()
        .map(|c| {
            if is_forbidden_filename_char(c) {
                '_'
            } else {
                c
            }
        })
        .collect();

    while out.contains("  ") {
        out = out.replace("  ", " ");
    }

    let out = out.trim().trim_end_matches([' ', '.']).to_string();

    let mut out = if out.is_empty() {
        "image".to_string()
    } else {
        out
    };
    if is_windows_reserved_device_name(&out) {
        out = format!("_{}", out);
    }
    out
}

/// 计算页面自发原生下载在任务 `tmp` 挂载下的固定相对路径。
pub fn page_download_rel_path(url: &Url, suggested_name: Option<&str>) -> String {
    let raw_name = suggested_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            url.path_segments()
                .and_then(|segments| segments.filter(|segment| !segment.is_empty()).last())
        })
        .unwrap_or("download");
    let path = Path::new(raw_name);
    let stem = sanitize_stem_for_filename(
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("download"),
    );
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(sanitize_stem_for_filename);
    let safe_name = if let Some(extension) = extension {
        let reserve = 1 + extension.len();
        let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
        format!("{}.{}", clamp_utf8_len(&stem, stem_max), extension)
    } else {
        clamp_utf8_len(&stem, MAX_SAFE_FILENAME_LEN).to_string()
    };

    let mut hasher = Sha256::new();
    hasher.update(url.as_str().as_bytes());
    let url_hash = format!("{:x}", hasher.finalize());
    format!("Downloads/{}-{}", &url_hash[..16], safe_name)
}

pub fn normalize_ext(ext: &str, fallback_ext: &str) -> String {
    let e = ext.trim().trim_start_matches('.').trim();
    let e = if e.is_empty() { fallback_ext.trim() } else { e };
    let e = e.trim().trim_start_matches('.').trim();
    if e.is_empty() {
        crate::media::image_type::default_image_extension().to_string()
    } else {
        e.to_ascii_lowercase()
    }
}

pub fn build_safe_filename(hint_filename: &str, fallback_ext: &str) -> String {
    let path = Path::new(hint_filename);
    let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let raw_ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

    let ext = if crate::media::image_type::is_supported_media_ext(raw_ext)
        && !fallback_ext.trim().trim_start_matches('.').is_empty()
    {
        normalize_ext(
            fallback_ext,
            crate::media::image_type::default_image_extension(),
        )
    } else {
        normalize_ext(raw_ext, fallback_ext)
    };
    let stem = sanitize_stem_for_filename(raw_stem);

    let reserve = 1 + ext.len();
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);

    format!("{}.{}", stem_final, ext)
}

/// 生成无扩展名的安全文件名。仅桌面端在 URL 无扩展名时使用，不添加默认扩展名。
pub fn build_safe_filename_no_ext(hint_filename: &str) -> String {
    let path = Path::new(hint_filename);
    let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let stem = sanitize_stem_for_filename(raw_stem);
    let stem_max = MAX_SAFE_FILENAME_LEN.max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);
    stem_final.to_string()
}

fn build_safe_custom_filename(hint_name: &str, ext: Option<&str>) -> String {
    let hint_name = hint_name.replace(['/', '\\'], "_");
    let Some(ext) = ext.filter(|value| !value.trim().trim_start_matches('.').is_empty()) else {
        let stem = sanitize_stem_for_filename(&hint_name);
        let stem_max = MAX_SAFE_FILENAME_LEN.max(1);
        let stem_final = clamp_utf8_len(&stem, stem_max);
        return stem_final.to_string();
    };

    let ext = normalize_ext(ext, crate::media::image_type::default_image_extension());
    let suffix = format!(".{ext}");
    let raw_stem = hint_name
        .strip_suffix(&suffix)
        .or_else(|| {
            let lower = hint_name.to_ascii_lowercase();
            lower
                .strip_suffix(&suffix)
                .map(|stem| &hint_name[..stem.len()])
        })
        .or_else(|| {
            let path = Path::new(&hint_name);
            let hint_ext = path.extension().and_then(|value| value.to_str())?;
            if crate::media::image_type::is_supported_media_ext(hint_ext) {
                path.file_stem().and_then(|value| value.to_str())
            } else {
                None
            }
        })
        .unwrap_or(hint_name.as_str());
    let stem = sanitize_stem_for_filename(raw_stem);
    let reserve = 1 + ext.len();
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);
    format!("{}.{}", stem_final, ext)
}

/// 第 `idx` 个候选文件名：`idx == 0` 为原名，之后依次为 `stem(1).ext`、`stem(2).ext`……
/// 带后缀时按 [`MAX_SAFE_FILENAME_LEN`] 重新裁剪 stem，保证整个文件名不超长。
fn candidate_filename(filename: &str, idx: usize) -> String {
    if idx == 0 {
        return filename.to_string();
    }
    let path = Path::new(filename);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let suffix = format!("({})", idx);
    let (stem_max, ext_part) = if ext.is_empty() {
        (
            MAX_SAFE_FILENAME_LEN.saturating_sub(suffix.len()).max(1),
            String::new(),
        )
    } else {
        (
            MAX_SAFE_FILENAME_LEN
                .saturating_sub(suffix.len() + 1 + ext.len())
                .max(1),
            format!(".{}", ext),
        )
    };
    let stem_final = clamp_utf8_len(stem, stem_max);
    format!("{}{}{}", stem_final, suffix, ext_part)
}

/// 已占坑的下载目标文件。
///
/// 文件在目标目录以独占方式创建（`create_new` / `link` 的 `EEXIST` 判重），并自出现在目标名起
/// 就带着原生占用标记：
/// - Unix：持有 `flock` 排他锁。建议锁不影响其它句柄读写（缩略图、尺寸读取照常），
///   只用于被 [`is_occupied_for_download`] 探测。
/// - Windows：以只共享读（不共享写 / 删除）的 share mode 打开。其它句柄可读，
///   以写方式打开会得到 `ERROR_SHARING_VIOLATION`，探测即据此判断。因此**写入必须经本句柄**
///   （[`OccupiedFile::write_all`] / [`OccupiedFile::copy_from`]），删除该文件前也必须先 drop。
///
/// 本地文件夹同步在给新文件建图片行之前先探测标记，命中就放弃导入，避免与下载流程
/// 抢同一个 `local_path`（`images.local_path` 有唯一索引）。标记随 `OccupiedFile` drop 解除，
/// 因此调用方必须持有到图片行写入完成（成功或失败）。
pub struct OccupiedFile {
    path: PathBuf,
    file: File,
    moved: bool,
}

impl OccupiedFile {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `true` 表示 `move_from` 的源文件已经以零拷贝方式落在目标名上，数据就位、源名已删除；
    /// `false` 表示目标是空文件，调用方还要经 [`Self::write_all`] / [`Self::copy_from`] 写入数据。
    pub fn is_moved(&self) -> bool {
        self.moved
    }

    /// 经占坑句柄写入全部字节。Windows 上其它句柄被禁止写入，所以数据必须走这里。
    /// 调用方的字节都来自内存缓冲（不超过下载溢写阈值），同步写入即可。
    pub fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.file.write_all(bytes)?;
        self.file.flush()
    }

    /// 把 `src` 的内容复制进占坑文件（阻塞线程里顺序拷贝，文件可能很大）。
    /// 失败时守卫已随闭包 drop，目标名上可能留下不完整的文件，由调用方删除。
    pub async fn copy_from(mut self, src: &Path) -> io::Result<Self> {
        let src = src.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut reader = File::open(&src)?;
            io::copy(&mut reader, &mut self.file)?;
            self.file.flush()?;
            Ok(self)
        })
        .await
        .map_err(|e| io::Error::other(format!("copy task join error: {e}")))?
    }
}

/// 在 `dir` 下独占地拿到 `filename` 系列候选名中的一个（重名依次换 `stem(1).ext`、`stem(2).ext`……），
/// 返回带占用标记的文件；`dir` 必须已存在。
///
/// Unix 流程（都靠 `link` 的 `EEXIST` 判定重名，文件出现在目标名时已经上好锁）：
/// 1. `move_from` 给了源文件：锁住源文件，硬链接到候选名，成功后删除源名（零拷贝搬运）；
/// 2. 否则（或第 1 步失败，如跨设备）在 `dir` 建随机临时文件、上锁，再硬链接到候选名，删除临时名；
/// 3. 文件系统不支持硬链接（FAT / exFAT / 部分网络盘）：`create_new` 独占创建后再上锁
///    （创建与上锁之间有极短窗口；上锁失败只记日志，文件照常返回，退化为无标记）。
///
/// Windows 只有第 3 步，占用标记是 share mode，创建即生效，没有窗口；`move_from` 被忽略，
/// 调用方按 [`OccupiedFile::is_moved`] 为 `false` 自行复制。
pub fn occupy_unique_path(
    dir: &Path,
    filename: &str,
    move_from: Option<&Path>,
) -> io::Result<OccupiedFile> {
    #[cfg(unix)]
    {
        if let Some(src) = move_from {
            if let Ok(file) = OpenOptions::new().read(true).write(true).open(src) {
                if file.lock().is_ok() {
                    if let Ok(path) = link_unique(src, dir, filename) {
                        let _ = std::fs::remove_file(src);
                        return Ok(OccupiedFile {
                            path,
                            file,
                            moved: true,
                        });
                    }
                }
            }
        }

        let tmp = dir.join(format!(".kabegame-occupy-{}", uuid::Uuid::new_v4()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        let linked = file.lock().and_then(|_| link_unique(&tmp, dir, filename));
        let _ = std::fs::remove_file(&tmp);
        match linked {
            Ok(path) => {
                return Ok(OccupiedFile {
                    path,
                    file,
                    moved: false,
                })
            }
            // 不支持硬链接等：退回独占创建
            Err(_) => drop(file),
        }

        let (path, file) = create_new_unique(dir, filename, |opts| opts)?;
        if let Err(err) = file.lock() {
            eprintln!(
                "[downloader] 占用标记上锁失败，按无标记继续 {}: {err}",
                path.display()
            );
        }
        Ok(OccupiedFile {
            path,
            file,
            moved: false,
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        let _ = move_from;
        let (path, file) =
            create_new_unique(dir, filename, |opts| opts.share_mode(FILE_SHARE_READ))?;
        Ok(OccupiedFile {
            path,
            file,
            moved: false,
        })
    }
}

/// 把 `src` 硬链接到 `dir` 下第一个可用的候选名；`EEXIST` 换下一个，其它错误原样返回。
#[cfg(unix)]
fn link_unique(src: &Path, dir: &Path, filename: &str) -> io::Result<PathBuf> {
    for idx in 0.. {
        let candidate = dir.join(candidate_filename(filename, idx));
        match std::fs::hard_link(src, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    unreachable!("unbounded candidate iterator")
}

/// 用 `create_new` 独占创建 `dir` 下第一个可用的候选名；`configure` 用来追加平台选项。
fn create_new_unique(
    dir: &Path,
    filename: &str,
    configure: impl Fn(&mut OpenOptions) -> &mut OpenOptions,
) -> io::Result<(PathBuf, File)> {
    for idx in 0.. {
        let candidate = dir.join(candidate_filename(filename, idx));
        let mut opts = OpenOptions::new();
        opts.read(true).write(true).create_new(true);
        match configure(&mut opts).open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    unreachable!("unbounded candidate iterator")
}

/// 探测 `path` 是否正被下载流程占坑（见 [`OccupiedFile`]）。本地文件夹同步给新文件建行前调用，
/// 命中则放弃本次导入。探测本身不留下任何标记；读不到文件一律视为未占用。
///
/// 同一进程内另开的句柄同样会被标记挡住（Unix `flock` 按打开的文件描述、Windows share mode 按句柄），
/// 所以也能用来判断「调用方是否持有该文件的占坑守卫」。
pub fn is_occupied_for_download(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::fs::TryLockError;
        match File::open(path) {
            Ok(file) => matches!(file.try_lock(), Err(TryLockError::WouldBlock)),
            Err(_) => false,
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;
        match OpenOptions::new().write(true).open(path) {
            Err(err) => err.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32),
            Ok(_) => false,
        }
    }
}

fn occupy_in_dir(
    dir: &Path,
    filename: &str,
    move_from: Option<&Path>,
) -> Result<OccupiedFile, String> {
    occupy_unique_path(dir, filename, move_from)
        .map_err(|e| format!("Failed to occupy download path in {}: {e}", dir.display()))
}

/// 在 `output_dir` 下为 `url` 占坑一个最终下载文件（见 [`OccupiedFile`]）。
///
/// 文件名 stem 取自 URL 路径；`ext` 为 `Some` 时使用调用方给的扩展名，否则沿用 URL 文件名自身的
/// 扩展名规则。已存在的文件名依次换成 `name(1).ext`、`name(2).ext`……，判重与创建是同一个原子动作，
/// 并发下载同名文件也不会拿到同一条路径。`output_dir` 必须已存在。
///
/// `move_from` 给了已落盘的源文件（如下载溢写文件）时，Unix 上优先零拷贝地把它搬到目标名
/// （[`OccupiedFile::is_moved`] 为 `true`）；否则返回空文件，由调用方经占坑句柄写入。
///
/// 所有非 content 下载目标（队列下载、浏览器 / 畅游原生下载）都用这一组函数，共享同一套命名与判重规则。
///
/// # Example
///
/// ```rust,no_run
/// use kabegame_core::crawler::downloader::occupy_unique_download_path;
/// use url::Url;
///
/// let output_dir = std::env::temp_dir();
/// let url = Url::parse("https://example.com/gallery/wallpaper.jpg?size=large").unwrap();
/// let mut occupied = occupy_unique_download_path(&output_dir, &url, Some("jpg"), None)?;
/// occupied.write_all(b"image bytes").map_err(|e| e.to_string())?;
///
/// assert!(occupied.path().starts_with(&output_dir));
/// // 图片行写入完成后再释放占用标记
/// drop(occupied);
/// # Ok::<(), String>(())
/// ```
pub fn occupy_unique_download_path(
    output_dir: &Path,
    url: &Url,
    ext: Option<&str>,
    move_from: Option<&Path>,
) -> Result<OccupiedFile, String> {
    let url_path = url
        .path_segments()
        .and_then(|segments| segments.last())
        .unwrap_or("image");
    let filename = if let Some(ext) = ext.filter(|e| !e.trim().trim_start_matches('.').is_empty()) {
        let path = Path::new(url_path);
        let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
        let ext = normalize_ext(ext, crate::media::image_type::default_image_extension());
        let stem = sanitize_stem_for_filename(raw_stem);
        let reserve = 1 + ext.len();
        let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(reserve).max(1);
        let stem_final = clamp_utf8_len(&stem, stem_max);
        format!("{}.{}", stem_final, ext)
    } else {
        let extension = Path::new(url_path).extension().and_then(|e| e.to_str());
        #[cfg(target_os = "android")]
        {
            build_safe_filename(
                url_path,
                extension.unwrap_or(crate::media::image_type::default_image_extension()),
            )
        }
        #[cfg(not(target_os = "android"))]
        {
            match extension {
                Some(ext) => build_safe_filename(url_path, ext),
                None => build_safe_filename_no_ext(url_path),
            }
        }
    };
    occupy_in_dir(output_dir, &filename, move_from)
}

/// 同 [`occupy_unique_download_path`]，但 `name` 非空时按脚本指定的展示名起文件名。
pub fn occupy_unique_download_path_with_name(
    output_dir: &Path,
    url: &Url,
    ext: Option<&str>,
    name: Option<&str>,
    move_from: Option<&Path>,
) -> Result<OccupiedFile, String> {
    let Some(name) = name.filter(|value| !value.trim().is_empty()) else {
        return occupy_unique_download_path(output_dir, url, ext, move_from);
    };

    let fallback_ext = ext.or_else(|| {
        url.path_segments()
            .and_then(|segments| segments.last())
            .and_then(|name| Path::new(name).extension())
            .and_then(|ext| ext.to_str())
    });
    #[cfg(target_os = "android")]
    let fallback_ext =
        fallback_ext.or_else(|| Some(crate::media::image_type::default_image_extension()));

    occupy_in_dir(
        output_dir,
        &build_safe_custom_filename(name, fallback_ext),
        move_from,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_safe_custom_filename, build_safe_filename, is_occupied_for_download,
        occupy_unique_download_path, occupy_unique_download_path_with_name, occupy_unique_path,
        page_download_rel_path,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};
    use url::Url;

    #[test]
    fn occupy_unique_download_path_uses_linear_probe_without_hash_suffix() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kabegame-download-path-test-{}-{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("wallpaper.jpg"), b"existing").unwrap();
        let first = occupy_unique_download_path(
            &dir,
            &Url::parse("https://example.com/gallery/wallpaper.jpg?size=large").unwrap(),
            Some("jpg"),
            None,
        )
        .unwrap();
        assert_eq!(
            first.path().file_name().and_then(|name| name.to_str()),
            Some("wallpaper(1).jpg")
        );
        assert!(first.path().is_file(), "占坑后目标文件已存在");

        // 第一个守卫仍然存活：同名再占坑必须换到下一个候选名
        let second = occupy_unique_download_path(
            &dir,
            &Url::parse("https://example.com/gallery/wallpaper.jpg?size=large").unwrap(),
            Some("jpg"),
            None,
        )
        .unwrap();
        assert_eq!(
            second.path().file_name().and_then(|name| name.to_str()),
            Some("wallpaper(2).jpg")
        );
        drop((first, second));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn occupy_unique_download_path_uses_explicit_extension() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kabegame-download-path-ext-test-{}-{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();

        let occupied = occupy_unique_download_path(
            &dir,
            &Url::parse("https://example.com/gallery/wallpaper.txt?size=large").unwrap(),
            Some("png"),
            None,
        )
        .unwrap();
        assert_eq!(
            occupied.path().file_name().and_then(|name| name.to_str()),
            Some("wallpaper.png")
        );
        assert!(occupied.path().is_file());
        drop(occupied);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sanitize_stem_keeps_cjk_and_strips_only_forbidden_chars() {
        use super::sanitize_stem_for_filename;
        // 中文/日文假名保留,仅 Windows 保留字符被替换为下划线。
        assert_eq!(sanitize_stem_for_filename("壁纸标题"), "壁纸标题");
        assert_eq!(
            sanitize_stem_for_filename("東方 <幻想郷>: レミリア"),
            "東方 _幻想郷__ レミリア"
        );
        assert_eq!(sanitize_stem_for_filename("a/b\\c"), "a_b_c");
    }

    #[test]
    fn clamp_utf8_len_never_splits_a_multibyte_char() {
        use super::clamp_utf8_len;
        let s = "壁纸"; // 每个汉字 3 字节,共 6 字节
                        // max_len 落在字符中间时应回退到边界,而不是 panic 或产生非法 UTF-8。
        assert_eq!(clamp_utf8_len(s, 4), "壁");
        assert_eq!(clamp_utf8_len(s, 3), "壁");
        assert_eq!(clamp_utf8_len(s, 2), "");
        assert_eq!(clamp_utf8_len(s, 6), "壁纸");
    }

    #[test]
    fn occupy_unique_download_path_with_name_preserves_title_prefix() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kabegame-download-path-name-test-{}-{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();

        let occupied = occupy_unique_download_path_with_name(
            &dir,
            &Url::parse("https://example.com/video/media.mp4?download=1").unwrap(),
            None,
            Some("Some.Page / media.mp4"),
            None,
        )
        .unwrap();
        assert_eq!(
            occupied.path().file_name().and_then(|name| name.to_str()),
            Some("Some.Page _ media.mp4")
        );
        assert!(occupied.path().is_file());
        drop(occupied);

        fs::remove_dir_all(&dir).unwrap();
    }

    fn temp_test_dir(tag: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kabegame-occupy-{tag}-{}-{}",
            std::process::id(),
            nonce
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 目录里没有残留的 `.kabegame-occupy-*` 临时名。
    fn assert_no_occupy_temp(dir: &std::path::Path) {
        let leftovers: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".kabegame-occupy-"))
            .collect();
        assert!(leftovers.is_empty(), "残留占坑临时文件: {leftovers:?}");
    }

    #[test]
    fn occupy_unique_path_picks_next_name_when_taken() {
        let dir = temp_test_dir("next-name");
        fs::write(dir.join("a.jpg"), b"existing").unwrap();

        let mut first = occupy_unique_path(&dir, "a.jpg", None).unwrap();
        let second = occupy_unique_path(&dir, "a.jpg", None).unwrap();
        assert_eq!(first.path(), dir.join("a(1).jpg"));
        assert_eq!(second.path(), dir.join("a(2).jpg"));
        assert!(!first.is_moved());

        // 守卫存活期间带占用标记；预先存在的普通文件没有
        assert!(is_occupied_for_download(first.path()));
        assert!(is_occupied_for_download(second.path()));
        assert!(!is_occupied_for_download(&dir.join("a.jpg")));
        assert!(!is_occupied_for_download(&dir.join("missing.jpg")));

        first.write_all(b"hello").unwrap();
        let first_path = first.path().to_path_buf();
        drop(first);
        assert!(!is_occupied_for_download(&first_path), "drop 后标记解除");
        assert_eq!(fs::read(&first_path).unwrap(), b"hello");
        assert!(is_occupied_for_download(second.path()));
        drop(second);

        assert_no_occupy_temp(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn occupy_move_relocates_without_copy() {
        use std::os::unix::fs::MetadataExt;
        let dir = temp_test_dir("move");
        let src = dir.join("spill.part");
        fs::write(&src, b"spilled bytes").unwrap();
        let src_ino = fs::metadata(&src).unwrap().ino();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        fs::write(out.join("b.png"), b"existing").unwrap();

        let occupied = occupy_unique_path(&out, "b.png", Some(&src)).unwrap();
        assert!(occupied.is_moved());
        assert_eq!(occupied.path(), out.join("b(1).png"));
        assert!(!src.exists(), "源名已删除");
        assert_eq!(fs::read(occupied.path()).unwrap(), b"spilled bytes");
        // 同一个 inode：硬链接搬运，没有复制
        assert_eq!(fs::metadata(occupied.path()).unwrap().ino(), src_ino);
        assert!(is_occupied_for_download(occupied.path()));

        let path = occupied.path().to_path_buf();
        drop(occupied);
        assert!(!is_occupied_for_download(&path));
        assert_no_occupy_temp(&out);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn occupy_copy_from_writes_through_handle() {
        let dir = temp_test_dir("copy");
        let src = dir.join("source.bin");
        fs::write(&src, b"copied bytes").unwrap();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();

        let occupied = occupy_unique_path(&out, "c.webp", None).unwrap();
        let occupied = occupied.copy_from(&src).await.unwrap();
        assert!(src.exists(), "复制不动源文件");
        assert_eq!(fs::read(occupied.path()).unwrap(), b"copied bytes");
        assert!(is_occupied_for_download(occupied.path()));
        drop(occupied);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn occupy_concurrent_same_name_never_collides() {
        const N: usize = 16;
        let dir = temp_test_dir("concurrent");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(N));
        let handles: Vec<_> = (0..N)
            .map(|i| {
                let dir = dir.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut occupied = occupy_unique_path(&dir, "same.jpg", None).unwrap();
                    occupied
                        .write_all(format!("thread-{i}").as_bytes())
                        .unwrap();
                    (i, occupied)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let paths: HashSet<_> = results
            .iter()
            .map(|(_, occupied)| occupied.path().to_path_buf())
            .collect();
        assert_eq!(paths.len(), N, "每个线程拿到互不相同的路径");
        // 内容没有互相覆盖：每个文件都是自己线程写的
        for (i, occupied) in &results {
            assert_eq!(
                fs::read(occupied.path()).unwrap(),
                format!("thread-{i}").as_bytes()
            );
        }
        drop(results);
        assert_no_occupy_temp(&dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn inferred_extension_replaces_existing_media_extension() {
        assert_eq!(build_safe_filename("foo.jpg", "webp"), "foo.webp");
        assert_eq!(
            build_safe_custom_filename("foo.jpg", Some("webp")),
            "foo.webp"
        );
        assert_eq!(
            build_safe_custom_filename("Some.Page", Some("webp")),
            "Some.Page.webp"
        );
    }

    #[test]
    fn page_download_path_is_stable_and_sanitized() {
        let url = Url::parse("https://example.com/files/archive.tar.gz?token=secret").unwrap();
        let path = page_download_rel_path(&url, Some("示例:压缩包.tar.gz"));
        assert!(path.starts_with("Downloads/"));
        assert_eq!(
            path.len(),
            "Downloads/".len() + 16 + 1 + "示例_压缩包.tar.gz".len()
        );
        assert!(path.ends_with("-示例_压缩包.tar.gz"));
        assert_eq!(
            path,
            page_download_rel_path(&url, Some("示例:压缩包.tar.gz"))
        );
    }

    #[test]
    fn page_download_path_falls_back_to_url_segment() {
        let url = Url::parse("https://example.com/files/wallpaper.webp").unwrap();
        assert!(page_download_rel_path(&url, None).ends_with("-wallpaper.webp"));
    }
}

#[cfg(target_os = "android")]
pub(super) fn derive_display_name_from_url(url: &str) -> String {
    let fallback_ext = crate::media::image_type::default_image_extension();
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(_) => return format!("image.{}", fallback_ext),
    };
    let last = parsed
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("image");
    let path = Path::new(last);
    let stem =
        sanitize_stem_for_filename(path.file_stem().and_then(|s| s.to_str()).unwrap_or("image"));
    let ext = normalize_ext(
        path.extension().and_then(|e| e.to_str()).unwrap_or(""),
        fallback_ext,
    );
    let stem_max = MAX_SAFE_FILENAME_LEN.saturating_sub(ext.len() + 1).max(1);
    let stem_final = clamp_utf8_len(&stem, stem_max);
    format!("{}.{}", stem_final, ext)
}

#[cfg(target_os = "android")]
pub(super) fn mime_type_from_filename(filename: &str) -> String {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or(crate::media::image_type::default_image_extension())
        .trim_start_matches('.')
        .to_ascii_lowercase();
    crate::media::image_type::mime_by_ext()
        .get(&ext)
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

#[cfg(windows)]
pub(super) fn remove_zone_identifier(file_path: &Path) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::DeleteFileW;

    let mut stream_path = file_path.as_os_str().to_owned();
    stream_path.push(":Zone.Identifier");

    let wide_path: Vec<u16> = OsStr::new(&stream_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        DeleteFileW(wide_path.as_ptr());
    }
}
