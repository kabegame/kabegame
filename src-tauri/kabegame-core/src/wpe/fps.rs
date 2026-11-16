//! WPE 壁纸的帧率设置：固定值或「跟随 WPE」。
//!
//! 桌面用全局设置 `wpeFps`，预览 / 应用背景用每张壁纸 metadata 的 `previewSettings.fps`；两处存的形状相同：
//! 整数（钳到 [`WPE_FPS_MIN`, `WPE_FPS_MAX`]）或字符串 `"follow"`。生效值只在 app 的
//! `wpe_web_pull_state` 里解析一次，经垫片的 `applyGeneralProperties({ fps })` 同时交给网页壁纸与场景宿主。
//!
//! 范围同 WPE 设置界面的帧率滑块：下限 10，上限是显示器最高刷新率（`runtime.frequencymax`，
//! `.claude/plans/tools/rea-wpe-settings.md`）。上限要运行时才知道，这里只钳一个宽松的上界，界面按刷新率再钳。

use serde_json::Value;

/// 下限：WPE 设置界面滑块的 `floor`。
pub const WPE_FPS_MIN: u32 = 10;
/// 存储层的宽松上界：显示器刷新率由界面现查，这里只挡明显不合理的值。
pub const WPE_FPS_MAX: u32 = 1000;
/// Kabegame 的默认帧率；跟随不可用时 `"follow"` 也取它（同前端 `wpeFpsDisplay`）。
pub const DEFAULT_WPE_FPS: u32 = 30;
/// WPE 自己的缺省：`config.json` 缺 `fps` 键时主进程填 15（`FUN_140046f20`，rea-wpe-settings.md 风险 1）。
pub const WPE_FPS_WHEN_MISSING: u32 = 15;

const FOLLOW: &str = "follow";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WpeFps {
    Fixed(u32),
    /// 跟随 WPE `config.json` 的 `general.user.fps`，只在第一次用到时读一次。
    Follow,
}

impl Default for WpeFps {
    fn default() -> Self {
        Self::Fixed(DEFAULT_WPE_FPS)
    }
}

impl WpeFps {
    /// 从存储或命令参数读：`"follow"`，或有限数（四舍五入、钳到范围）；其它返回 None。
    pub fn from_json(value: &Value) -> Option<Self> {
        if value.as_str() == Some(FOLLOW) {
            return Some(Self::Follow);
        }
        let number = value.as_f64().filter(|v| v.is_finite())?;
        let rounded = number.round().clamp(WPE_FPS_MIN as f64, WPE_FPS_MAX as f64);
        Some(Self::Fixed(rounded as u32))
    }

    /// 存储形状：整数或 `"follow"`（整数用 `u64` 存，免得 `30.0` 与 `30` 比较不等）。
    pub fn to_json(self) -> Value {
        match self {
            Self::Fixed(fps) => Value::from(u64::from(fps)),
            Self::Follow => Value::from(FOLLOW),
        }
    }
}

/// 解析成生效帧率：固定值原样；跟随时取 WPE 的值，跟随不可用（非 Windows、找不到或读不了 `config.json`）取默认 30。
#[cfg(feature = "wpe")]
pub fn resolve(fps: WpeFps) -> u32 {
    match fps {
        WpeFps::Fixed(fps) => fps,
        WpeFps::Follow => follow_fps().unwrap_or(DEFAULT_WPE_FPS),
    }
}

/// WPE `config.json` 里的帧率，第一次成功读到后缓存（WPE 自己也只在启动时读这个文件）；文件不存在或不是 JSON 时
/// 不缓存，之后设好 WPE 目录还能读到。会经 `engine_dir` 碰 Storage，调用方放到阻塞线程。
#[cfg(feature = "wpe")]
fn follow_fps() -> Option<u32> {
    use std::sync::OnceLock;
    static CACHED: OnceLock<u32> = OnceLock::new();
    if !cfg!(windows) {
        // 同 `get_wpe_follow_available`：跟随只在 Windows 上提供
        return None;
    }
    if let Some(fps) = CACHED.get() {
        return Some(*fps);
    }
    let path = super::discover::engine_dir()?.join("config.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|error| tracing::warn!("读 WPE config.json 失败（{}）：{error}", path.display()))
        .ok()?;
    let fps = fps_from_config(&text)?;
    tracing::info!("跟随 WPE 的帧率：{fps}");
    Some(*CACHED.get_or_init(|| fps))
}

/// 照 `apps/wpe-scene/src/compile/postprocess.ts` 的 `wpeUserValueOf` 取 `<用户>.general.user.fps`：顶层键是 Steam
/// 用户名，跳过 `?` 开头的安装信息，取第一个有正数 `fps` 的用户；都没有按 WPE 的缺省 15。文本不是 JSON 返回 None。
/// 工作区里 serde_json 经依赖开了 `preserve_order`（`Cargo.lock` 里它依赖 indexmap），多个用户时与 TS 一样按文件顺序取。
#[cfg_attr(not(feature = "wpe"), allow(dead_code))]
fn fps_from_config(text: &str) -> Option<u32> {
    let config: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let users = config.as_object()?;
    let fps = users
        .iter()
        .filter(|(key, _)| !key.starts_with('?'))
        .find_map(|(_, user)| {
            user.get("general")?
                .get("user")?
                .get("fps")?
                .as_f64()
                .filter(|fps| fps.is_finite() && *fps >= 1.0)
        })
        .map(|fps| fps.round().min(WPE_FPS_MAX as f64) as u32)
        .unwrap_or(WPE_FPS_WHEN_MISSING);
    Some(fps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_fixed_and_follow() {
        assert_eq!(WpeFps::from_json(&json!("follow")), Some(WpeFps::Follow));
        assert_eq!(WpeFps::from_json(&json!(60)), Some(WpeFps::Fixed(60)));
        assert_eq!(WpeFps::from_json(&json!(59.6)), Some(WpeFps::Fixed(60)));
        assert_eq!(
            WpeFps::from_json(&json!(5)),
            Some(WpeFps::Fixed(WPE_FPS_MIN))
        );
        assert_eq!(
            WpeFps::from_json(&json!(5000)),
            Some(WpeFps::Fixed(WPE_FPS_MAX))
        );
        assert_eq!(WpeFps::from_json(&json!("60")), None);
        assert_eq!(WpeFps::from_json(&json!(null)), None);
        assert_eq!(WpeFps::Fixed(30).to_json(), json!(30));
        assert_eq!(WpeFps::Follow.to_json(), json!("follow"));
    }

    #[test]
    fn reads_user_fps_from_config() {
        let text = "\u{feff}{\"?installdirectory\":\"C:/x\",\"alice\":{\"general\":{\"user\":{\"fps\":20}}}}";
        assert_eq!(fps_from_config(text), Some(20));
        // 缺键按 WPE 的缺省 15
        assert_eq!(
            fps_from_config("{\"alice\":{\"general\":{\"user\":{}}}}"),
            Some(WPE_FPS_WHEN_MISSING)
        );
        assert_eq!(fps_from_config("not json"), None);
    }
}
