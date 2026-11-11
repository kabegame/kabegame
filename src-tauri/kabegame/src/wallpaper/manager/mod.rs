pub mod native;
#[cfg(target_os = "macos")]
mod native_mac;
#[cfg(target_os = "linux")]
pub mod plasma_plugin;
#[cfg(target_os = "linux")]
pub mod plasma_qdbus;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub mod window;

// 导出管理器类型
pub use native::NativeWallpaperManager;
#[cfg(target_os = "linux")]
pub use plasma_plugin::PlasmaPluginWallpaperManager;
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use window::WindowWallpaperManager;

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Runtime};

use crate::wallpaper::screens::{self, ScreenInfo};
use kabegame_core::settings::{
    screen_target, Settings, WallpaperTargetConfig, TARGET_MULTIPLE, TARGET_SPAN,
};
use kabegame_core::storage::Storage;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperOption {
    pub value: String,
    pub label: Value,
    pub desc: Value,
}

/// 显示器模式：一张壁纸怎么落到多块屏上。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    /// 各屏复制：所有显示器同一张，一个目标 `multiple`
    Multiple,
    /// 跨屏拼接：整个桌面当一块画布，一个目标 `span`
    Span,
    /// 逐屏独立：每块在线屏一个目标 `screen:<id>`
    Single,
}

impl DisplayMode {
    pub const ALL: [DisplayMode; 3] = [
        DisplayMode::Multiple,
        DisplayMode::Span,
        DisplayMode::Single,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            DisplayMode::Multiple => "multiple",
            DisplayMode::Span => "span",
            DisplayMode::Single => "single",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.as_str() == value)
    }

    /// 选项名与说明的 i18n 键。
    fn i18n_keys(self) -> (&'static str, &'static str) {
        match self {
            DisplayMode::Multiple => (
                "settings.displayModeMultiple",
                "settings.displayModeMultipleDesc",
            ),
            DisplayMode::Span => ("settings.displayModeSpan", "settings.displayModeSpanDesc"),
            DisplayMode::Single => (
                "settings.displayModeSingle",
                "settings.displayModeSingleDesc",
            ),
        }
    }
}

/// 一个目标落在哪里。
#[derive(Debug, Clone, PartialEq)]
pub enum Placement {
    /// 所有在线屏显示同一张（`multiple`；也是没有屏幕信息的平台的唯一布置）
    All { screens: Vec<ScreenInfo> },
    /// 整个桌面当一块画布（`span`）；由系统铺放，后端不需要屏几何
    Span,
    /// 只有这一块屏（`single`）
    One { screen: ScreenInfo },
}

/// 当前布局：控制器据设置与在线屏算出，manager 与轮播都只读它。
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub display_mode: DisplayMode,
    /// 活跃目标，默认目标在前
    pub targets: Vec<(String, Placement)>,
    pub default_target: String,
}

impl Layout {
    pub fn target_ids(&self) -> Vec<String> {
        self.targets.iter().map(|(id, _)| id.clone()).collect()
    }

    pub fn placement_of(&self, target_id: &str) -> Option<&Placement> {
        self.targets
            .iter()
            .find(|(id, _)| id == target_id)
            .map(|(_, placement)| placement)
    }
}

/// 后端发给一个壁纸窗口的布置：显示哪个目标、出不出声。样式、过渡与当前壁纸由窗口自己从
/// `setting-change` 里的 `wallpaperTargets[targetId]` 读。
///
/// 窗口启动时用命令 `get_wallpaper_window_assignment` 取，之后变化时后端 `emit_to(label, "wallpaper-assignment")`。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowAssignment {
    pub target_id: String,
    /// `multiple` 下同一张壁纸各窗口各播一份，只有主屏窗口出声；`single` 下各屏各自出声
    pub audible: bool,
}

/// 按显示器模式、在线屏与默认屏算布局（纯函数）。
///
/// - `multiple` → 一个目标 `multiple`，覆盖全部在线屏；
/// - `span` → 一个目标 `span`；
/// - `single` → 每块在线屏一个 `screen:<id>`，默认目标是 `default_screen` 对应的屏，它不在线或未设置时取主屏
///   （不改写设置，屏回来后默认恢复）。没有屏幕信息时逐屏无从谈起，按 `multiple` 给出。
pub(crate) fn compute_layout(
    display_mode: DisplayMode,
    screens: &[ScreenInfo],
    default_screen: Option<&str>,
) -> Layout {
    let multiple = || Layout {
        display_mode: DisplayMode::Multiple,
        targets: vec![(
            TARGET_MULTIPLE.to_string(),
            Placement::All {
                screens: screens.to_vec(),
            },
        )],
        default_target: TARGET_MULTIPLE.to_string(),
    };
    match display_mode {
        DisplayMode::Multiple => multiple(),
        DisplayMode::Span => Layout {
            display_mode,
            targets: vec![(TARGET_SPAN.to_string(), Placement::Span)],
            default_target: TARGET_SPAN.to_string(),
        },
        DisplayMode::Single => {
            let default_index = default_screen
                .and_then(|id| screens.iter().position(|screen| screen.id == id))
                .or_else(|| screens.iter().position(|screen| screen.primary))
                .or_else(|| (!screens.is_empty()).then_some(0));
            let Some(default_index) = default_index else {
                return multiple();
            };
            let target = |screen: &ScreenInfo| {
                (
                    screen_target(&screen.id),
                    Placement::One {
                        screen: screen.clone(),
                    },
                )
            };
            let mut targets = vec![target(&screens[default_index])];
            targets.extend(
                screens
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| *index != default_index)
                    .map(|(_, screen)| target(screen)),
            );
            Layout {
                display_mode,
                default_target: targets[0].0.clone(),
                targets,
            }
        }
    }
}

/// 一个「壁纸模式 × 显示器模式」组合的能力。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayModeCapability {
    pub value: DisplayMode,
    pub label: Value,
    pub desc: Value,
    /// None = 可用；Some = 不可用的原因（i18n map），前端置灰并显示
    pub unavailable: Option<Value>,
    pub styles: Vec<WallpaperOption>,
    pub transitions: Vec<WallpaperOption>,
    /// true：该组合下样式对所有目标只有一个值，写样式时级联到全部活跃目标
    pub shared_style: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperCapabilities {
    pub modes: Vec<WallpaperOption>,
    /// 壁纸模式 → 该模式下列出的显示器模式（含不可用项及原因、各自的样式与过渡）
    pub display_modes: HashMap<String, Vec<DisplayModeCapability>>,
}

pub(super) fn i18n_map(key: &str) -> Value {
    let mut map = Map::new();
    map.insert(
        "default".into(),
        Value::from(kabegame_i18n::translate_for_locale(key, "en")),
    );
    for locale in kabegame_i18n::SUPPORTED_LOCALES {
        map.insert(
            (*locale).into(),
            Value::from(kabegame_i18n::translate_for_locale(key, locale)),
        );
    }
    Value::Object(map)
}

