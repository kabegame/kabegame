# WallpaperManager 多显示器扩展计划

> 配套调研文档:[wallpaper-multi-monitor.md](wallpaper-multi-monitor.md)(平台原生能力矩阵、Windows COM/macOS NSScreen/Linux 生态细节)。
> 本计划只覆盖 **manager 层扩展 + 设置模型 + 轮播 + IPC**;前端设置页(排布图/identify/每屏面板)另立计划。

---

## 设计语义(总纲)

### 两大顶层形态

由用户开关 `wallpaperMultiScreenEnabled` 决定:

| 形态 | 语义 |
|------|------|
| **关(默认)= 单逻辑屏** | 所有屏幕当作一个屏幕对待:一套设置(壁纸/style/transition/轮播),即现行为。"拼接成大屏"通过新增 style 选项 `span` 表达(原生支持处:Windows `DWPOS_SPAN`、GNOME `spanned`)。 |
| **开 = 每屏独立** | 每个屏幕拥有**完整独立**的设置集:轮播目标(画廊/画册)、轮播模式与间隔、当前壁纸、style、transition。后端不支持的维度按级联规则退化(见下)。 |

### feature 集(trait 能力探针)

`wallpaper_mode`(native/window/plasma-plugin)切换 WallpaperManager,每个 manager 支持完整能力集的一个子集:

- `multi_screens` — 后端能否枚举并按屏寻址(总开关;false 则 UI 不出多屏功能)
- `image_by_screen` — 每屏不同壁纸
- `style_by_screen` — 每屏不同 style
- `transition_by_screen` — 每屏不同 transition

### 能力矩阵(来自调研文档)

| manager @ 平台 | multi_screens | image_by_screen | style_by_screen | transition_by_screen |
|---|:---:|:---:|:---:|:---:|
| native @ Windows | ✅ | ✅ | ❌(系统级全局) | ❌ |
| native @ macOS | ✅ | ✅ | ✅(options 逐屏) | ❌ |
| native @ Linux-Plasma | ✅ | ✅ | ✅(逐 containment) | ❌ |
| native @ Linux-GNOME/Unknown | ❌(只有 spanned) | ❌ | ❌ | ❌ |
| native @ Android | ❌ | ❌ | ❌ | ❌ |
| window @ Win/mac | ❌(现单窗;后续每屏一窗 → 全✅) | ❌ | ❌ | ❌ |
| plasma-plugin @ Linux | ❌(初期;插件本身可扩展) | ❌ | ❌ | ❌ |

> native @ Linux 的探针是**运行时**判定(`linux_desktop()`),不是编译期。

### 级联规则(核心不变量)

设置写入与系统调用都遵守同一套规则:

1. **setter(value, screen=None)** = 全局操作:
   - 写全局 settings 键;同时**级联覆盖**所有已存在的 per-screen 条目中的同名字段。
   - 系统调用:multi 关 → 现行为;multi 开 → 后端以"全部屏幕"语义应用(如 Windows `SetWallpaper(None, ..)`)。
2. **setter(value, screen=Some(id))**(要求 multi 开):
   - 若 `is_{feature}_by_screen_supported()` → 只写该屏条目 + 只对该屏系统调用;
   - 若不支持 → **降级为全局操作**(规则 1)。前端按 capabilities 本就不该发出这种调用,后端兜底不报错。
3. **per-screen 条目是惰性的**:字段全部 Optional,缺失字段**动态回退**到全局键。改全局值时无条目的屏自然跟随,有条目的屏被级联覆盖(规则 1)。

### 屏幕标识

`ScreenInfo.id: String`,取各平台**持久**标识(拔插/重排不变):

- Windows: `IDesktopWallpaper::GetMonitorDevicePathAt` 的 device path
- macOS: `CGDisplayCreateUUIDFromDisplayID` 的 UUID(**不是** NSScreen index)
- Plasma: 输出名/持久锚点(P4 阶段确认,`d.screen` index 易变)

坐标统一为**左上原点**虚拟桌面坐标(macOS 后端负责翻转 Y),供前端排布图直接使用。

---

## 现状锚点

