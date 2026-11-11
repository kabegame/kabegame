# 01 · 显示器枚举与目标设置模型

## 总体设计思路

两件事：一是**谁来回答「现在有哪些屏、各在哪、叫什么、持久标识是什么」**，二是**目标配置存在哪、怎么迁移**。

显示器枚举放在 app crate 的新模块 `wallpaper/screens.rs`，按平台各写一份，输出统一的 `ScreenInfo`。持久标识选**平台逐屏壁纸 API 本身要的那个值**，让「窗口放在哪块屏」与「原生 API 设哪块屏」用同一个 id，不需要跨 API 按矩形配对：Windows 是 `EnumDisplayDevicesW(…, EDD_GET_DEVICE_INTERFACE_NAME)` 给出的 device interface 路径（与 `IDesktopWallpaper::GetMonitorDevicePathAt` 相同），macOS 是 `CGDisplayCreateUUIDFromDisplayID` 的 UUID。坐标统一成**左上原点的平台桌面坐标**（Windows 物理像素、macOS 点；macOS 翻转 Y）。热插拔由一个后台 watcher 负责：平台通知 + 2 s 轮询比对快照兜底，变化去抖 300 ms 后更新缓存、发事件 `wallpaper-screens-change`、通知控制器 reconcile。

目标配置是 core 里的一个强类型设置值 `SettingValue::WallpaperTargets(BTreeMap<String, WallpaperTargetConfig>)`，不用无类型 JSON。目标 id：`multiple`、`span`、`screen:<持久标识>`。样式与过渡在目标里**按壁纸模式**存（`style: { native: "fill", window: "fit" }`），读取时由控制器按当前能力归一化——原来 `swap_style_transition_for_mode_switch` 的「切模式时交换缓存」和 core 里按平台写死的归一化就都不需要了。迁移 v005 把扁平键并入 `multiple` 目标。

**轮播开关与间隔不进目标**：`wallpaperRotationEnabled`、`wallpaperRotationIntervalMinutes` 仍是全局键，一开全开、同一个节拍；目标里只放各自不同的东西——轮播路径与位置、样式、过渡、当前壁纸。

## 现状锚点

**a. 设置值没有结构化变体**（`kabegame-core/src/settings/mod.rs:167`）
```rust
pub enum SettingValue {
    Bool(bool), U32(u32), I64(i64), F64(f64), String(String), OptionString(Option<String>),
    WindowState(WindowState), OptionWindowState(Option<WindowState>),
    HashMapStringString(HashMap<String, String>),   // 现状：ByMode 两个键用它
    VecString(Vec<String>),
}
```

**b. 切模式时交换样式缓存**（同文件 `:1804`）
```rust
pub fn swap_style_transition_for_mode_switch(&self, old_mode: &str, new_mode: &str)
    -> Result<(String, String), String> {
    // 现状：把当前 style / transition 记进 ByMode[old]，再按 normalize_*_for_mode(new) 取值，
    //      不合法时用 ByMode[new] 兜底；四个键各发一次 setting-change
}
```

**c. core 里按平台写死的归一化**（同文件 `:1887`）——与 manager 的 `supported_styles()` 是两份事实
```rust
fn normalize_style_for_mode(mode: &str, style: &str) -> String {
    #[cfg(target_os = "macos")] { if ["fill"].contains(&style) { … } return "fill".into(); }
    // 现状：其余平台原样返回
}
```

**d. 换路径时位置置为从头开始**（同文件 `:1523`）
```rust
pub fn set_wallpaper_rotation_path(&self, path: Option<String>) -> Result<(), String> {
    // 规范化 → 相同则返回 → 存 → 发事件
    self.set_wallpaper_rotation_position(WALLPAPER_ROTATION_FROM_START)   // 现状：-1
}
```

**e. Android Worker 直接读 settings.json 的扁平键**（`tauri-plugin-wallpaper/android/.../WallpaperRotationWorker.kt:64`）
```kotlin
val enabled = settingsJson.optBoolean("wallpaperRotationEnabled", false)
var style = settingsJson.optString("wallpaperStyle", "fill").ifBlank { "fill" }
val settingsPath = settingsJson.optString("wallpaperRotationPath", "")
```

**f. 已有迁移序列**（`kabegame-core/src/settings/migrations/`）：`v001`…`v004_wallpaper_enabled.rs`，`up(json: &mut Value)` 直接改 JSON。

---

## 点 1 — `ScreenInfo` 与枚举（`kabegame/src/wallpaper/screens.rs`，新增）