pub(super) fn wallpaper_option(
    value: &str,
    label_key: &str,
    desc_key: Option<&str>,
) -> WallpaperOption {
    WallpaperOption {
        value: value.to_string(),
        label: i18n_map(label_key),
        desc: desc_key.map(i18n_map).unwrap_or_else(|| json!({})),
    }
}

pub(super) fn style_options(values: &[&str]) -> Vec<WallpaperOption> {
    values
        .iter()
        .map(|value| {
            let suffix = match *value {
                "fill" => "Fill",
                "fit" => "Fit",
                "stretch" => "Stretch",
                "center" => "Center",
                "tile" => "Tile",
                _ => "Fill",
            };
            wallpaper_option(
                value,
                &format!("settings.style{}", suffix),
                Some(&format!("settings.style{}Desc", suffix)),
            )
        })
        .collect()
}

pub(super) fn transition_options(values: &[&str], none_label_key: &str) -> Vec<WallpaperOption> {
    values
        .iter()
        .map(|value| {
            let label_key = match *value {
                "none" => none_label_key,
                "fade" => "settings.transitionFade",
                "slide" => "settings.transitionSlide",
                "zoom" => "settings.transitionZoom",
                _ => none_label_key,
            };
            wallpaper_option(value, label_key, None)
        })
        .collect()
}

/// 目标里按壁纸模式存的值按能力归一化：在选项里就用它，否则取能力表第一项。
/// 前端 `useWallpaperTarget` 用同一条规则。
fn pick_option(stored: Option<&str>, options: &[WallpaperOption], fallback: &str) -> String {
    stored
        .filter(|value| options.iter().any(|option| option.value == *value))
        .or_else(|| options.first().map(|option| option.value.as_str()))
        .unwrap_or(fallback)
        .to_string()
}

/// 一个壁纸模式的样式 / 过渡选项（[`carry_to_mode`] 的入参）。
struct ModeOptions<'a> {
    mode: &'a str,
    styles: &'a [WallpaperOption],
    transitions: &'a [WallpaperOption],
}

/// 切壁纸模式时把一个目标的样式 / 过渡带到新模式名下（纯函数）。
///
/// 样式与过渡按壁纸模式各记各的：新模式名下已经有值就一律不动，来回切换后各模式仍是各自上次的设置。
/// 只有新模式名下还没有值（第一次进入这个模式）时，才取目标在旧模式下的有效值；新模式不支持这个值就不写，
/// 读取时照常按能力取第一项。
fn carry_to_mode(config: &mut WallpaperTargetConfig, old: &ModeOptions, new: &ModeOptions) {
    if !config.style.contains_key(new.mode) {
        let style = pick_option(
            config.style.get(old.mode).map(String::as_str),
            old.styles,
            "fill",
        );
        if new.styles.iter().any(|option| option.value == style) {
            config.style.insert(new.mode.to_string(), style);
        }
    }
    if !config.transition.contains_key(new.mode) {
        let transition = pick_option(
            config.transition.get(old.mode).map(String::as_str),
            old.transitions,
            "none",
        );
        if new
            .transitions
            .iter()
            .any(|option| option.value == transition)
        {
            config.transition.insert(new.mode.to_string(), transition);
        }
    }
}

/// 光标所在屏对应的壁纸目标（纯函数，托盘「下一张」用）：逐屏独立下是光标所在屏的目标；光标不在任何一块屏里
/// （`cursor_screen` 为 None）、或那块屏不在布局里时用默认目标。其它显示器模式只有一个目标，就是它。
pub(crate) fn target_for_cursor(layout: &Layout, cursor_screen: Option<&ScreenInfo>) -> String {
    if layout.display_mode == DisplayMode::Single {
        if let Some(screen) = cursor_screen {
            let id = screen_target(&screen.id);
            if layout.placement_of(&id).is_some() {
                return id;
            }
        }
    }
    layout.default_target.clone()
}

/// 在线屏变化后原生后端要补的输出（纯函数）：只给**新接入**的屏输出它该显示的目标，已在线的屏不动
/// （系统按屏记着各自的桌面图片，重设一遍只会白白闪一下）。`previous` 是变化前的在线屏。
///
/// - `All` 布置（各屏复制）：新接入的屏各出一条 [`Placement::One`]，目标仍是那一个；
/// - `One` 布置（逐屏独立）：屏是新接入的就原样输出；
/// - `Span`：由系统自己重排，不补。
///
/// 只是挪了位置、改了分辨率、换了主屏的屏不算新接入。
pub(crate) fn outputs_for_new_screens(
    layout: &Layout,
    previous: &[ScreenInfo],
) -> Vec<(String, Placement)> {
    let is_new = |screen: &ScreenInfo| !previous.iter().any(|known| known.id == screen.id);
    let one = |target_id: &String, screen: &ScreenInfo| {
        (
            target_id.clone(),
            Placement::One {
                screen: screen.clone(),
            },
        )
    };
    let mut outputs = Vec::new();
    for (target_id, placement) in &layout.targets {
        match placement {
            Placement::All { screens } => outputs.extend(
                screens
                    .iter()
                    .filter(|screen| is_new(screen))
                    .map(|screen| one(target_id, screen)),
            ),
            Placement::One { screen } if is_new(screen) => outputs.push(one(target_id, screen)),
            Placement::One { .. } | Placement::Span => {}
        }
    }
    outputs
}

/// 全新目标的平台默认过渡：Windows 为淡入淡出，其余平台就是能力表第一项（不写）。
const PLATFORM_DEFAULT_TRANSITION: &str = if cfg!(target_os = "windows") {
    "fade"
} else {
    "none"
};

/// 全局壁纸控制器：按当前 `wallpaper_mode` 选后端（native / window / plasma-plugin），并按显示器模式算布置。
///
/// 它是**唯一**知道显示器模式、活跃目标、默认目标、目标覆盖哪些屏的地方：对外给出 [`Layout`] / [`Placement`]，
/// manager 只照 `Placement` 输出，轮播器只按目标 id 调度；样式 / 过渡也只在这里按能力归一化。
/// core 的设置层只按目标 id 读写，不认识显示器模式。
pub struct WallpaperController {
    native: Arc<dyn WallpaperManager + Send + Sync>,
    #[cfg(target_os = "linux")]
    plasma_plugin: Arc<dyn WallpaperManager + Send + Sync>,
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    window: Arc<dyn WallpaperManager + Send + Sync>,
}

// 全局 WallpaperController 单例
pub static WALLPAPER_CONTROLLER: OnceLock<WallpaperController> = OnceLock::new();

