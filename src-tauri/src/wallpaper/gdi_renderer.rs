// GDI 渲染器 - 用原生 Windows GDI 绘制壁纸图片
// 这是对 WebView2 方案的替代，避免合成层/Z序问题

use std::path::Path;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP, HDC, STRETCH_HALFTONE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::GetClientRect;

/// GDI 壁纸渲染器
pub struct GdiWallpaperRenderer {
    hwnd: HWND,
    current_image_path: Option<String>,
    current_style: String, // fill/fit/stretch/center/tile
    bitmap: Option<HBITMAP>,
    bitmap_width: u32,
    bitmap_height: u32,
}

impl GdiWallpaperRenderer {
    /// 创建一个新的 GDI 渲染器（需要先有窗口 HWND）
    pub fn new(hwnd: HWND) -> Self {
        Self {
            hwnd,
            current_image_path: None,
            current_style: "fill".to_string(),
            bitmap: None,
            bitmap_width: 0,
            bitmap_height: 0,
        }
    }

    /// 加载图片文件并转换为 HBITMAP
    fn load_bitmap_from_file(path: &str) -> Result<(HBITMAP, u32, u32), String> {
        eprintln!("[DEBUG] load_bitmap_from_file: 开始加载图片: {}", path);
        let path_obj = Path::new(path);
        eprintln!("[DEBUG] load_bitmap_from_file: 检查文件是否存在");
        if !path_obj.exists() {
            eprintln!("[ERROR] load_bitmap_from_file: 图片文件不存在: {}", path);
            return Err(format!("图片文件不存在: {}", path));
        }
        eprintln!("[DEBUG] load_bitmap_from_file: 文件存在，开始使用 image crate 加载");

        // 用 image crate 加载图片（你已经有了这个依赖）
        let img = image::open(path).map_err(|e| {
            eprintln!(
                "[ERROR] load_bitmap_from_file: 无法加载图片 {}: {}",
                path, e
            );
            format!("无法加载图片 {}: {}", path, e)
        })?;
        eprintln!("[DEBUG] load_bitmap_from_file: 图片加载成功，开始转换为 RGB");

        let rgb_img = img.to_rgb8();
        let width = rgb_img.width();
        let height = rgb_img.height();
        eprintln!(
            "[DEBUG] load_bitmap_from_file: 图片尺寸: {}x{}",
            width, height
        );
        let pixels = rgb_img.as_raw();
        eprintln!(
            "[DEBUG] load_bitmap_from_file: 像素数据长度: {} bytes",
            pixels.len()
        );

        unsafe {
            eprintln!("[DEBUG] load_bitmap_from_file: 开始创建 BITMAPINFO");
            // 创建 BITMAPINFO
            let mut bi: BITMAPINFO = std::mem::zeroed();
            bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bi.bmiHeader.biWidth = width as i32;
            bi.bmiHeader.biHeight = -(height as i32); // 负值表示从上到下的位图
            bi.bmiHeader.biPlanes = 1;
            bi.bmiHeader.biBitCount = 24; // RGB
            bi.bmiHeader.biCompression = BI_RGB;
            eprintln!("[DEBUG] load_bitmap_from_file: BITMAPINFO 创建完成");

            // 创建 DIB section
            eprintln!("[DEBUG] load_bitmap_from_file: 获取屏幕 DC");
            let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            let hdc_screen = GetDC(0);
            if hdc_screen == 0 {
                eprintln!("[ERROR] load_bitmap_from_file: GetDC(0) failed");
                return Err("GetDC(0) failed".to_string());
            }
            eprintln!("[DEBUG] load_bitmap_from_file: 屏幕 DC 获取成功");

            // CreateDIBSection 的签名（windows-sys 版本）：
            // CreateDIBSection(hdc: HDC, pbmi: *const BITMAPINFO, usage: u32, ppvBits: *mut *mut c_void, hSection: isize, offset: u32)
            eprintln!("[DEBUG] load_bitmap_from_file: 调用 CreateDIBSection");
            let hbitmap = CreateDIBSection(
                hdc_screen,
                &bi as *const BITMAPINFO,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                0 as isize, // hSection: 文件映射句柄（HANDLE 映射为 isize），0 表示不使用文件映射
                0u32,       // offset: 文件映射偏移量（DWORD/u32），0 表示不使用文件映射
            );

            ReleaseDC(0, hdc_screen);

            if hbitmap == 0 {
                let err = windows_sys::Win32::Foundation::GetLastError();
                eprintln!(
                    "[ERROR] load_bitmap_from_file: CreateDIBSection failed, error code: {}",
                    err
                );
                return Err(format!("CreateDIBSection failed, error code: {}", err));
            }
            eprintln!(
                "[DEBUG] load_bitmap_from_file: CreateDIBSection 成功，HBITMAP: {}",
                hbitmap
            );

            // 复制像素数据（RGB -> BGR，因为 Windows 使用 BGR）
            eprintln!(
                "[DEBUG] load_bitmap_from_file: 准备复制像素数据，bits_ptr 是否为 null: {}",
                bits_ptr.is_null()
            );
            if !bits_ptr.is_null() {
                eprintln!("[DEBUG] load_bitmap_from_file: 开始复制像素数据 (RGB -> BGR)，宽度: {}, 高度: {}", width, height);
                let bits = std::slice::from_raw_parts_mut(
                    bits_ptr as *mut u8,
                    (width * height * 3) as usize,
                );
                let stride = (width * 3) as usize;
                eprintln!(
                    "[DEBUG] load_bitmap_from_file: stride: {}, pixels.len(): {}, bits.len(): {}",
                    stride,
                    pixels.len(),
                    bits.len()
                );
                for y in 0..height {
                    for x in 0..width {
                        let src_idx = ((y * width + x) * 3) as usize;
                        let dst_idx = (y as usize * stride) + (x as usize * 3);
                        if src_idx + 2 < pixels.len() && dst_idx + 2 < bits.len() {
                            // RGB -> BGR
                            bits[dst_idx] = pixels[src_idx + 2];
                            bits[dst_idx + 1] = pixels[src_idx + 1];
                            bits[dst_idx + 2] = pixels[src_idx];
                        }
                    }
                }
                eprintln!("[DEBUG] load_bitmap_from_file: 像素复制循环完成");
            } else {
                eprintln!("[WARN] load_bitmap_from_file: bits_ptr 为 null，跳过像素复制");
            }

            eprintln!("[DEBUG] load_bitmap_from_file: 像素数据复制完成，返回 HBITMAP");
            Ok((hbitmap, width, height))
        }
    }