**a. trait `WallpaperManager`**(`manager/mod.rs:249`)
```rust
pub trait WallpaperManager: Send + Sync {
    fn supported_styles(&self) -> Vec<WallpaperOption>;
    fn supported_transitions(&self) -> Vec<WallpaperOption>;
    async fn set_style(&self, style: &str) -> Result<(), String>;          // 现状:无屏幕参数
    async fn set_transition(&self, transition: &str) -> Result<(), String>;
    async fn set_wallpaper_path(&self, file_path: &str) -> Result<(), String>;
    async fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str) -> Result<(), String> { .. }
    fn cleanup(&self) -> Result<(), String>;
    fn init(&self) -> Result<(), String>;
}
```

**b. capabilities 序列化**(`manager/mod.rs:35`)
```rust
pub struct WallpaperCapabilities {
    pub modes: Vec<WallpaperOption>,
    pub styles: HashMap<String, Vec<WallpaperOption>>,       // 现状:只有 mode → styles/transitions
    pub transitions: HashMap<String, Vec<WallpaperOption>>,  // 无 feature 标志
}
```

**c. Windows COM 全屏写死**(`native.rs:327`)
```rust
desktop_wallpaper
    .SetWallpaper(None, wallpaper_path)   // 现状:monitorID 恒为 None(全部显示器)
    .map_err(|e| format!("SetWallpaper failed: {:?}", e))?;
```

**d. settings 全是单值标量**(`settings/mod.rs:76`)
```rust
pub enum SettingKey {
    WallpaperRotationAlbumId,          // 现状:全局唯一轮播目标
    WallpaperRotationIntervalMinutes,  // 全局唯一间隔
    WallpaperRotationStyle,            // 按 mode 交换,但屏幕维度不存在
    CurrentWallpaperImageId,           // 全局唯一当前壁纸
    // SettingValue 无 Json/嵌套结构变体
}
```

**e. 轮播单状态**(`rotator.rs:227`)
```rust
pub struct WallpaperRotator {
    current_index: Arc<Mutex<usize>>,  // 现状:单顺序索引、单 ticker、单 current_image_id
    // 选图后: settings.set_current_wallpaper_image_id(Some(id))
}
```

**f. IPC setter 无屏幕参数**(`commands/wallpaper.rs:298`)
```rust
#[tauri::command]
pub async fn set_wallpaper_style<R: tauri::Runtime>(style: String, app: AppHandle<R>) -> Result<(), String> {
    // 现状:manager.set_style(&style) → 重设当前壁纸路径;无 screenId
}
```

---

## 点 1 — trait 扩展(`manager/mod.rs`)

- **新增** 能力探针(带默认实现 `false`,后端按需覆写;native@Linux 运行时判定):
- **新增** `list_screens()`(默认空 → 前端据此 + `multi_screens=false` 隐藏多屏 UI)。
- **修改** 四个 setter 增加 `screen: Option<&str>` 尾参(`None` = 全部/全局,对齐 `IDesktopWallpaper` 语义)。

```rust
#[async_trait]
pub trait WallpaperManager: Send + Sync {
    // ---- 新增:能力探针 ----
    fn is_multi_screens_supported(&self) -> bool { false }
    fn is_image_by_screen_supported(&self) -> bool { false }
    fn is_style_by_screen_supported(&self) -> bool { false }
    fn is_transition_by_screen_supported(&self) -> bool { false }

    // ---- 新增:屏幕枚举(仅 attached=false 表示"有配置但已断开") ----
    fn list_screens(&self) -> Result<Vec<ScreenInfo>, String> { Ok(Vec::new()) }

    fn supported_styles(&self) -> Vec<WallpaperOption>;
    fn supported_transitions(&self) -> Vec<WallpaperOption>;

    // ---- 修改:全部 setter 增加 screen 尾参 ----
    async fn set_style(&self, style: &str, screen: Option<&str>) -> Result<(), String>;
    async fn set_transition(&self, transition: &str, screen: Option<&str>) -> Result<(), String>;
    async fn set_wallpaper_path(&self, file_path: &str, screen: Option<&str>) -> Result<(), String>;
    async fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str,
                           screen: Option<&str>) -> Result<(), String> { /* 默认组合实现同现状 */ }

    fn cleanup(&self) -> Result<(), String>;
    fn init(&self) -> Result<(), String>;
}
```

> 约定:后端收到自己不支持维度的 `Some(screen)` 时按 `None` 处理(级联在 Controller 层已决策,后端只做兜底),**不报错**。

## 点 2 — `ScreenInfo` 类型(`manager/mod.rs`)