- **新增**
```rust
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    /// 平台持久标识：Windows 为 device interface 路径（= IDesktopWallpaper 的 monitorID），
    /// macOS 为 display UUID，Linux 见点 3。目标 id = `screen:<id>`。
    pub id: String,
    /// 友好名（Windows DisplayConfig 的 monitorFriendlyDeviceName，macOS localizedName）；拿不到为 None
    pub name: Option<String>,
    /// 左上原点的平台桌面坐标（Windows 物理像素、macOS 点）
    pub x: i32, pub y: i32, pub width: u32, pub height: u32,
    /// 设备缩放；布局图上显示分辨率用，窗口模式按它换算
    pub scale: f64,
    pub primary: bool,
}

/// 当前在线的屏（缓存，watcher 维护）；主屏排第一，其余按 (y, x) 排。
pub fn screens() -> Vec<ScreenInfo>;
/// 光标所在的屏（托盘「下一张」用）；光标不在任何一块屏的矩形里时返回 None。
/// Windows `GetCursorPos`、macOS `NSEvent.mouseLocation`（翻转 Y），与缓存的矩形比对，
/// 两个 API 现有的鼠标转发探针已经在用（`wallpaper/input_forward/{win,mac}.rs`）。
pub fn screen_at_cursor() -> Option<ScreenInfo>;
/// 启动 watcher：变化时更新缓存、发 `wallpaper-screens-change`、调 `WallpaperController::on_screens_changed()`。
pub fn start_watcher();
```
  > 说明：不复用 Tauri `available_monitors()`——kbcef 只在启动时取一次快照、`name` 为空、没有持久标识（README 现状 e）。

- **新增** 平台实现（同模块 `screens/win.rs`、`screens/mac.rs`、`screens/linux.rs`）
  - Windows：`EnumDisplayMonitors` → `GetMonitorInfoW`（`rcMonitor`、`szDevice`、主屏标志）→ `EnumDisplayDevicesW(szDevice, 0, EDD_GET_DEVICE_INTERFACE_NAME)` 取 `DeviceID` 作 id；友好名用 `QueryDisplayConfig` + `DisplayConfigGetDeviceInfo(DISPLAYCONFIG_TARGET_DEVICE_NAME)`，按 `szDevice` 对上。通知：轮询即可（`WM_DISPLAYCHANGE` 只发给顶层窗口，为它单开隐藏窗口不划算）。
  - macOS：主线程 `NSScreen.screens` → `deviceDescription["NSScreenNumber"]` → `CGDisplayCreateUUIDFromDisplayID` → `CFUUIDCreateString`；`frame` 按主屏高度翻转 Y；`backingScaleFactor`、`localizedName`。通知：`CGDisplayRegisterReconfigurationCallback`（回调里只置脏标志，下一轮读）。
  - Linux（P6）：GNOME 走 Mutter `org.gnome.Mutter.DisplayConfig.GetCurrentState`，id 取 `vendor:product:serial`（connector 会随插口变）；Plasma 走 `kscreen-doctor -j` 或 KScreen DBus。P6 之前 Linux 返回单个「整个桌面」条目——GNOME 的 span 由系统铺放，不需要屏几何，布局图只画一块。
  - Android / web：返回空，前端不显示布局图与选择器。

- **新增** 命令 `list_wallpaper_screens() -> Vec<ScreenInfo>`（主窗口免 ACL，只注册进 `generate_handler!`）。

## 点 2 — 目标 id 与 `WallpaperTargetConfig`（`kabegame-core/src/settings/wallpaper_targets.rs`，新增）

- **新增**
```rust
pub const TARGET_MULTIPLE: &str = "multiple";
pub const TARGET_SPAN: &str = "span";
pub fn screen_target(screen_id: &str) -> String { format!("screen:{screen_id}") }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WallpaperTargetConfig {
    pub rotation_path: Option<String>,       // 原 wallpaperRotationPath（None = 默认随机路径）
    pub rotation_position: i64,              // 原 wallpaperRotationPosition（-1 = 从头）
    pub style: BTreeMap<String, String>,     // 壁纸模式 → 样式；取代 wallpaperStyle + wallpaperStyleByMode
    pub transition: BTreeMap<String, String>,// 壁纸模式 → 过渡；取代 wallpaperRotationTransition + ByMode
    pub current_image_id: Option<String>,    // 原 currentWallpaperImageId
}
```
  > 说明：样式按壁纸模式存，切壁纸模式时什么都不用改；「当前值」= 控制器按能力归一化 `style[mode]`（缺省取能力表第一个）。

- **新增** `SettingKey::WallpaperDisplayMode`（String，默认 `multiple`）、`SettingKey::WallpaperDefaultScreen`（OptionString，屏幕持久标识）、`SettingKey::WallpaperTargets` + `SettingValue::WallpaperTargets(BTreeMap<String, WallpaperTargetConfig>)`（parse / serialize / camelCase 各分支补齐）。
- **保留** `WallpaperRotationEnabled`、`WallpaperRotationIntervalMinutes`（全局，键名与读写接口不变）。
- **删除** `WallpaperRotationPath`、`WallpaperRotationPosition`、`WallpaperStyle`、`WallpaperRotationTransition`、`WallpaperStyleByMode`、`WallpaperTransitionByMode`、`CurrentWallpaperImageId` 及其 getter / setter、`swap_style_transition_for_mode_switch`、`normalize_style_for_mode`、`normalize_transition_for_mode`。

