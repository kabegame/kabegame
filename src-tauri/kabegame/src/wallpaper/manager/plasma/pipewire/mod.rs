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

pub use stream::{StreamProps, WallpaperStream, PROTOCOL_VERSION};

/// 离屏壁纸窗口走不走共享纹理（帧是 dmabuf）：GPU 上下文可用时走。建窗登记离屏与建流都按它，两边一致。
pub fn dmabuf_enabled() -> bool {
    gpu::get().is_some()
}
