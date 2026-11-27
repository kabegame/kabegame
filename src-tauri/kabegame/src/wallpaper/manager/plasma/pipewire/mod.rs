//! 插件模式（Linux）的壁纸推流：离屏壁纸窗口的每一帧经 PipeWire 交给 Plasma 壁纸插件。
//!
//! - [`stream`]：每个壁纸窗口一个 `Video/Source` 节点，格式协商（dmabuf 在前、共享内存兜底）与入队；
//! - [`gpu`]：dmabuf 路径的 EGL / GLES / GBM，把 CEF 的 dmabuf 拷进本流分配的缓冲；
//! - [`device`]：找合成器的主显示设备，dmabuf 分配在这张卡上。
//!
//! 计划见 `.claude/plans/plasma-pipewire/README.md` 点 2。

mod device;
pub mod gpu;
mod stream;

use std::sync::atomic::{AtomicBool, Ordering};

pub use stream::{StreamProps, WallpaperStream, PROTOCOL_VERSION};

/// 运行期检测到 CEF 共享纹理（dmabuf）离屏采集不出帧时置位，后续离屏壁纸窗口改走软件共享内存（OnPaint）。
static DMABUF_DISABLED: AtomicBool = AtomicBool::new(false);

/// 离屏壁纸窗口走不走共享纹理（帧是 dmabuf）：GPU 上下文可用且未被运行期禁用时走。建窗登记离屏与建流都按它，两边一致。
pub fn dmabuf_enabled() -> bool {
    !DMABUF_DISABLED.load(Ordering::Acquire) && gpu::get().is_some()
}

/// 运行期关掉离屏 dmabuf 共享纹理采集，后续重建的离屏壁纸窗口改走 `OnPaint` 共享内存。
/// 返回 `true` 表示本次首次从启用切为禁用（避免重复触发重建）。
pub fn disable_dmabuf_for_session() -> bool {
    !DMABUF_DISABLED.swap(true, Ordering::AcqRel)
}
