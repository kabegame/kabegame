//! 控制台 / 文件 / 应用日志层共用的级别过滤。
//!
//! 后端级别固定（release info、dev debug，依赖 crate 一律 warn），`KABEGAME_LOG` 用
//! `Targets` 语法覆盖其中提到的 target，例如 `kabegame_core::ipc=trace,webview=debug`。
//! 前端经 tauri-plugin-tracing 打出的日志 target 是空串，这里按 [`WEBVIEW_TARGET`] 处理。

use std::collections::BTreeMap;
use tracing::level_filters::LevelFilter;
use tracing::subscriber::Interest;
use tracing::{Level, Metadata};
use tracing_subscriber::filter::Targets;
use tracing_subscriber::layer::{Context, Filter};

/// 前端日志在过滤规则与展示里使用的名字。
pub const WEBVIEW_TARGET: &str = "webview";

/// 使用 [`AppFilter::default_levels`] 中「本仓库」级别的 target 前缀。
const OUR_TARGETS: &[&str] = &[
    "kabegame",
    "kabegame_core",
    "kabegame_cli",
    "pathql_rs",
    "tauri_runtime_cef",
    "tauri_plugin_pathes",
];

#[derive(Debug, Clone)]
pub struct AppFilter {
    targets: Targets,
    webview: LevelFilter,
}

impl AppFilter {
    fn ours() -> LevelFilter {
        if cfg!(debug_assertions) {
            LevelFilter::DEBUG
        } else {
            LevelFilter::INFO
        }
    }

    fn default_map() -> BTreeMap<String, LevelFilter> {
        let mut levels: BTreeMap<String, LevelFilter> = OUR_TARGETS
            .iter()
            .map(|t| (t.to_string(), Self::ours()))
            .collect();
        // 插件 `log` 命令外层的 span（带窗口 label 字段 `w`）必须对本过滤器可见。
        levels.insert("tauri_plugin_tracing".into(), LevelFilter::INFO);
        levels
    }

    fn build(
        default: LevelFilter,
        levels: BTreeMap<String, LevelFilter>,
        webview: LevelFilter,
    ) -> Self {
        Self {
            targets: Targets::new().with_default(default).with_targets(levels),
            webview,
        }
    }

    pub fn default_levels() -> Self {
        Self::build(LevelFilter::WARN, Self::default_map(), Self::ours())
    }

    /// 在默认级别上叠加 `spec`（`Targets` 语法；单独一个级别表示依赖 crate 的默认级别）。
    pub fn with_spec(spec: &str) -> Result<Self, String> {
        let parsed: Targets = spec.parse().map_err(|e| format!("{e}"))?;
        let mut levels = Self::default_map();
        let mut webview = Self::ours();
        for (target, level) in parsed.iter() {
            if target == WEBVIEW_TARGET {
                webview = level;
            } else {
                levels.insert(target.to_string(), level);
            }
        }
        let default = parsed.default_level().unwrap_or(LevelFilter::WARN);
        Ok(Self::build(default, levels, webview))
    }

    /// 读 `KABEGAME_LOG`；解析失败时退回默认级别，并把错误交给调用方在订阅器就绪后报告。
    pub fn from_env() -> (Self, Option<String>) {
        match std::env::var("KABEGAME_LOG") {
            Ok(spec) if !spec.trim().is_empty() => match Self::with_spec(&spec) {
                Ok(filter) => (filter, None),
                Err(e) => (
                    Self::default_levels(),
                    Some(format!("KABEGAME_LOG 无法解析（{e}），使用默认级别")),
                ),
            },
            _ => (Self::default_levels(), None),
        }
    }

    pub fn would_enable(&self, target: &str, level: &Level) -> bool {
        if target.is_empty() {
            *level <= self.webview
        } else {
            self.targets.would_enable(target, level)
        }
    }
}

impl<S> Filter<S> for AppFilter {
    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        self.would_enable(meta.target(), meta.level())
    }

    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> Interest {
        if self.would_enable(meta.target(), meta.level()) {
            Interest::always()
        } else {
            Interest::never()
        }
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        let targets = <Targets as Filter<S>>::max_level_hint(&self.targets)?;
        Some(targets.max(self.webview))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_keep_dependencies_at_warn() {
        let f = AppFilter::default_levels();
        assert!(f.would_enable("kabegame_core::storage", &Level::INFO));
        assert!(!f.would_enable("kabegame_core::storage", &Level::TRACE));
        assert!(!f.would_enable("hyper::proto", &Level::INFO));
        assert!(f.would_enable("hyper::proto", &Level::WARN));
        assert!(f.would_enable("tauri_plugin_tracing::commands", &Level::INFO));
        // debug ingest 的 TRACE 事件不进控制台 / 文件 / 查看器
        assert!(!f.would_enable("kabegame::debug", &Level::TRACE));
    }

    #[test]
    fn empty_target_uses_webview_level() {
        let f = AppFilter::default_levels();
        assert!(f.would_enable("", &Level::INFO));
        assert!(!f.would_enable("", &Level::TRACE));
        let f = AppFilter::with_spec("webview=error").unwrap();
        assert!(!f.would_enable("", &Level::WARN));
        assert!(f.would_enable("", &Level::ERROR));
    }

    #[test]
    fn spec_overlays_defaults() {
        let f = AppFilter::with_spec("kabegame_core::ipc=trace,hyper=debug").unwrap();
        assert!(f.would_enable("kabegame_core::ipc::server", &Level::TRACE));
        assert!(!f.would_enable("kabegame_core::storage", &Level::TRACE));
        assert!(f.would_enable("kabegame_core::storage", &Level::INFO));
        assert!(f.would_enable("hyper::proto", &Level::DEBUG));
        let f = AppFilter::with_spec("info").unwrap();
        assert!(f.would_enable("reqwest::connect", &Level::INFO));
        assert!(AppFilter::with_spec("kabegame=notalevel").is_err());
    }
}
