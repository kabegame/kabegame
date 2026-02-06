// app-main 的虚拟盘模块已下沉到 kabegame-core。
// 这里保留同名模块，仅做 re-export，以减少对 app-main 其他代码的改动。

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
pub use kabegame_core::virtual_driver::*;
