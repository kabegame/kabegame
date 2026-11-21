//! 系统「正在播放」的媒体会话：读系统当前的媒体会话，推出平台无关的读数（[`MediaEvent`]），不认识任何消费方。
//!
//! 用法：`app.sysmedia().watch(|event| …)` 返回 [`Watch`]，丢弃即停止；`available()` 说本平台有没有数据源。
//! 读数到了就推，不攒批：要攒批、要外推时间轴、要换成别的格式是消费方的事。
//!
//! 平台：
//! - macOS：MediaRemote，经嵌入的 mediaremote-adapter（`macos/mediaremote-adapter/`，由 `/usr/bin/perl` 加载，
//!   macOS 15.4 起只有系统程序能读到数据）。
//! - Windows：SMTC，现在仍在应用的 `wpe_media/media.rs` 里，待迁入（`.claude/plans/sysmedia/README.md` S2）。
//! - Linux（MPRIS）、Android（要用户授予通知使用权）：还没有，`available()` 为假，`watch` 只推一次「没有会话」。
//! - 项目不支持 iOS。

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
pub use desktop::Sysmedia;
#[cfg(mobile)]
pub use mobile::Sysmedia;

/// 插件名。
pub const PLUGIN_NAME: &str = "sysmedia";

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the sysmedia APIs.
pub trait SysmediaExt<R: Runtime> {
    fn sysmedia(&self) -> &Sysmedia<R>;
}

impl<R: Runtime, T: Manager<R>> crate::SysmediaExt<R> for T {
    fn sysmedia(&self) -> &Sysmedia<R> {
        self.state::<Sysmedia<R>>().inner()
    }
}

/// 读数回调：在插件自己的线程里调，要尽快返回（一般只是转发进通道）。
pub type OnEvent = Box<dyn Fn(MediaEvent) + Send + 'static>;

/// [`Sysmedia::watch`] 的句柄：丢弃即停止，停止后不再回调。
#[must_use = "丢弃即停止监视"]
pub struct Watch(#[allow(dead_code)] Option<Box<dyn Send>>);

impl Watch {
    /// 本平台没有数据源：什么都不持有。
    #[allow(dead_code)]
    pub(crate) fn inert() -> Self {
        Self(None)
    }

    #[allow(dead_code)]
    pub(crate) fn new(inner: impl Send + 'static) -> Self {
        Self(Some(Box::new(inner)))
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .setup(|app, api| {
            #[cfg(mobile)]
            let sysmedia = mobile::init(app, api)?;
            #[cfg(desktop)]
            let sysmedia = desktop::init(app, api)?;
            app.manage(sysmedia);
            Ok(())
        })
        .build()
}