    /// 设置要显示的图片
    pub fn set_image(&mut self, image_path: &str) -> Result<(), String> {
        eprintln!(
            "[DEBUG] GdiWallpaperRenderer::set_image 开始: {}",
            image_path
        );
        // 释放旧的 bitmap
        if let Some(old_bmp) = self.bitmap {
            eprintln!("[DEBUG] GdiWallpaperRenderer::set_image: 释放旧的 bitmap");
            unsafe {
                DeleteObject(old_bmp as _);
            }
        }

        eprintln!("[DEBUG] GdiWallpaperRenderer::set_image: 调用 load_bitmap_from_file");
        let (hbitmap, width, height) = Self::load_bitmap_from_file(image_path)?;
        eprintln!(
            "[DEBUG] GdiWallpaperRenderer::set_image: load_bitmap_from_file 返回成功，尺寸: {}x{}",
            width, height
        );

        eprintln!("[DEBUG] GdiWallpaperRenderer::set_image: 设置 bitmap 和尺寸");
        eprintln!("[DEBUG] GdiWallpaperRenderer::set_image: 旧 bitmap: {:?}, 新 bitmap: {}", self.bitmap, hbitmap);
        self.bitmap = Some(hbitmap);
        self.bitmap_width = width;
        self.bitmap_height = height;
        self.current_image_path = Some(image_path.to_string());
        eprintln!("[DEBUG] GdiWallpaperRenderer::set_image: 属性设置完成，bitmap: {:?}, 路径: {}", self.bitmap, image_path);

        // 注意：不要在这里调用 invalidate，因为 invalidate 应该在 GdiWallpaperWindow 级别调用
        // 这样可以确保在正确的时机调用，避免并发问题
        eprintln!("[DEBUG] GdiWallpaperRenderer::set_image: 属性设置完成（不在这里触发重绘，由 GdiWallpaperWindow::set_image 统一处理）");
        eprintln!("[DEBUG] GdiWallpaperRenderer::set_image: 完成，准备返回 Ok(())");
        Ok(())
    }