impl WallpaperController {
    /// 初始化全局 WallpaperController（必须在首次使用前调用）
    pub fn init_global<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
        let controller = WallpaperController::new(app);
        WALLPAPER_CONTROLLER
            .set(controller)
            .map_err(|_| "WallpaperController already initialized".to_string())?;
        Self::global().align_settings();
        Ok(())
    }

    /// 获取全局 WallpaperController 引用
    pub fn global() -> &'static WallpaperController {
        WALLPAPER_CONTROLLER.get().expect(
            "WallpaperController not initialized. Call WallpaperController::init_global() first.",
        )
    }

    pub fn new<R: Runtime>(app: AppHandle<R>) -> Self {
        let native = Arc::new(NativeWallpaperManager::new(app.clone()))
            as Arc<dyn WallpaperManager + Send + Sync>;

        #[cfg(target_os = "linux")]
        let plasma_plugin = Arc::new(PlasmaPluginWallpaperManager::new(app.clone()))
            as Arc<dyn WallpaperManager + Send + Sync>;

        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let window =
            Arc::new(WindowWallpaperManager::new(app)) as Arc<dyn WallpaperManager + Send + Sync>;

        Self {
            native,
            #[cfg(target_os = "linux")]
            plasma_plugin,
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            window,
        }
    }

    /// 启动时把设置对齐到控制器的规则：保存的显示器模式在当前壁纸模式下不可用就回落 `multiple`
    /// （之后「设置里的显示器模式 = 实际生效的显示器模式」，前端可以直接照设置算活跃目标），
    /// 并给缺失的活跃目标补种（全新安装、新接入的屏）。
    fn align_settings(&self) {
        let settings = Settings::global();
        let effective = self.display_mode();
        if settings.get_wallpaper_display_mode() != effective.as_str() {
            if let Err(e) = settings.set_wallpaper_display_mode(effective.as_str()) {
                tracing::warn!("回落显示器模式失败: {e}");
            }
        }
        self.layout();
    }

    /// 根据当前设置选择活动后端（native/plasma-plugin/window等）。
    pub async fn active_manager(&self) -> Result<Arc<dyn WallpaperManager + Send + Sync>, String> {
        Ok(self.manager_for_mode(&Settings::global().get_wallpaper_mode()))
    }

    /// 按指定模式选择后端（不依赖 settings 中的 wallpaper_mode）。
    pub fn manager_for_mode(&self, mode: &str) -> Arc<dyn WallpaperManager + Send + Sync> {
        match mode {
            #[cfg(target_os = "linux")]
            "plasma-plugin" => self.plasma_plugin.clone(),
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            "window" => self.window.clone(),
            _ => self.native.clone(),
        }
    }

    /// 某个壁纸模式下列出哪些显示器模式：Android 与 Plasma 插件模式只有 `multiple`（前端据此不显示选择器），
    /// 其余列出全部三项，不可用的带原因。
    fn listed_display_modes(wallpaper_mode: &str) -> &'static [DisplayMode] {
        if cfg!(target_os = "android") || wallpaper_mode == "plasma-plugin" {
            &[DisplayMode::Multiple]
        } else {
            &DisplayMode::ALL
        }
    }

    pub fn capabilities(&self) -> WallpaperCapabilities {
        let mut modes = vec![wallpaper_option("native", "settings.modeNative", None)];

        #[cfg(any(target_os = "windows", target_os = "macos"))]
        modes.push(wallpaper_option("window", "settings.modeWindow", None));

        #[cfg(target_os = "linux")]
        if plasma_qdbus::is_kabegame_plasma_plugin_installed() {
            modes.push(wallpaper_option(
                "plasma-plugin",
                "settings.modePlugin",
                None,
            ));
        }

        let mut display_modes = HashMap::new();
        for mode in &modes {
            let manager = self.manager_for_mode(&mode.value);
            let listed = Self::listed_display_modes(&mode.value)
                .iter()
                .map(|display| {
                    let (label_key, desc_key) = display.i18n_keys();
                    DisplayModeCapability {
                        value: *display,
                        label: i18n_map(label_key),
                        desc: i18n_map(desc_key),
                        unavailable: manager.unavailable_reason(*display).map(i18n_map),
                        styles: manager.supported_styles(*display),
                        transitions: manager.supported_transitions(*display),
                        shared_style: manager.shared_style(*display),
                    }
                })
                .collect();
            display_modes.insert(mode.value.clone(), listed);
        }

        WallpaperCapabilities {
            modes,
            display_modes,
        }
    }

    /// 显示器模式 `display` 在壁纸模式 `wallpaper_mode` 下是否可选；不可选时返回原因的 i18n 键。
    pub fn display_mode_unavailable(
        &self,
        wallpaper_mode: &str,
        display: DisplayMode,
    ) -> Option<&'static str> {
        if !Self::listed_display_modes(wallpaper_mode).contains(&display) {
            return Some("settings.displayModeLater");
        }
        self.manager_for_mode(wallpaper_mode)
            .unavailable_reason(display)
    }

    /// 壁纸模式为 `wallpaper_mode` 时实际生效的显示器模式：设置里的值在该模式下不可用就按 `multiple`。
    pub fn display_mode_for(&self, wallpaper_mode: &str) -> DisplayMode {
        let wanted = DisplayMode::parse(&Settings::global().get_wallpaper_display_mode())
            .unwrap_or(DisplayMode::Multiple);
        if self
            .display_mode_unavailable(wallpaper_mode, wanted)
            .is_none()
        {
            wanted
        } else {
            DisplayMode::Multiple
        }
    }

    /// 当前生效的显示器模式。
    pub fn display_mode(&self) -> DisplayMode {
        self.display_mode_for(&Settings::global().get_wallpaper_mode())
    }

    /// 全新目标（没有可复制的来源）：平台默认过渡不是能力表第一项时显式写入当前壁纸模式名下。
    fn fresh_target(&self, display: DisplayMode) -> WallpaperTargetConfig {
        let mut config = WallpaperTargetConfig::default();
        let wallpaper_mode = Settings::global().get_wallpaper_mode();
        let transitions = self
            .manager_for_mode(&wallpaper_mode)
            .supported_transitions(display);
        let is_first = transitions
            .first()
            .is_some_and(|option| option.value == PLATFORM_DEFAULT_TRANSITION);
        if !is_first
            && transitions
                .iter()
                .any(|option| option.value == PLATFORM_DEFAULT_TRANSITION)
        {
            config
                .transition
                .insert(wallpaper_mode, PLATFORM_DEFAULT_TRANSITION.to_string());
        }
        config
    }

    /// 按 `display` 算布局，并把缺失的活跃目标落盘，保证之后各自独立：
    /// 种子优先用 `seed`（切换显示器模式时是切换前的默认目标），否则复制本布局的默认目标，都没有才用全新目标。
    pub fn layout_for(&self, display: DisplayMode, seed: Option<&WallpaperTargetConfig>) -> Layout {
        let settings = Settings::global();
        let layout = compute_layout(
            display,
            &screens::screens(),
            settings.get_wallpaper_default_screen().as_deref(),
        );
        let targets = settings.get_wallpaper_targets();
        if layout
            .targets
            .iter()
            .any(|(id, _)| !targets.contains_key(id))
        {
            let source = seed
                .cloned()
                .or_else(|| targets.get(&layout.default_target).cloned())
                .unwrap_or_else(|| self.fresh_target(layout.display_mode));
            for (id, _) in &layout.targets {
                if targets.contains_key(id) {
                    continue;
                }
                if let Err(e) = settings.update_wallpaper_target(id, || source.clone(), |_| {}) {
                    tracing::warn!("补种壁纸目标 {id} 失败: {e}");
                }
            }
        }
        layout
    }

    /// 当前布局：按设置与 `screens::screens()` 计算，顺带把缺失的活跃目标从种子落盘。
    pub fn layout(&self) -> Layout {
        self.layout_for(self.display_mode(), None)
    }

    /// 不指定目标的操作落到哪：命令层把 `target: Option<String>` 交给它解析。
    /// 指定的目标必须在活跃集合里，否则报错（防止给休眠屏、别的显示器模式的目标设图）。
    pub fn resolve_target(&self, target: Option<&str>) -> Result<(String, Placement), String> {
        let layout = self.layout();
        let wanted = target
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .unwrap_or(&layout.default_target)
            .to_string();
        layout
            .targets
            .into_iter()
            .find(|(id, _)| *id == wanted)
            .ok_or_else(|| format!("壁纸目标不在当前显示器模式的活跃集合里: {wanted}"))
    }

    /// 光标所在屏的目标（托盘「下一张」用）：逐屏独立下为光标所在屏，取不到时用默认目标；
    /// `multiple` / `span` 即唯一目标。
    pub fn target_at_cursor(&self) -> String {
        let layout = self.layout();
        let cursor_screen = screens::screen_at_cursor();
        let target = target_for_cursor(&layout, cursor_screen.as_ref());
        tracing::debug!(
            "光标所在屏: {}，对应壁纸目标: {target}",
            cursor_screen
                .as_ref()
                .map_or("（不在任何一块屏里）", |screen| screen
                    .id
                    .as_str())
        );
        target
    }

    /// `config` 在指定壁纸模式 × 显示器模式下按能力归一化后的样式。
    pub fn effective_style_in(
        &self,
        wallpaper_mode: &str,
        display: DisplayMode,
        config: &WallpaperTargetConfig,
    ) -> String {
        pick_option(
            config.style.get(wallpaper_mode).map(String::as_str),
            &self
                .manager_for_mode(wallpaper_mode)
                .supported_styles(display),
            "fill",
        )
    }

    /// `config` 在指定壁纸模式 × 显示器模式下按能力归一化后的过渡。
    pub fn effective_transition_in(
        &self,
        wallpaper_mode: &str,
        display: DisplayMode,
        config: &WallpaperTargetConfig,
    ) -> String {
        pick_option(
            config.transition.get(wallpaper_mode).map(String::as_str),
            &self
                .manager_for_mode(wallpaper_mode)
                .supported_transitions(display),
            "none",
        )
    }

    /// 当前壁纸模式 × 显示器模式下的有效样式（读目标里 `style[mode]`，不合法取能力第一项）。
    pub fn effective_style(&self, config: &WallpaperTargetConfig) -> String {
        self.effective_style_in(
            &Settings::global().get_wallpaper_mode(),
            self.display_mode(),
            config,
        )
    }

    /// 当前壁纸模式 × 显示器模式下的有效过渡。
    pub fn effective_transition(&self, config: &WallpaperTargetConfig) -> String {
        self.effective_transition_in(
            &Settings::global().get_wallpaper_mode(),
            self.display_mode(),
            config,
        )
    }

    /// 切壁纸模式时沿用样式 / 过渡：样式按壁纸模式各记各的，只有目标在新模式名下还没有值（第一次进入这个模式）
    /// 时，才把它在旧模式下的有效值带过去；已有值一律不动。规则见 [`carry_to_mode`]。
    pub fn carry_style_to_mode(&self, old_mode: &str, new_mode: &str) -> Result<(), String> {
        let old_display = self.display_mode_for(old_mode);
        let new_display = self.display_mode_for(new_mode);
        let old_manager = self.manager_for_mode(old_mode);
        let new_manager = self.manager_for_mode(new_mode);
        let old = ModeOptions {
            mode: old_mode,
            styles: &old_manager.supported_styles(old_display),
            transitions: &old_manager.supported_transitions(old_display),
        };
        let new = ModeOptions {
            mode: new_mode,
            styles: &new_manager.supported_styles(new_display),
            transitions: &new_manager.supported_transitions(new_display),
        };
        Settings::global().update_all_wallpaper_targets(|_, config| {
            carry_to_mode(config, &old, &new);
        })
    }

    /// 把一个目标的当前壁纸重新输出一次（改样式、改显示器模式后用）。
    /// 目标没有当前壁纸、图片行或文件已不存在时什么都不做。
    pub async fn reapply_target(&self, target_id: &str) -> Result<(), String> {
        let (target_id, placement) = self.resolve_target(Some(target_id))?;
        self.output_current(&target_id, &placement).await
    }

    /// 把目标 `target_id` 的当前壁纸按 `placement` 输出一次。`placement` 可以比目标的布置窄
    /// （屏幕变化后只给新接入的那块屏输出）。目标没有当前壁纸、图片行或文件已不存在时什么都不做。
    async fn output_current(&self, target_id: &str, placement: &Placement) -> Result<(), String> {
        let Some(config) = Settings::global().get_wallpaper_target(target_id) else {
            return Ok(());
        };
        let Some(image_id) = config.current_image_id.as_deref() else {
            return Ok(());
        };
        let Some(image) =
            Storage::find_image_by_id(image_id).map_err(|e| format!("Storage error: {}", e))?
        else {
            return Ok(());
        };
        let path = image.local_path;
        if !path.starts_with("content://") && !std::path::Path::new(&path).exists() {
            return Ok(());
        }
        self.active_manager()
            .await?
            .set_wallpaper(
                &path,
                &self.effective_style(&config),
                &self.effective_transition(&config),
                placement,
            )
            .await
    }

    /// label 为 `label` 的壁纸窗口的布置；不是壁纸窗口、窗口不在册、或本平台没有窗口模式时为 None。
    pub fn window_assignment(&self, label: &str) -> Option<WindowAssignment> {
        if !crate::wallpaper::is_wallpaper_label(label) {
            return None;
        }
        self.manager_for_mode("window").window_assignment(label)
    }

    /// 把壁纸模式 `wallpaper_mode` 的后端对齐到当前布局，再把各活跃目标重新输出一次
    /// （显示器模式或在线屏变了之后用）。
    ///
    /// 对齐可能要建窗并等页面就绪，放到阻塞线程上；重新输出对窗口后端只是按各窗口的目标开关桌面鼠标转发
    /// （内容由窗口自己读），对原生后端是把每个目标的当前壁纸再设一次。
    async fn realign_outputs(&self, wallpaper_mode: &str) {
        let manager = self.manager_for_mode(wallpaper_mode);
        match tokio::task::spawn_blocking(move || manager.reconcile()).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("对齐壁纸后端失败: {e}"),
            Err(e) => tracing::warn!("对齐壁纸后端的任务异常退出: {e}"),
        }
        for (target_id, _) in self.layout().targets {
            if let Err(e) = self.reapply_target(&target_id).await {
                tracing::warn!("重新输出目标 {target_id} 失败: {e}");
            }
        }
    }

    /// 在线屏变化后（`screens` 的 watcher 换完缓存时调用，`previous` 是变化前的在线屏）：重算布局，
    /// 给新接入的屏补种目标；随后按壁纸模式让输出跟上：
    ///
    /// - 窗口模式：把窗口集合对齐到在线屏（新屏建窗、断开的屏销毁窗口，其余窗口不动）；
    /// - 原生模式（后端能逐屏输出时）：只给新接入的屏输出它该显示的目标——各屏复制下是那同一张，逐屏独立下是
    ///   它自己的目标（刚补种的或它以前留下的）。已在线的屏不重设，断开的屏什么都不用做
    ///   （规则见 [`outputs_for_new_screens`]）。
    ///
    /// 不碰轮播计时。在 watcher 线程上调用：补种是同步的（前端收到屏幕事件时目标配置已经在了），窗口对齐要等
    /// 页面就绪、原生输出要等系统，都交给异步运行时，不挡住 watcher 发事件。对齐时布局在后端的锁内现算，
    /// 先后到达的几次变化不会互相覆盖。
    pub fn on_screens_changed(&self, previous: &[ScreenInfo]) {
        let layout = self.layout();
        tracing::debug!(
            "屏幕变化后的布局: {} 个活跃目标，默认 {}",
            layout.targets.len(),
            layout.default_target
        );
        let settings = Settings::global();
        if !settings.get_wallpaper_enabled() {
            return;
        }
        match settings.get_wallpaper_mode().as_str() {
            "window" => {
                tauri::async_runtime::spawn(async {
                    Self::global().realign_outputs("window").await;
                });
            }
            // 逐屏独立可用 = 后端能只设一块屏；不能逐屏的后端（系统自己把同一张铺到新屏上）不补
            "native"
                if self
                    .native
                    .unavailable_reason(DisplayMode::Single)
                    .is_none() =>
            {
                let outputs = outputs_for_new_screens(&layout, previous);
                if outputs.is_empty() {
                    return;
                }
                tauri::async_runtime::spawn(async move {
                    let controller = Self::global();
                    for (target_id, placement) in outputs {
                        if let Err(e) = controller.output_current(&target_id, &placement).await {
                            tracing::warn!("给新接入的屏输出目标 {target_id} 失败: {e}");
                        }
                    }
                });
            }
            _ => {}
        }
    }

    /// 切换显示器模式：校验能力 → 停轮播 → 写设置 → 重算布局（缺的目标从切换前的默认目标复制）→
    /// 后端对齐并逐目标重新输出 → 按开关恢复轮播。
    pub async fn set_display_mode(&self, mode: DisplayMode) -> Result<(), String> {
        let settings = Settings::global();
        let wallpaper_mode = settings.get_wallpaper_mode();
        if let Some(reason) = self.display_mode_unavailable(&wallpaper_mode, mode) {
            return Err(kabegame_i18n::translate(reason));
        }
        if settings.get_wallpaper_display_mode() == mode.as_str() {
            return Ok(());
        }

        let rotator = crate::wallpaper::WallpaperRotator::global();
        if rotator.is_running() {
            rotator.stop();
        }

        let seed = settings.get_wallpaper_target(&self.layout().default_target);
        settings.set_wallpaper_display_mode(mode.as_str())?;
        // 先补种再对齐：窗口拿到新布置时，它的目标配置已经落盘
        self.layout_for(self.display_mode(), seed.as_ref());

        if settings.get_wallpaper_enabled() {
            self.realign_outputs(&wallpaper_mode).await;
            if let Err(e) = rotator.start().await {
                tracing::warn!("set_display_mode: 恢复轮播失败: {e}");
            }
        }
        Ok(())
    }

    /// 拉起**当前应该活跃**的后端。
    ///
    /// 不变量：**壁纸窗口存在 ⟺ `wallpaperMode == "window"` ∧ `wallpaperEnabled`**。
    /// 本函数是该不变量的唯一实现处，两个条件缺一不可：
    /// - 不看 mode：`WindowWallpaperManager::init()` 会建窗并挂到桌面层，native 模式下
    ///   调用它等于凭空在桌面上盖一层窗口。
    /// - 不看 enabled：用户关掉壁纸后重启，窗口会照样挂出来——他关的东西又回来了。
    ///
    /// 切换由 `commands/wallpaper.rs` 负责：模式切换走 `apply_backend_lifecycle`
    /// （它 init 的是**目标**模式，此时 mode 尚未落盘，故不能复用本函数；其入口有
    /// `reject_if_wallpaper_disabled` 守卫）；开关走 `set_wallpaper_enabled`
    /// （关 → `cleanup()`，开 → 本函数）。
    pub fn init(&self) -> Result<(), String> {
        let settings = Settings::global();
        if !settings.get_wallpaper_enabled() {
            return Ok(());
        }
        self.manager_for_mode(&settings.get_wallpaper_mode()).init()
    }
}