- **新增**(serde camelCase,直接被 IPC/前端消费;跨平台统一左上原点):

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenInfo {
    pub id: String,            // 平台持久标识(见总纲);settings 的 key
    pub x: i32,  pub y: i32,   // 虚拟桌面坐标,统一左上原点(mac 翻转 Y)
    pub width: u32, pub height: u32,
    pub is_primary: bool,
    pub attached: bool,        // false = 已断开但保留配置(休眠条目)
    pub label: Option<String>, // 友好名(mac localizedName;Win 首期 None)
}
```

## 点 3 — Controller 级联协调(`manager/mod.rs`)

- **新增** Controller 统一入口,把"multi 开关 + feature 探针 → per-screen 或级联"的决策**集中在这一处**(rotator 和 commands 都只调它,不各自判断):

```rust
impl WallpaperController {
    /// 屏幕感知 setter 统一入口。screen=None 或 multi 关 → 全局;
    /// Some(id) 且 feature 支持 → 单屏;Some(id) 但 feature 不支持 → 级联降级为全局。
    pub async fn set_wallpaper_scoped(&self, file_path: &str, style: &str,
        transition: &str, screen: Option<&str>) -> Result<(), String>;
    pub async fn set_style_scoped(&self, style: &str, screen: Option<&str>) -> Result<(), String>;
    pub async fn set_transition_scoped(&self, transition: &str, screen: Option<&str>) -> Result<(), String>;

    pub fn list_screens(&self) -> Result<Vec<ScreenInfo>, String>; // 转发 active_manager
}
```

- **修改** `capabilities()` 输出 feature 标志(前端据此渲染/隐藏多屏 UI):

```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WallpaperFeatures {
    pub multi_screens: bool,
    pub image_by_screen: bool,
    pub style_by_screen: bool,
    pub transition_by_screen: bool,
}