- **新增** 读写 API（`Settings` 上；都是领域操作，按目标 id 寻址，不认识显示器模式）
```rust
pub fn get_wallpaper_targets(&self) -> BTreeMap<String, WallpaperTargetConfig>;
/// 目标不存在返回 None；「缺了就复制」的规则在控制器里（它知道从哪个目标复制）。
pub fn get_wallpaper_target(&self, id: &str) -> Option<WallpaperTargetConfig>;
/// 读-改-写一个目标并发一次 setting-change（整个 map）；目标不存在时以 `seed` 为初值。
pub fn update_wallpaper_target(
    &self, id: &str, seed: impl FnOnce() -> WallpaperTargetConfig,
    f: impl FnOnce(&mut WallpaperTargetConfig),
) -> Result<(), String>;
/// 对所有目标执行 f（删画册清路径、删图清当前壁纸、共用样式级联），一次事件。
pub fn update_all_wallpaper_targets(&self, f: impl FnMut(&str, &mut WallpaperTargetConfig)) -> Result<(), String>;
pub fn remove_wallpaper_target(&self, id: &str) -> Result<(), String>;
```
  - 路径规范化与「换路径置 `WALLPAPER_ROTATION_FROM_START`」保留，挪进 `WallpaperTargetConfig::set_rotation_path`：
```rust
impl WallpaperTargetConfig {
    /// 返回是否变化；变化时位置置为从头开始（与现状 set_wallpaper_rotation_path 语义一致）。
    pub fn set_rotation_path(&mut self, path: Option<String>) -> bool { … }
}
```

- **修改** 所有扁平键的消费方改为按目标（清单见 [02-backend.md](02-backend.md) 点 6）。

## 点 3 — 迁移 v005（`migrations/v005_wallpaper_targets.rs`，新增）

- **新增**：把 7 个扁平键搬进 `wallpaperTargets.multiple`，写 `wallpaperDisplayMode = "multiple"`，删旧键；`wallpaperRotationEnabled`、`wallpaperRotationIntervalMinutes` 不动。
```rust
pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else { return Ok(()) };
    let mode = map.get("wallpaperMode").and_then(Value::as_str).unwrap_or("native").to_string();
    let mut style = map.remove("wallpaperStyleByMode").and_then(as_string_map).unwrap_or_default();
    let mut transition = map.remove("wallpaperTransitionByMode").and_then(as_string_map).unwrap_or_default();
    // 当前值覆盖 ByMode[当前模式]：当前值才是用户最后看到的
    if let Some(s) = map.remove("wallpaperStyle").and_then(as_string) { style.insert(mode.clone(), s); }
    if let Some(t) = map.remove("wallpaperRotationTransition").and_then(as_string) { transition.insert(mode.clone(), t); }
    let target = json!({
        "rotationPath": map.remove("wallpaperRotationPath").unwrap_or(Value::Null),
        "rotationPosition": map.remove("wallpaperRotationPosition").unwrap_or(json!(0)),
        "style": style, "transition": transition,
        "currentImageId": map.remove("currentWallpaperImageId").unwrap_or(Value::Null),
    });
    // 已有 wallpaperTargets（降级后再升级）时以旧键为准覆盖 multiple，与 v004 的约定一致
    map.entry("wallpaperTargets").or_insert_with(|| json!({}))
        .as_object_mut().ok_or("wallpaperTargets 不是对象")?
        .insert("multiple".into(), target);
    map.entry("wallpaperDisplayMode").or_insert(json!("multiple"));
    Ok(())
}
```
  - 测试照 v004：搬键、旧键胜出、缺键用默认、幂等、非法类型按默认。

- **修改** Android `WallpaperRotationWorker.kt`：`wallpaperRotationEnabled` 照旧读顶层；路径与样式改读 `wallpaperTargets.multiple.rotationPath` 与 `style.native`（Android 只有 multiple、只有 native）。

## 点 4 — 目标解析规则（写在控制器里，见 02 点 1）

- 活跃目标集合：`multiple` → `["multiple"]`；`span` → `["span"]`；`single` → 在线屏各自的 `screen:<id>`。
- 默认目标：`multiple` / `span` 即自身；`single` 为 `wallpaperDefaultScreen` 对应的屏，该屏不在线或未设置时取主屏（**不改写设置**，屏回来后默认恢复）。
- 缺失目标的种子：从**切换前模式的默认目标**复制（`rotation_position` 照抄、`current_image_id` 照抄）；启动时缺失（如新接入一块屏）从当前模式的默认目标复制。种子在首次进入活跃集合时落盘，保证之后各自独立。
- 断开屏的 `screen:*` 目标不删，不在活跃集合里就不调度、不开窗口。
- 光标所在目标（托盘「下一张」）：`single` 下为 `screen_at_cursor()` 对应的目标，取不到时用默认目标；`multiple` / `span` 即唯一目标。