use async_trait::async_trait;

/// 壁纸管理器 trait，定义壁纸设置的通用接口
#[async_trait]
pub trait WallpaperManager: Send + Sync {
    /// 该显示器模式下可选的样式。显示器模式不可用时内容无意义，可用与否由 `unavailable_reason` 判断。
    fn supported_styles(&self, display: DisplayMode) -> Vec<WallpaperOption>;

    /// 该显示器模式下可选的过渡，约定同 `supported_styles`。
    fn supported_transitions(&self, display: DisplayMode) -> Vec<WallpaperOption>;

    /// 该显示器模式不可用的原因（i18n 键）；None = 可用。默认只开放 `multiple`，后端按自己的能力覆盖。
    fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str> {
        (display != DisplayMode::Multiple).then_some("settings.displayModeLater")
    }

    /// true：该显示器模式下样式对所有目标只有一个值（系统只有一个全局位置），写样式时级联。
    fn shared_style(&self, _display: DisplayMode) -> bool {
        false
    }

    /// 一次输出 = 文件 + 样式 + 过渡 + 布置。后端不反读设置，参数全部由调用方带入。
    ///
    /// # Arguments
    /// * `file_path` - 壁纸文件路径（WPE 壁纸为目录）
    /// * `style` - 显示样式（fill/fit/stretch/center/tile）
    /// * `transition` - 过渡效果（none/fade/slide/zoom）
    /// * `placement` - 这个目标落在哪些屏
    async fn set_wallpaper(
        &self,
        file_path: &str,
        style: &str,
        transition: &str,
        placement: &Placement,
    ) -> Result<(), String>;

