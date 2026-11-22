//! GNOME 上查 Kabegame 窗口在全局逻辑坐标里的位置（同 Plasma 上的 `kwin_window`）：Wayland 不让应用知道自己的窗口在屏上哪里，
//! 问 Kabegame 的 GNOME Shell 扩展（总线名字 `app.kabegame.Shell` 上的 `/app/kabegame/Shell`，接口 `app.kabegame.Shell1`，
//! 常量在 [`super::extension`]）。
//!
//! - `GetWindowFrame(标题) -> (找到, x, y, 宽, 高)`：扩展只回答调用方进程自己的窗口（按 D-Bus 连接核对进程号），最小化的算找不到。
//!   几何是 mutter 的框架矩形（逻辑像素；客户端自绘的标题栏算在里面，阴影不算）。
//! - 主窗口的几何把壁纸窗口上的光标换到主窗口里（桌面 → 预览），反过来把主窗口里的光标换到壁纸上；壁纸窗口的几何给出它在
//!   全局坐标里的原点。
//! - 扩展不在（没装、没启用、shell 重启中）时给 `None`，两边就不互相跟光标；开始失败的那一刻确认扩展是否真的掉线，
//!   掉线就退回原生模式（[`super::extension_lost_if_offline`]）。

use std::time::{Duration, Instant};

use crate::wallpaper::manager::pointer_socket::FrameGeometry;

/// D-Bus 调用的超时：shell 卡住时不能拖住鼠标线程。
const CALL_TIMEOUT: Duration = Duration::from_millis(300);
/// 连不上 session bus 时多久再试。
const CONNECT_INTERVAL: Duration = Duration::from_secs(10);
use super::extension::{BUS_NAME as SERVICE, INTERFACE, OBJECT_PATH as PATH};

/// 经 Shell 扩展找 Kabegame 的窗口。不是线程安全的，给鼠标线程独占。
pub struct GnomeWindowLocator {
    connection: Option<zbus::blocking::Connection>,
    last_connect: Option<Instant>,
    /// 上次调用失败过（扩展不在）：只记一次日志
    failing: bool,
}

impl GnomeWindowLocator {
    pub fn new() -> Self {
        Self {
            connection: None,
            last_connect: None,
            failing: false,
        }
    }

    fn connection(&mut self) -> Option<zbus::blocking::Connection> {
        if self.connection.is_none()
            && self
                .last_connect
                .is_none_or(|at| at.elapsed() >= CONNECT_INTERVAL)
        {
            self.last_connect = Some(Instant::now());
            match zbus::blocking::connection::Builder::session()
                .and_then(|builder| builder.method_timeout(CALL_TIMEOUT).build())
            {
                Ok(connection) => self.connection = Some(connection),
                Err(error) => tracing::debug!("连不上 session bus，主窗口与壁纸不互相跟光标: {error}"),
            }
        }
        self.connection.clone()
    }

    /// 本进程里标题为 `title` 的窗口的框架几何；找不到、最小化或扩展不在时 `None`。
    pub fn locate(&mut self, title: &str) -> Option<FrameGeometry> {
        if title.is_empty() {
            return None;
        }
        let connection = self.connection()?;
        let reply = connection
            .call_method(Some(SERVICE), PATH, Some(INTERFACE), "GetWindowFrame", &(title,))
            .and_then(|reply| {
                reply
                    .body()
                    .deserialize::<(bool, f64, f64, f64, f64)>()
                    .map_err(Into::into)
            });
        let (found, x, y, width, height) = match reply {
            Ok(reply) => {
                self.failing = false;
                reply
            }
            Err(error) => {
                if !self.failing {
                    tracing::debug!("问 GNOME Shell 扩展窗口位置失败（扩展没装或没启用？）: {error}");
                    super::extension_lost_if_offline("问窗口位置失败");
                }
                self.failing = true;
                return None;
            }
        };
        (found && width > 0.0 && height > 0.0).then_some(FrameGeometry {
            x,
            y,
            width,
            height,
        })
    }
}