    /// 设置显示样式（fill/fit/stretch/center/tile）
    pub fn set_style(&mut self, style: &str) {
        self.current_style = style.to_string();
        self.invalidate();
    }

    /// 触发窗口重绘（注意：这个方法不应该被直接调用，应该通过 GdiWallpaperWindow::invalidate 调用）
    fn invalidate(&self) {
        // 这个方法不应该被使用，因为我们使用 PostMessageW 而不是 SendMessageW
        // 保留这个方法以保持接口一致性，但不做任何操作
        // 实际的 invalidate 应该在 GdiWallpaperWindow 级别处理
    }

    /// 绘制图片到窗口 DC（在 WM_PAINT 消息处理中调用）
    pub fn paint(&self, hdc: HDC) -> Result<(), String> {
        let bitmap = match self.bitmap {
            Some(bmp) => {
                eprintln!("[DEBUG] GdiWallpaperRenderer::paint: 使用 bitmap: {}, 尺寸: {}x{}, 路径: {:?}", 
                    bmp, self.bitmap_width, self.bitmap_height, self.current_image_path);
                bmp
            },
            None => {
                eprintln!("[DEBUG] GdiWallpaperRenderer::paint: 没有 bitmap，跳过绘制");
                return Ok(()); // 没有图片，不绘制
            }
        };

        unsafe {
            // 获取窗口客户区大小
            let mut rc: RECT = std::mem::zeroed();
            if GetClientRect(self.hwnd, &mut rc as *mut RECT) == 0 {
                return Err("GetClientRect failed".to_string());
            }

            let win_width = (rc.right - rc.left) as u32;
            let win_height = (rc.bottom - rc.top) as u32;

            if win_width == 0 || win_height == 0 {
                return Ok(()); // 窗口大小为0，不绘制
            }

            // 创建内存 DC
            let hdc_mem = CreateCompatibleDC(hdc);
            if hdc_mem == 0 {
                return Err("CreateCompatibleDC failed".to_string());
            }

            // 选择 bitmap 到内存 DC
            let old_bmp = SelectObject(hdc_mem, bitmap as _);
            if old_bmp == 0 {
                DeleteDC(hdc_mem);
                return Err("SelectObject failed".to_string());
            }

            // 根据样式绘制
            match self.current_style.as_str() {
                "fill" => {
                    // 填充：等比例缩放，裁剪多余部分，居中
                    let scale = (win_width as f32 / self.bitmap_width as f32)
                        .max(win_height as f32 / self.bitmap_height as f32);
                    let draw_width = (self.bitmap_width as f32 * scale) as i32;
                    let draw_height = (self.bitmap_height as f32 * scale) as i32;
                    let x = (win_width as i32 - draw_width) / 2;
                    let y = (win_height as i32 - draw_height) / 2;

                    SetStretchBltMode(hdc, STRETCH_HALFTONE as i32);
                    StretchBlt(
                        hdc,
                        x,
                        y,
                        draw_width,
                        draw_height,
                        hdc_mem,
                        0,
                        0,
                        self.bitmap_width as i32,
                        self.bitmap_height as i32,
                        0x00CC0020, // SRCCOPY
                    );
                }
                "fit" => {
                    // 适应：等比例缩放，完整显示，居中
                    let scale = (win_width as f32 / self.bitmap_width as f32)
                        .min(win_height as f32 / self.bitmap_height as f32);
                    let draw_width = (self.bitmap_width as f32 * scale) as i32;
                    let draw_height = (self.bitmap_height as f32 * scale) as i32;
                    let x = (win_width as i32 - draw_width) / 2;
                    let y = (win_height as i32 - draw_height) / 2;

                    SetStretchBltMode(hdc, STRETCH_HALFTONE as i32);
                    StretchBlt(
                        hdc,
                        x,
                        y,
                        draw_width,
                        draw_height,
                        hdc_mem,
                        0,
                        0,
                        self.bitmap_width as i32,
                        self.bitmap_height as i32,
                        0x00CC0020, // SRCCOPY
                    );
                }
                "stretch" => {
                    // 拉伸：铺满整个窗口
                    SetStretchBltMode(hdc, STRETCH_HALFTONE as i32);
                    StretchBlt(
                        hdc,
                        0,
                        0,
                        win_width as i32,
                        win_height as i32,
                        hdc_mem,
                        0,
                        0,
                        self.bitmap_width as i32,
                        self.bitmap_height as i32,
                        0x00CC0020, // SRCCOPY
                    );
                }
                "center" => {
                    // 居中：原始大小，居中显示
                    let x = (win_width as i32 - self.bitmap_width as i32) / 2;
                    let y = (win_height as i32 - self.bitmap_height as i32) / 2;
                    BitBlt(
                        hdc,
                        x,
                        y,
                        self.bitmap_width as i32,
                        self.bitmap_height as i32,
                        hdc_mem,
                        0,
                        0,
                        0x00CC0020, // SRCCOPY
                    );
                }
                "tile" => {
                    // 平铺：重复填充
                    let tiles_x = (win_width + self.bitmap_width - 1) / self.bitmap_width;
                    let tiles_y = (win_height + self.bitmap_height - 1) / self.bitmap_height;
                    for ty in 0..tiles_y {
                        for tx in 0..tiles_x {
                            let x = (tx * self.bitmap_width) as i32;
                            let y = (ty * self.bitmap_height) as i32;
                            BitBlt(
                                hdc,
                                x,
                                y,
                                self.bitmap_width as i32,
                                self.bitmap_height as i32,
                                hdc_mem,
                                0,
                                0,
                                0x00CC0020, // SRCCOPY
                            );
                        }
                    }
                }
                _ => {
                    // 默认使用 fill
                    let scale = (win_width as f32 / self.bitmap_width as f32)
                        .max(win_height as f32 / self.bitmap_height as f32);
                    let draw_width = (self.bitmap_width as f32 * scale) as i32;
                    let draw_height = (self.bitmap_height as f32 * scale) as i32;
                    let x = (win_width as i32 - draw_width) / 2;
                    let y = (win_height as i32 - draw_height) / 2;
                    SetStretchBltMode(hdc, STRETCH_HALFTONE as i32);
                    StretchBlt(
                        hdc,
                        x,
                        y,
                        draw_width,
                        draw_height,
                        hdc_mem,
                        0,
                        0,
                        self.bitmap_width as i32,
                        self.bitmap_height as i32,
                        0x00CC0020, // SRCCOPY
                    );
                }
            }

            // 清理
            SelectObject(hdc_mem, old_bmp);
            DeleteDC(hdc_mem);
        }

        Ok(())
    }
}

impl Drop for GdiWallpaperRenderer {
    fn drop(&mut self) {
        if let Some(bmp) = self.bitmap {
            unsafe {
                DeleteObject(bmp as _);
            }
        }
    }
}