    /// 把后端的输出面（窗口集合）对齐到当前布局；没有输出面要维护的后端为空实现。
    ///
    /// 不带布局参数：布局由后端在自己的锁内现算（`WallpaperController::layout_for`），否则调用方先算好、
    /// 排队等锁期间屏幕又变了，旧布局会盖掉新布局。后端尚未 `init`（或已 `cleanup`）时什么都不做。
    fn reconcile(&self) -> Result<(), String> {
        Ok(())
    }

    /// 壁纸窗口 `label` 的布置；只有窗口后端有。
    fn window_assignment(&self, _label: &str) -> Option<WindowAssignment> {
        None
    }

    /// 清理资源（如关闭窗口等）
    #[allow(dead_code)]
    fn cleanup(&self) -> Result<(), String>;

    /// 初始化管理器（如创建窗口等）
    ///
    fn init(&self) -> Result<(), String>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn screen(id: &str, primary: bool) -> ScreenInfo {
        ScreenInfo {
            id: id.to_string(),
            name: None,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            pixel_width: 1920,
            pixel_height: 1080,
            scale: 1.0,
            primary,
        }
    }

    fn option(value: &str) -> WallpaperOption {
        WallpaperOption {
            value: value.to_string(),
            label: json!({}),
            desc: json!({}),
        }
    }

