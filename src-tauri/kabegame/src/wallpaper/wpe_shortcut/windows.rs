//! Windows 上取文件 / 文件夹 / 命令的图标，以及启动（照 `rea-p11d.md` 2.1、2.2，逐条对 WPE 的 `winrtutil`）。
//!
//! 顺序：不是普通文件时 `SearchPathW` 补 `.exe` → Shell 缩略图缓存（256，不去预乘）→ 失败再按目录的已知文件夹图标、
//! `.url` 的 `IconFile`、按扩展名的系统图像列表取图标句柄，画成位图后去预乘。两支最后都由调用方做透明区填色
//! （`cv::fill_transparent`，见 [`super::finish`]）。所有函数都在阻塞线程里调用，自己初始化 COM。

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::path::Path;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{FreeLibrary, HWND};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetObjectW, ReleaseDC, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::{
    SearchPathW, FILE_ATTRIBUTE_DIRECTORY, FILE_FLAGS_AND_ATTRIBUTES,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx,
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_LIBRARY_FLAGS};
use windows::Win32::System::WindowsProgramming::{GetPrivateProfileIntW, GetPrivateProfileStringW};
use windows::Win32::UI::Controls::IImageList;
use windows::Win32::UI::Shell::{
    IKnownFolderManager, IShellItem, IThumbnailCache, KnownFolderManager, LocalThumbnailCache,
    SHCreateItemFromParsingName, SHGetFileInfoW, SHGetImageList, ShellExecuteW, FFFP_EXACTMATCH,
    KNOWNFOLDER_DEFINITION, SHFILEINFOW, SHGFI_FLAGS, WTS_EXTRACT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, GetIconInfo, LoadImageW, PrivateExtractIconsW, DI_NORMAL, HICON,
    ICONINFO, IMAGE_FLAGS, IMAGE_ICON, SW_SHOWNORMAL,
};

use super::Icon;

/// 线程里初始化 COM（STA | DISABLE_OLE1DDE），析构时配对反初始化。
struct ComGuard(bool);

impl ComGuard {
    fn new() -> Self {
        // S_OK / S_FALSE 都要配对 CoUninitialize；RPC_E_CHANGED_MODE（线程已按别的模式初始化）不用
        let result =
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        Self(result.is_ok())
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// 图标句柄，析构时销毁。
struct OwnedIcon(HICON);

impl Drop for OwnedIcon {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DestroyIcon(self.0);
            }
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

/// 展开 `%VAR%`；失败原样返回。
fn expand_env(text: &str) -> String {
    let source = wide(text);
    let mut buffer = vec![0u16; 4096];
    let written =
        unsafe { ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), Some(buffer.as_mut_slice())) };
    if written == 0 || written as usize > buffer.len() {
        return text.to_owned();
    }
    from_wide(&buffer)
}

/// 普通文件（`std::filesystem` 状态为 regular）：符号链接 / 目录联接的重解析点按「不是」算。
fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_file())
        .unwrap_or(false)
}

/// 不是普通文件时用文件名（丢掉目录）在 PATH 等位置里找 `.exe`，找到的是普通文件才替换。
fn resolve_path(path: &str) -> String {
    if is_regular_file(Path::new(path)) {
        return path.to_owned();
    }
    let Some(name) = Path::new(path).file_name().and_then(|name| name.to_str()) else {
        return path.to_owned();
    };
    let mut buffer = vec![0u16; 4096];
    let length = unsafe {
        SearchPathW(
            PCWSTR::null(),
            &HSTRING::from(name),
            &HSTRING::from(".exe"),
            Some(buffer.as_mut_slice()),
            None,
        )
    } as usize;
    if length == 0 || length >= buffer.len() {
        return path.to_owned();
    }
    let found = from_wide(&buffer[..length]);
    if is_regular_file(Path::new(&found)) {
        found
    } else {
        path.to_owned()
    }
}

/// 取一个路径的图标，Shell 取的不去预乘，图标句柄的去预乘；都还没做透明区填色。
pub fn prefill_icon(path: &str) -> Option<Icon> {
    let _com = ComGuard::new();
    let path = resolve_path(path);
    if let Some(icon) = thumbnail(&path) {
        return Some(icon);
    }
    let is_dir = Path::new(&path).is_dir();
    // `.url`（扩展名比较区分大小写）只用自己的 IconFile，不用目录的图标
    let is_url_file = Path::new(&path).extension().and_then(|ext| ext.to_str()) == Some("url");
    let handle = if is_url_file {
        url_file_icon(&path)
    } else if is_dir {
        known_folder_icon(&path)
    } else {
        None
    };
    if let Some(handle) = handle {
        if let Some((mut icon, _)) = draw_icon(handle.0) {
            unpremultiply(&mut icon);
            return Some(icon);
        }
    }
    image_list_icon(&path, is_dir)
}