pub struct WallpaperCapabilities {
    pub modes: Vec<WallpaperOption>,
    pub styles: HashMap<String, Vec<WallpaperOption>>,
    pub transitions: HashMap<String, Vec<WallpaperOption>>,
    pub features: HashMap<String, WallpaperFeatures>,   // 新增:mode → features
}
```

- **修改** `style_options`:`span` 作为新 style 值加入(仅 multi **关** 且后端原生支持时出现在 options;multi 开时剔除——Windows `DWPOS_SPAN` 与每屏图互斥)。i18n 新增 `settings.styleSpan(Desc)` 五语言。

## 点 4 — 设置模型(`kabegame-core/src/settings/`)

- **新增** `SettingKey::WallpaperMultiScreenEnabled`(Bool,默认 false)。
- **新增** `SettingKey::WallpaperScreenConfig` + `SettingValue::Json(serde_json::Value)` 变体(parse/serialize/camelCase 各 match 分支同步补齐)。结构(全字段 Optional = 惰性条目 + 动态回退):

```jsonc
// wallpaperScreenConfig
{
  "<screen_id>": {
    "rotationEnabled": true,            // 缺失 → 回退全局 WallpaperRotationEnabled
    "rotationAlbumId": "xxx",           // 缺失 → 回退全局(轮播目标)
    "rotationMode": "random",
    "rotationIntervalMinutes": 30,      // 每屏独立间隔
    "style": "fill",
    "transition": "none",
    "currentWallpaperImageId": "img-id" // 每屏各自的"当前壁纸"
  }
}
```

- **新增** 读写 API:`get_wallpaper_screen_config()` / `update_wallpaper_screen_entry(screen_id, patch)` / `cascade_wallpaper_screen_field(field, value)`(级联覆盖所有条目的同名字段,配合总纲规则 1)。
- **迁移**:新 key 走 `default_value()` 自动补齐,**无需** settings migration;不预填 per-screen 条目(惰性)。
- 全局键(`WallpaperRotationStyle` 等)职责不变:单逻辑屏形态的值 + 每屏条目的回退基线。`swap_style_transition_for_mode_switch` 只作用于全局键;per-screen 条目跨 mode 共享,mode 不支持 multi 时整体休眠。

## 点 5 — 轮播 per-screen 调度(`rotator.rs`)

- **保留** multi 关时的整条现路径(零回归)。
- **新增** multi 开时的调度分支:**单循环 + 每屏 due-time**(不开 N 线程,复用现有 state 机/Notify/stop 语义):

```rust
struct ScreenRotationState {
    screen_id: String,
    next_due: tokio::time::Instant,   // 每屏独立间隔独立到期
}
// loop:
//   states 取 attached 且 rotationEnabled(有效值) 的最小 next_due → sleep_until(或 notify 唤醒)
//   到期屏:按该屏有效 source/mode 选图(复用 load_next_sequential / load_random_image_for_wallpaper,
//         current marker 改从该屏条目的 currentWallpaperImageId 取)
//   → controller.set_wallpaper_scoped(path, style, transition, Some(&screen_id))
//   → update_wallpaper_screen_entry(screen_id, { currentWallpaperImageId })
//   → next_due += 该屏 interval
```

- **修改** `rotate()`(手动下一张):multi 开时接受可选 `screen_id`,None = 所有屏各推进一张。
- 屏幕拔插:枚举结果变化(Windows `WM_DISPLAYCHANGE` / 各平台事件,P2+ 逐个接)→ 重建 states;断开屏条目休眠保留,重连后按其 `currentWallpaperImageId` 恢复。

## 点 6 — IPC 命令面(`commands/wallpaper.rs`、`lib.rs` 注册、permissions)

- **新增**:
  - `list_wallpaper_screens() -> Vec<ScreenInfo>`
  - `set_wallpaper_multi_screen_enabled(enabled: bool)` — 开:立即按各屏配置应用一轮;关:回落单逻辑屏,用全局配置重设一次。
  - `update_wallpaper_screen_config(screen_id: String, patch: Json)` — 每屏轮播目标/模式/间隔/style/transition 的统一写入口(替代为每个字段开一条命令),内部走点 3/点 4 的级联规则并触发对应副作用(reset 该屏 due-time 等)。
- **修改**(向后兼容,新参数 Optional,前端旧调用不受影响):
  - `set_wallpaper_by_image_id(image_id, screen_id: Option<String>)`
  - `set_wallpaper_style(style, screen_id: Option<String>)`
  - `set_wallpaper_rotation_transition(transition, screen_id: Option<String>)`
  - 以上内部从直接摸 manager 改为调 `WallpaperController::*_scoped`。
- **修改** 既有调用点随 trait 签名机械更新(全部传 `None`,行为不变):`rotator.rs`(×2 处 `set_wallpaper`)、`commands/wallpaper.rs`(`set_wallpaper_mode` 内 `set_wallpaper_path/set_style/set_transition`)、`startup.rs`、`mcp_server.rs` 壁纸 tool、`native.rs` 内部自调(`set_style` Windows 重载路径)。以 `grep set_wallpaper_path|set_style|set_transition` 收口。

## 点 7 — 后端实现分期

- **P1 骨架(本计划主体,先行合入)**:点 1–6 全部落地;三个后端只做**签名适配**(忽略 screen 参数),探针全 false → 行为零回归,UI 无多屏入口。`deno task check -c kabegame` 全绿。
- **P2 Windows native**:`windows_monitors.rs`(专用 STA 线程承载全部 COM;枚举/判 attached/`SetWallpaper(device_path)`;细节见调研文档 §2.4)。探针:`multi_screens=✅ image_by_screen=✅`。接 `WM_DISPLAYCHANGE`。
- **P3 macOS native**:objc2 直调 `NSScreen.screens` + `setDesktopImageURL(_:for:options:)`(替换 osascript 路径);UUID 现查 NSScreen 防拔插失效。探针:`multi_screens=✅ image_by_screen=✅ style_by_screen=✅`。
- **P4 Linux native@Plasma**:`desktops()` 按 `d.screen` 分发 + 持久锚点确认。GNOME 保持 false(只有 span style)。
- **后续(不在本计划)**:window 模式每屏一窗(届时四探针全 ✅,含 transition_by_screen)、plasma-plugin per-screen、Wayland layer-shell 新 mode(Hyprland,见调研文档)。

---

## 验证

- P1:`deno task check -c kabegame --skip vue`(+ 前端接入后去掉 skip);编辑器 lint。**不跑 build**。
- P2+ 真机按调研文档 §2.7(枚举/拔插/独立轮播/span 互斥/坐标翻转),先写证伪判据再实验。

## 决策点(实现前需拍板)

1. **multi 关的呈现**:本计划按"现行为不变 + 新增 `span` style 选项"(零回归,拼大屏是可选项);另一解读是关 = 强制 span。
2. **`WallpaperScreenConfig` 存储**:本计划按 `SettingValue::Json` 单键;备选独立存储(表/文件)。
3. **断开屏配置**:本计划按保留休眠(对齐 Windows 系统行为);备选断开即删。
</parameter>
</invoke>