    #[test]
    fn display_mode_round_trips_as_lowercase() {
        for mode in DisplayMode::ALL {
            assert_eq!(DisplayMode::parse(mode.as_str()), Some(mode));
            assert_eq!(serde_json::to_value(mode).unwrap(), json!(mode.as_str()));
        }
        assert_eq!(DisplayMode::parse("everywhere"), None);
    }

    #[test]
    fn multiple_is_one_target_over_all_screens() {
        let screens = [screen("a", true), screen("b", false)];
        let layout = compute_layout(DisplayMode::Multiple, &screens, Some("b"));
        assert_eq!(layout.default_target, "multiple");
        assert_eq!(
            layout.targets,
            vec![(
                "multiple".to_string(),
                Placement::All {
                    screens: screens.to_vec()
                }
            )]
        );
        // 没有屏幕信息的平台：同一个目标，屏列表为空
        let layout = compute_layout(DisplayMode::Multiple, &[], None);
        assert_eq!(layout.target_ids(), vec!["multiple"]);
    }

    #[test]
    fn span_is_one_target_without_geometry() {
        let layout = compute_layout(DisplayMode::Span, &[screen("a", true)], None);
        assert_eq!(layout.default_target, "span");
        assert_eq!(layout.targets, vec![("span".to_string(), Placement::Span)]);
    }

    #[test]
    fn single_lists_each_screen_with_default_first() {
        let screens = [screen("a", true), screen("b", false), screen("c", false)];
        // 默认屏在线：它排第一，其余保持枚举顺序
        let layout = compute_layout(DisplayMode::Single, &screens, Some("b"));
        assert_eq!(layout.display_mode, DisplayMode::Single);
        assert_eq!(layout.default_target, "screen:b");
        assert_eq!(
            layout.target_ids(),
            vec!["screen:b", "screen:a", "screen:c"]
        );
        assert_eq!(
            layout.placement_of("screen:c"),
            Some(&Placement::One {
                screen: screens[2].clone()
            })
        );
        // 默认屏不在线或未设置：取主屏
        for default_screen in [Some("gone"), None] {
            let layout = compute_layout(DisplayMode::Single, &screens, default_screen);
            assert_eq!(layout.default_target, "screen:a");
        }
    }

    #[test]
    fn single_without_screens_falls_back_to_multiple() {
        let layout = compute_layout(DisplayMode::Single, &[], Some("a"));
        assert_eq!(layout.display_mode, DisplayMode::Multiple);
        assert_eq!(layout.target_ids(), vec!["multiple"]);
    }

    /// 主屏 `main` 在原点，副屏 `side` 在它右边、顶边低 82（两屏高低错开，右上留一个空角）。
    fn two_screens() -> [ScreenInfo; 2] {
        let mut main = screen("main", true);
        (main.width, main.height) = (1512, 982);
        let mut side = screen("side", false);
        (side.x, side.y, side.width, side.height) = (1512, 82, 1440, 900);
        [main, side]
    }

    /// 光标在 (x, y) 时托盘「下一张」落到哪个目标。
    fn target_at(layout: &Layout, screens: &[ScreenInfo], x: f64, y: f64) -> String {
        target_for_cursor(layout, screens::screen_containing(screens, x, y))
    }

    #[test]
    fn cursor_picks_the_target_of_the_screen_under_it() {
        let screens = two_screens();
        // 默认屏设成副屏，确认光标在主屏时不是「落到默认目标」蒙对的
        let layout = compute_layout(DisplayMode::Single, &screens, Some("side"));
        assert_eq!(layout.default_target, "screen:side");
        assert_eq!(target_at(&layout, &screens, 10.0, 10.0), "screen:main");
        assert_eq!(target_at(&layout, &screens, 1511.9, 981.9), "screen:main");
        assert_eq!(target_at(&layout, &screens, 1512.0, 82.0), "screen:side");
        assert_eq!(target_at(&layout, &screens, 2951.9, 981.9), "screen:side");
    }

    #[test]
    fn cursor_outside_every_screen_falls_back_to_default_target() {
        let screens = two_screens();
        for default_screen in ["main", "side"] {
            let layout = compute_layout(DisplayMode::Single, &screens, Some(default_screen));
            let default_target = format!("screen:{default_screen}");
            // 副屏上方的空角、整个桌面之外
            assert_eq!(target_at(&layout, &screens, 2000.0, 10.0), default_target);
            assert_eq!(target_at(&layout, &screens, -5.0, 10.0), default_target);
            // 取不到光标位置
            assert_eq!(target_for_cursor(&layout, None), default_target);
        }
    }