/// `IThumbnailCache::GetThumbnail(256)`：只收 24 / 32 位的位图，直接用（带 alpha 的 32 位也不去预乘）。
fn thumbnail(path: &str) -> Option<Icon> {
    unsafe {
        let item: IShellItem =
            SHCreateItemFromParsingName(&HSTRING::from(path), None::<&IBindCtx>).ok()?;
        let cache: IThumbnailCache =
            CoCreateInstance(&LocalThumbnailCache, None, CLSCTX_INPROC_SERVER).ok()?;
        let mut shared = None;
        cache
            .GetThumbnail(&item, 256, WTS_EXTRACT, Some(&mut shared), None, None)
            .ok()?;
        // ISharedBitmap 要活到取完像素：它释放时位图随之销毁（之前写成临时值，`GetDIBits` 拿到的是失效句柄）
        let shared = shared?;
        let bitmap = shared.GetSharedBitmap().ok()?;
        // 位图归 ISharedBitmap 所有，不删
        bitmap_to_rgba(bitmap)
    }
}

/// `GetDIBits` 先取头：24 位要 `biSizeImage == w·h·3`、32 位要 `== w·h·4`，否则不收；按自下而上取出再翻转，
/// 24 位的 alpha 填 255。
unsafe fn bitmap_to_rgba(bitmap: HBITMAP) -> Option<Icon> {
    let screen = GetDC(HWND::default());
    let result = (|| {
        let mut info: BITMAPINFO = zeroed();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        if GetDIBits(screen, bitmap, 0, 0, None, &mut info, DIB_RGB_COLORS) == 0 {
            return None;
        }
        let header = info.bmiHeader;
        let (width, height) = (header.biWidth, header.biHeight.abs());
        if width <= 0 || height <= 0 {
            return None;
        }
        let pixels = width as usize * height as usize;
        let channels = match (header.biBitCount, header.biSizeImage as usize) {
            (24, size) if size == pixels * 3 => 3,
            (32, size) if size == pixels * 4 => 4,
            _ => return None,
        };
        let mut raw = vec![0u8; pixels * channels];
        info.bmiHeader.biHeight = height; // 正数 = 自下而上
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = (channels * 8) as u16;
        info.bmiHeader.biCompression = BI_RGB.0;
        let rows = GetDIBits(
            screen,
            bitmap,
            0,
            height as u32,
            Some(raw.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        if rows != height {
            return None;
        }
        let (width, height) = (width as usize, height as usize);
        let mut rgba = vec![0u8; pixels * 4];
        for y in 0..height {
            let source = &raw[(height - 1 - y) * width * channels..][..width * channels];
            let target = &mut rgba[y * width * 4..][..width * 4];
            for x in 0..width {
                let (b, g, r) = (
                    source[x * channels],
                    source[x * channels + 1],
                    source[x * channels + 2],
                );
                let a = if channels == 4 {
                    source[x * channels + 3]
                } else {
                    255
                };
                target[x * 4..x * 4 + 4].copy_from_slice(&[r, g, b, a]);
            }
        }
        Some(Icon {
            width: width as u32,
            height: height as u32,
            rgba,
        })
    })();
    ReleaseDC(HWND::default(), screen);
    result
}

/// 已知文件夹的图标：`pszIcon` 恰好是 `模块,-数字`（`swscanf_s("%[^,],-%d")` 恰好两项）才取。
fn known_folder_icon(path: &str) -> Option<OwnedIcon> {
    unsafe {
        let manager: IKnownFolderManager =
            CoCreateInstance(&KnownFolderManager, None, CLSCTX_INPROC_SERVER).ok()?;
        let folder = manager
            .FindFolderFromPath(&HSTRING::from(path), FFFP_EXACTMATCH)
            .ok()?;
        let mut definition: KNOWNFOLDER_DEFINITION = zeroed();
        folder.GetFolderDefinition(&mut definition).ok()?;
        let icon_spec = if definition.pszIcon.is_null() {
            None
        } else {
            definition.pszIcon.to_string().ok()
        };
        // 定义里的字符串都是 CoTaskMemAlloc 的，等同 FreeKnownFolderDefinitionFields
        for text in [
            definition.pszName,
            definition.pszDescription,
            definition.pszRelativePath,
            definition.pszParsingName,
            definition.pszTooltip,
            definition.pszLocalizedName,
            definition.pszIcon,
            definition.pszSecurity,
        ] {
            if !text.is_null() {
                CoTaskMemFree(Some(text.0 as *const c_void));
            }
        }
        let (module, id) = parse_icon_spec(&icon_spec?)?;
        let module = wide(&expand_env(&module));
        // AS_DATAFILE | SEARCH_DEFAULT_DIRS
        let library =
            LoadLibraryExW(PCWSTR(module.as_ptr()), None, LOAD_LIBRARY_FLAGS(0x1002)).ok()?;
        let loaded = LoadImageW(
            library,
            PCWSTR(id as usize as *const u16),
            IMAGE_ICON,
            256,
            256,
            IMAGE_FLAGS(0),
        );
        let _ = FreeLibrary(library);
        let handle = loaded.ok()?;
        Some(OwnedIcon(HICON(handle.0)))
    }
}

/// `模块,-数字` → `(模块, 数字)`；照 `%[^,],-%d`：模块非空、逗号后必须是 `-` 再接整数（前导空白由 `%d` 跳过）。
pub(super) fn parse_icon_spec(spec: &str) -> Option<(String, u16)> {
    let (module, rest) = spec.split_once(',')?;
    if module.is_empty() {
        return None;
    }
    let rest = rest.strip_prefix('-')?.trim_start();
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    // MAKEINTRESOURCE 只有 16 位；取不下的数字当作取不到
    let id: u16 = digits.parse().ok()?;
    Some((module.to_owned(), id))
}

/// `.url`：`[InternetShortcut]` 的 `IconFile` / `IconIndex`，`PrivateExtractIconsW(256)`；`IconFile` 为空或取不到返回 `None`。
fn url_file_icon(path: &str) -> Option<OwnedIcon> {
    unsafe {
        let path = HSTRING::from(path);
        let mut buffer = [0u16; 260];
        let length = GetPrivateProfileStringW(
            windows::core::w!("InternetShortcut"),
            windows::core::w!("IconFile"),
            windows::core::w!(""),
            Some(&mut buffer),
            &path,
        );
        if length == 0 {
            return None;
        }
        let index = GetPrivateProfileIntW(
            windows::core::w!("InternetShortcut"),
            windows::core::w!("IconIndex"),
            0,
            &path,
        ) as i32;
        let expanded = expand_env(&from_wide(&buffer));
        let mut file = [0u16; 260];
        for (slot, ch) in file.iter_mut().zip(expanded.encode_utf16().take(259)) {
            *slot = ch;
        }
        let mut handles = [HICON::default()];
        let count = PrivateExtractIconsW(&file, index, 256, 256, Some(&mut handles), None, 1);
        let handle = OwnedIcon(handles[0]);
        if count == 0 || handle.0.is_invalid() {
            return None;
        }
        Some(handle)
    }
}

/// 把图标句柄画成 `bmHeight` 边长的正方形 32 位位图，返回（预乘的 RGBA，颜色位图的位深）。没有颜色位图（单色图标）返回 `None`。
fn draw_icon(icon: HICON) -> Option<(Icon, u16)> {
    unsafe {
        let mut info: ICONINFO = zeroed();
        GetIconInfo(icon, &mut info).ok()?;
        let result = (|| {
            if info.hbmColor.is_invalid() {
                return None;
            }
            let mut bitmap: BITMAP = zeroed();
            if GetObjectW(
                info.hbmColor,
                size_of::<BITMAP>() as i32,
                Some(&mut bitmap as *mut BITMAP as *mut c_void),
            ) == 0
            {
                return None;
            }
            let size = bitmap.bmHeight;
            if size <= 0 {
                return None;
            }
            let screen = GetDC(HWND::default());
            let memory = CreateCompatibleDC(screen);
            // 内容不清零，同 WPE
            let canvas = CreateCompatibleBitmap(screen, size, size);
            let previous = SelectObject(memory, canvas);
            let drawn = DrawIconEx(memory, 0, 0, icon, size, size, 0, None, DI_NORMAL).is_ok();
            SelectObject(memory, previous);
            let mut raw = vec![0u8; size as usize * size as usize * 4];
            let mut header: BITMAPINFO = zeroed();
            header.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
            header.bmiHeader.biWidth = size;
            header.bmiHeader.biHeight = -size; // 自上而下
            header.bmiHeader.biPlanes = 1;
            header.bmiHeader.biBitCount = 32;
            header.bmiHeader.biCompression = BI_RGB.0;
            let rows = GetDIBits(
                screen,
                canvas,
                0,
                size as u32,
                Some(raw.as_mut_ptr() as *mut c_void),
                &mut header,
                DIB_RGB_COLORS,
            );
            let _ = DeleteObject(HGDIOBJ::from(canvas));
            let _ = DeleteDC(memory);
            ReleaseDC(HWND::default(), screen);
            if !drawn || rows != size {
                return None;
            }
            for pixel in raw.chunks_exact_mut(4) {
                pixel.swap(0, 2); // BGRA → RGBA
            }
            Some((
                Icon {
                    width: size as u32,
                    height: size as u32,
                    rgba: raw,
                },
                bitmap.bmBitsPixel,
            ))
        })();
        let _ = DeleteObject(HGDIOBJ::from(info.hbmColor));
        let _ = DeleteObject(HGDIOBJ::from(info.hbmMask));
        result
    }
}

/// `cvttss2si`：单精度转 int32，向零截断；NaN、±∞、超出 int32 都得 `0x80000000`。
fn cvttss2si(value: f32) -> i32 {
    if value.is_nan() || value >= 2_147_483_648.0 || value < -2_147_483_648.0 {
        i32::MIN
    } else {
        value as i32
    }
}

/// 去预乘（`winrtutil` 的 `0x14002f654`）：全程单精度，`c' = (u8)cvttss2si(c / (a / 255))`，不钳制、只取低字节；
/// `a = 0` 时 `c / 0` 是 ∞ 或 NaN，得 0。
pub(super) fn unpremultiply(icon: &mut Icon) {
    for pixel in icon.rgba.chunks_exact_mut(4) {
        let alpha = pixel[3] as f32 / 255.0;
        for channel in &mut pixel[..3] {
            *channel = cvttss2si(*channel as f32 / alpha) as u8;
        }
    }
}

/// 缩略图取不到、也没有 A / `.url` 图标时：`SHGetFileInfoW(USEFILEATTRIBUTES)` 拿图标序号，从 JUMBO 往下取系统图像列表里
/// 32 位颜色位图的条目，跳过「小图标补透明边」的假大图。结果已去预乘。
fn image_list_icon(path: &str, is_dir: bool) -> Option<Icon> {
    unsafe {
        let mut info: SHFILEINFOW = zeroed();
        let attributes = if is_dir {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_FLAGS_AND_ATTRIBUTES(0)
        };
        // SYSICONINDEX | TYPENAME | DISPLAYNAME | ICON | OVERLAYINDEX | USEFILEATTRIBUTES
        SHGetFileInfoW(
            &HSTRING::from(path),
            attributes,
            Some(&mut info),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_FLAGS(0x4750),
        );
        drop(OwnedIcon(info.hIcon));
        let index = info.iIcon & 0x00ff_ffff;
        // JUMBO、EXTRALARGE、LARGE、SMALL
        let mut candidates: Vec<Icon> = Vec::new();
        for size_class in [4, 2, 0, 1] {
            let Ok(list) = SHGetImageList::<IImageList>(size_class) else {
                continue;
            };
            // ILD_TRANSPARENT = 1
            let Ok(handle) = list.GetIcon(index, 1) else {
                continue;
            };
            let handle = OwnedIcon(handle);
            let Some((icon, bits)) = draw_icon(handle.0) else {
                continue;
            };
            if bits != 32 || candidates.iter().any(|known| known.width == icon.width) {
                continue;
            }
            candidates.push(icon);
        }
        candidates.sort_by(|a, b| b.width.cmp(&a.width));
        let pick = (0..candidates.len()).find(|&i| {
            !candidates[i + 1..]
                .iter()
                .any(|small| is_padded_copy(&candidates[i], small))
        })?;
        let mut icon = candidates.swap_remove(pick);
        unpremultiply(&mut icon);
        Some(icon)
    }
}

/// `big` 是不是 `small` 补透明边得到的假大图：`small` 恰好等于 `big` 的左上角，`big` 其余部分 alpha 全 0。
pub(super) fn is_padded_copy(big: &Icon, small: &Icon) -> bool {
    if small.width >= big.width || small.height > big.height {
        return false;
    }
    let (bw, sw, sh) = (
        big.width as usize,
        small.width as usize,
        small.height as usize,
    );
    for y in 0..big.height as usize {
        for x in 0..bw {
            let pixel = &big.rgba[(y * bw + x) * 4..][..4];
            if x < sw && y < sh {
                if pixel != &small.rgba[(y * sw + x) * 4..][..4] {
                    return false;
                }
            } else if pixel[3] != 0 {
                return false;
            }
        }
    }
    true
}

/// `ShellExecuteW(NULL, NULL, 路径, 参数, NULL, SW_SHOWNORMAL)`，返回值 > 32 为成功。
pub fn shell_execute(path: &str, args: &str) -> bool {
    let _com = ComGuard::new();
    let file = HSTRING::from(path);
    let parameters = HSTRING::from(args);
    let result = unsafe {
        ShellExecuteW(
            HWND::default(),
            PCWSTR::null(),
            &file,
            if args.is_empty() {
                PCWSTR::null()
            } else {
                PCWSTR(parameters.as_ptr())
            },
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 > 32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn icon(width: u32, height: u32, pixel: [u8; 4]) -> Icon {
        Icon {
            width,
            height,
            rgba: pixel.repeat((width * height) as usize),
        }
    }

    #[test]
    fn unpremultiply_follows_the_float32_arithmetic() {
        // a = 0：c / 0 是 ∞ 或 NaN，cvttss2si 得 0x80000000，低字节 0
        let mut zero = Icon {
            width: 1,
            height: 1,
            rgba: vec![7, 0, 255, 0],
        };
        unpremultiply(&mut zero);
        assert_eq!(zero.rgba, [0, 0, 0, 0]);
        // 全不透明原样
        let mut opaque = Icon {
            width: 1,
            height: 1,
            rgba: vec![10, 20, 30, 255],
        };
        unpremultiply(&mut opaque);
        assert_eq!(opaque.rgba, [10, 20, 30, 255]);
        // c == a 在 a = 128 时得 254（128 / (128/255f) = 254.99998），不是 255
        let mut half = Icon {
            width: 1,
            height: 1,
            rgba: vec![128, 64, 0, 128],
        };
        unpremultiply(&mut half);
        assert_eq!(half.rgba[0], 254);
        // 不钳制：c = 200、a = 100 → 510 → 低字节 254
        let mut over = Icon {
            width: 1,
            height: 1,
            rgba: vec![200, 0, 0, 100],
        };
        unpremultiply(&mut over);
        assert_eq!(over.rgba[0], 254);
        assert_eq!(cvttss2si(f32::NAN), i32::MIN);
        assert_eq!(cvttss2si(f32::INFINITY), i32::MIN);
        assert_eq!(cvttss2si(2_147_483_648.0), i32::MIN);
        assert_eq!(cvttss2si(-2.9), -2);
    }

    #[test]
    fn icon_spec_needs_a_module_and_a_negative_resource_id() {
        assert_eq!(
            parse_icon_spec("%SystemRoot%\\system32\\imageres.dll,-3"),
            Some(("%SystemRoot%\\system32\\imageres.dll".to_owned(), 3))
        );
        assert_eq!(parse_icon_spec("a.dll,-1002").unwrap().1, 1002);
        // 正数索引、没有逗号、模块为空、没有数字都取不到
        for bad in [
            "a.dll,3",
            "a.dll",
            ",-3",
            "a.dll,-",
            "a.dll,-x",
            "a.dll,-99999",
        ] {
            assert_eq!(parse_icon_spec(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn padded_copies_are_recognized() {
        // 2x2 的小图补成 4x4：左上角相同、其余 alpha 全 0
        let small = icon(2, 2, [9, 8, 7, 255]);
        let mut big = icon(4, 4, [0, 0, 0, 0]);
        for y in 0..2 {
            for x in 0..2 {
                big.rgba[(y * 4 + x) * 4..][..4].copy_from_slice(&[9, 8, 7, 255]);
            }
        }
        assert!(is_padded_copy(&big, &small));
        // 其余部分有不透明像素：真正的大图
        big.rgba[(3 * 4 + 3) * 4 + 3] = 1;
        assert!(!is_padded_copy(&big, &small));
        // 左上角内容不同
        let other = icon(2, 2, [1, 1, 1, 255]);
        let mut padded = icon(4, 4, [0, 0, 0, 0]);
        padded.rgba[..4].copy_from_slice(&[9, 8, 7, 255]);
        assert!(!is_padded_copy(&padded, &other));
        // 不比它小就不是补边
        assert!(!is_padded_copy(&small, &big));
    }
}