    #[test]
    fn cursor_on_a_screen_missing_from_layout_falls_back_to_default_target() {
        // 光标读到的屏比布局新（刚接上、布局还没重算）：不能给出布局里没有的目标
        let screens = two_screens();
        let layout = compute_layout(DisplayMode::Single, &screens[..1], None);
        assert_eq!(target_for_cursor(&layout, Some(&screens[1])), "screen:main");
    }

    #[test]
    fn cursor_is_ignored_outside_single_mode() {
        let screens = two_screens();
        // 各屏复制 / 跨屏拼接只有一个目标，光标在哪块屏都是它
        for (mode, target) in [
            (DisplayMode::Multiple, "multiple"),
            (DisplayMode::Span, "span"),
        ] {
            let layout = compute_layout(mode, &screens, Some("side"));
            assert_eq!(target_at(&layout, &screens, 10.0, 10.0), target);
            assert_eq!(target_at(&layout, &screens, 2000.0, 500.0), target);
            assert_eq!(target_for_cursor(&layout, None), target);
        }
    }

    #[test]
    fn cursor_without_any_screen_info_uses_the_only_target() {
        // 没有显示器枚举的平台：逐屏独立按 multiple 给出，光标也无屏可落
        let layout = compute_layout(DisplayMode::Single, &[], Some("side"));
        assert_eq!(target_at(&layout, &[], 10.0, 10.0), "multiple");
        assert_eq!(target_for_cursor(&layout, None), "multiple");
    }

    /// 补输出的 (目标, 屏 id)；补的都是只落一块屏的布置。
    fn new_screen_outputs(layout: &Layout, previous: &[ScreenInfo]) -> Vec<(String, String)> {
        outputs_for_new_screens(layout, previous)
            .into_iter()
            .map(|(target_id, placement)| match placement {
                Placement::One { screen } => (target_id, screen.id),
                other => panic!("补输出应当只落一块屏: {other:?}"),
            })
            .collect()
    }

    fn pair(target_id: &str, screen_id: &str) -> (String, String) {
        (target_id.to_string(), screen_id.to_string())
    }

    #[test]
    fn newly_connected_screen_gets_the_shared_wallpaper_in_multiple() {
        let screens = two_screens();
        let layout = compute_layout(DisplayMode::Multiple, &screens, None);
        // 副屏刚接上：只给它输出，目标仍是 multiple；主屏不重设
        assert_eq!(
            new_screen_outputs(&layout, &screens[..1]),
            vec![pair("multiple", "side")]
        );
        // 变化前一块屏都没有（比如全部显示器休眠后醒来）：每块屏都算新接入
        assert_eq!(
            new_screen_outputs(&layout, &[]),
            vec![pair("multiple", "main"), pair("multiple", "side")]
        );
    }

    #[test]
    fn newly_connected_screen_gets_its_own_target_in_single() {
        let screens = two_screens();
        // 默认屏是副屏：新接入的是不是默认屏不影响结论
        for default_screen in ["main", "side"] {
            let layout = compute_layout(DisplayMode::Single, &screens, Some(default_screen));
            assert_eq!(
                new_screen_outputs(&layout, &screens[..1]),
                vec![pair("screen:side", "side")]
            );
            assert_eq!(
                new_screen_outputs(&layout, &screens[1..]),
                vec![pair("screen:main", "main")]
            );
        }
    }

    #[test]
    fn screens_already_online_are_not_output_again() {
        let screens = two_screens();
        for mode in [DisplayMode::Multiple, DisplayMode::Single] {
            // 屏没有增加：断开了一块（布局里只剩主屏）
            let layout = compute_layout(mode, &screens[..1], None);
            assert!(new_screen_outputs(&layout, &screens).is_empty(), "{mode:?}");

            // 屏只是挪了位置、改了分辨率、换了主屏：id 没变就不算新接入
            let mut moved = screens.clone();
            (moved[1].x, moved[1].y, moved[1].width) = (-1440, 0, 1920);
            moved[0].primary = false;
            moved[1].primary = true;
            let layout = compute_layout(mode, &moved, None);
            assert!(new_screen_outputs(&layout, &screens).is_empty(), "{mode:?}");
        }
    }

    #[test]
    fn span_and_screenless_layouts_have_nothing_to_output() {
        let screens = two_screens();
        // 跨屏拼接由系统自己重排
        let layout = compute_layout(DisplayMode::Span, &screens, None);
        assert!(new_screen_outputs(&layout, &screens[..1]).is_empty());
        // 没有屏幕信息的平台：布置里没有屏，自然没有新接入的
        let layout = compute_layout(DisplayMode::Multiple, &[], None);
        assert!(new_screen_outputs(&layout, &[]).is_empty());
    }

    fn options(values: &[&str]) -> Vec<WallpaperOption> {
        values.iter().map(|value| option(value)).collect()
    }

    fn target_config(style: &[(&str, &str)], transition: &[(&str, &str)]) -> WallpaperTargetConfig {
        let map = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(mode, value)| (mode.to_string(), value.to_string()))
                .collect()
        };
        WallpaperTargetConfig {
            style: map(style),
            transition: map(transition),
            ..Default::default()
        }
    }

    /// 切一次壁纸模式对一组目标的效果（`carry_style_to_mode` 对设置里每个目标做的事）。
    fn switch_mode(
        targets: &mut BTreeMap<String, WallpaperTargetConfig>,
        old: &ModeOptions,
        new: &ModeOptions,
    ) {
        for config in targets.values_mut() {
            carry_to_mode(config, old, new);
        }
    }

    #[test]
    fn first_entry_into_a_mode_carries_the_current_values() {
        let window_styles = options(&["fill", "fit", "stretch", "center", "tile"]);
        let window_transitions = options(&["none", "fade", "slide", "zoom"]);
        let native_styles = options(&["fill", "fit"]);
        let native_transitions = options(&["none", "fade"]);
        let window = ModeOptions {
            mode: "window",
            styles: &window_styles,
            transitions: &window_transitions,
        };
        let native = ModeOptions {
            mode: "native",
            styles: &native_styles,
            transitions: &native_transitions,
        };

        // 新模式名下还没有值，且新模式支持旧模式的当前值：带过去
        let mut config = target_config(&[("window", "fit")], &[("window", "fade")]);
        carry_to_mode(&mut config, &window, &native);
        assert_eq!(config.style["native"], "fit");
        assert_eq!(config.transition["native"], "fade");
        assert_eq!(config.style["window"], "fit");

        // 新模式不支持：不写，读取时照常取能力表第一项
        let mut config = target_config(&[("window", "tile")], &[("window", "zoom")]);
        carry_to_mode(&mut config, &window, &native);
        assert!(!config.style.contains_key("native"));
        assert!(!config.transition.contains_key("native"));

        // 旧模式名下也没有值：按旧模式的有效值（能力表第一项）带过去
        let mut config = target_config(&[], &[]);
        carry_to_mode(&mut config, &window, &native);
        assert_eq!(config.style["native"], "fill");
        assert_eq!(config.transition["native"], "none");

        // 样式与过渡各看各的：新模式名下只缺过渡时只带过渡
        let mut config = target_config(
            &[("window", "fit"), ("native", "fill")],
            &[("window", "fade")],
        );
        carry_to_mode(&mut config, &window, &native);
        assert_eq!(config.style["native"], "fill");
        assert_eq!(config.transition["native"], "fade");
    }

    #[test]
    fn window_values_survive_a_round_trip_through_native() {
        let window_styles = options(&["fill", "fit", "stretch", "center", "tile"]);
        let window_transitions = options(&["none", "fade", "slide", "zoom"]);
        // 样式只有 fill、过渡只有 none 的原生后端（Android；macOS 原生在逐屏 API 之前也是这样）
        let native_styles = options(&["fill"]);
        let native_transitions = options(&["none"]);
        let window = ModeOptions {
            mode: "window",
            styles: &window_styles,
            transitions: &window_transitions,
        };
        let native = ModeOptions {
            mode: "native",
            styles: &native_styles,
            transitions: &native_transitions,
        };

        let mut targets = BTreeMap::from([(
            "multiple".to_string(),
            target_config(
                &[("window", "fit"), ("native", "fill")],
                &[("window", "fade"), ("native", "none")],
            ),
        )]);
        let before = targets.clone();
        switch_mode(&mut targets, &window, &native);
        switch_mode(&mut targets, &native, &window);
        // 两个模式名下都已有值：来回一趟什么都不改
        assert_eq!(targets, before);

        // 原生模式名下原先没有值：第一次进入原生时不支持「适应 / 淡入淡出」所以不写，切回窗口后窗口的值仍在
        let mut targets = BTreeMap::from([(
            "multiple".to_string(),
            target_config(&[("window", "fit")], &[("window", "fade")]),
        )]);
        switch_mode(&mut targets, &window, &native);
        switch_mode(&mut targets, &native, &window);
        assert_eq!(targets["multiple"].style["window"], "fit");
        assert_eq!(targets["multiple"].transition["window"], "fade");
    }

    #[test]
    fn window_styles_carry_into_macos_native_except_tile() {
        let window_styles = options(&["fill", "fit", "stretch", "center", "tile"]);
        let window_transitions = options(&["none", "fade", "slide", "zoom"]);
        // macOS 原生：NSWorkspace 的四种缩放，没有平铺；过渡跟随系统
        let native_styles = options(&["fill", "fit", "stretch", "center"]);
        let native_transitions = options(&["none"]);
        let window = ModeOptions {
            mode: "window",
            styles: &window_styles,
            transitions: &window_transitions,
        };
        let native = ModeOptions {
            mode: "native",
            styles: &native_styles,
            transitions: &native_transitions,
        };

        // 第一次进入原生：窗口模式的适应 / 拉伸 / 居中原生也有，带过去
        for style in ["fit", "stretch", "center"] {
            let mut config = target_config(&[("window", style)], &[("window", "fade")]);
            carry_to_mode(&mut config, &window, &native);
            assert_eq!(config.style["native"], style);
            // 淡入淡出原生没有：不写
            assert!(!config.transition.contains_key("native"));
        }

        // 平铺原生没有：不写，原生模式读取时按能力取第一项（填充）；窗口模式名下的平铺不动
        let mut config = target_config(&[("window", "tile")], &[]);
        carry_to_mode(&mut config, &window, &native);
        assert!(!config.style.contains_key("native"));
        assert_eq!(pick_option(None, &native_styles, "fill"), "fill");
        assert_eq!(config.style["window"], "tile");

        // 原生名下已有值（哪怕是旧版留下的填充）：各记各的，不被窗口模式的值覆盖
        let mut config = target_config(&[("window", "fit"), ("native", "fill")], &[]);
        carry_to_mode(&mut config, &window, &native);
        assert_eq!(config.style["native"], "fill");

        // 反过来第一次进入窗口：原生的四种窗口模式都有
        let mut config = target_config(&[("native", "center")], &[]);
        carry_to_mode(&mut config, &native, &window);
        assert_eq!(config.style["window"], "center");
    }

    #[test]
    fn per_screen_targets_survive_a_round_trip_through_native() {
        let window_styles = options(&["fill", "fit", "stretch", "center", "tile"]);
        let window_transitions = options(&["none", "fade", "slide", "zoom"]);
        let native_styles = options(&["fill", "fit", "stretch", "center", "tile"]);
        let native_transitions = options(&["none", "fade"]);
        let window = ModeOptions {
            mode: "window",
            styles: &window_styles,
            transitions: &window_transitions,
        };
        let native = ModeOptions {
            mode: "native",
            styles: &native_styles,
            transitions: &native_transitions,
        };

        // 逐屏独立下副屏在窗口模式设了「适应 / 淡入淡出」；切到原生时显示器模式回落 multiple，
        // 两个逐屏目标不再活跃，但沿用规则照样对它们执行
        let mut targets = BTreeMap::from([
            (
                "multiple".to_string(),
                target_config(
                    &[("window", "fill"), ("native", "fill")],
                    &[("window", "none"), ("native", "none")],
                ),
            ),
            (
                "screen:main".to_string(),
                target_config(
                    &[("window", "fill"), ("native", "fill")],
                    &[("window", "none"), ("native", "none")],
                ),
            ),
            (
                "screen:side".to_string(),
                target_config(
                    &[("window", "fit"), ("native", "fill")],
                    &[("window", "fade"), ("native", "none")],
                ),
            ),
        ]);
        let before = targets.clone();
        switch_mode(&mut targets, &window, &native);
        // 原生模式名下已有的「填充 / 无」不被窗口模式的值覆盖
        assert_eq!(targets["screen:side"].style["native"], "fill");
        assert_eq!(targets["screen:side"].transition["native"], "none");
        switch_mode(&mut targets, &native, &window);
        assert_eq!(targets["screen:side"].style["window"], "fit");
        assert_eq!(targets["screen:side"].transition["window"], "fade");
        assert_eq!(targets, before);
    }

    #[test]
    fn stored_value_is_normalized_against_options() {
        let options = [option("fill"), option("fit")];
        assert_eq!(pick_option(Some("fit"), &options, "fill"), "fit");
        // 不在能力里、或没存过：取第一项
        assert_eq!(pick_option(Some("tile"), &options, "fill"), "fill");
        assert_eq!(pick_option(None, &options, "fill"), "fill");
        assert_eq!(pick_option(Some("fit"), &[], "none"), "none");
    }
}
