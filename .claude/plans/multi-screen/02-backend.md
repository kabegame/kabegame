# 02 · 后端：控制器、manager、轮播、命令

## 总体设计思路

控制器从「按壁纸模式选后端」扩成「按壁纸模式选后端 + 按显示器模式算布置」。它是**唯一**知道显示器模式、活跃目标、默认目标、目标覆盖哪些屏的地方：对外给出 `Placement`（这个目标落在哪些屏、是不是并集），manager 只照 `Placement` 输出，轮播器只按目标 id 调度。归一化样式 / 过渡也只在控制器里按能力做一次。

manager trait 的变化尽量小：`set_wallpaper` 多带一个 `&Placement`，能力查询多带显示器模式；去掉 `set_style` / `set_transition` 两个「改设置顺便重设壁纸」的方法——它们现在的实现要么是空操作（窗口模式），要么是「读当前壁纸再设一次」，在目标化之后由命令层直接调 `set_wallpaper(当前壁纸, 新样式, …)` 表达更清楚。窗口模式额外有一个 `reconcile(&Layout)`：显示器模式、在线屏、壁纸开关变化时把窗口集合对齐。

轮播器仍是**一个开关、一个间隔、一个 ticker**（开关与间隔是全局设置）：到点时对当前所有活跃目标各切一张，每个目标按自己的轮播路径与位置选图。选图逻辑（`resolve_source` / `start_position` / `collect_available` / `pick_next`）原样保留，只是读写的状态从扁平设置换成目标配置。手动切换带目标：托盘「下一张」只切光标所在屏的目标，改某个目标的路径只切那个目标。

## 现状锚点

**a. trait**（`kabegame/src/wallpaper/manager/mod.rs:249`）
```rust
pub trait WallpaperManager: Send + Sync {
    fn supported_styles(&self) -> Vec<WallpaperOption>;
    fn supported_transitions(&self) -> Vec<WallpaperOption>;
    async fn set_style(&self, style: &str) -> Result<(), String>;          // 现状：Windows 原生写注册表后重设当前壁纸；窗口模式空操作
    async fn set_transition(&self, transition: &str) -> Result<(), String>; // 现状：Windows 原生写设置并重设；其余只写设置
    async fn set_wallpaper_path(&self, file_path: &str) -> Result<(), String>;
    async fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str) -> Result<(), String> {
        self.set_style(style).await?; self.set_transition(transition).await?; self.set_wallpaper_path(file_path).await
    }
    fn cleanup(&self) -> Result<(), String>;
    fn init(&self) -> Result<(), String>;
}
```

**b. 原生后端从扁平设置里反读当前壁纸与过渡**（`manager/native.rs`）
```rust
fn current_wallpaper_path_from_settings(&self) -> Option<String> {
    let id = Settings::global().get_current_wallpaper_image_id()?;   // 现状：全局单值
    …
}
fn current_wallpaper_transition_from_ipc(&self) -> Option<String> {
    Some(Settings::global().get_wallpaper_rotation_transition())     // 现状：set_wallpaper_path 里反读
}
```

**c. 轮播单 ticker**（`wallpaper/rotator.rs`）
```rust
let mut ticker = interval(Duration::from_secs(current_interval_secs));   // 现状：一个间隔
loop {
    let woke_by_timer = tokio::select! { _ = ticker.tick() => true, _ = notify.notified() => false };
    if !settings.get_wallpaper_rotation_enabled() { continue; }           // 现状：全局开关
    …
    advance_and_apply().await                                             // 现状：读写扁平键
}
```

**d. 选图后写回扁平键**（同文件 `advance_and_apply`）
```rust
settings.set_wallpaper_rotation_position(next_position as i64)?;
let manager = WallpaperController::global().active_manager().await?;
manager.set_wallpaper(&image.local_path, &settings.get_wallpaper_rotation_style(),
                      &settings.get_wallpaper_rotation_transition()).await?;
let _ = settings.set_current_wallpaper_image_id(Some(image.id.clone()));
```

**e. 命令无目标参数**（`kabegame/src/commands/wallpaper.rs`）
```rust
pub async fn set_wallpaper_by_image_id(image_id: String) -> Result<(), String>;
pub async fn set_wallpaper_rotation_enabled(enabled: bool) -> Result<(), String>;
pub async fn set_wallpaper_rotation_path(path: String) -> Result<(), String>;
pub fn set_wallpaper_rotation_interval_minutes(minutes: u32) -> Result<(), String>;
pub async fn set_wallpaper_style<R: Runtime>(style: String, app: AppHandle<R>) -> Result<(), String>;
pub async fn set_wallpaper_rotation_transition(transition: String) -> Result<(), String>;
pub async fn get_current_wallpaper_target<R: Runtime>(_app: AppHandle<R>) -> Result<Option<WallpaperTarget>, String>;
// set_wallpaper_mode 里调 swap_style_transition_for_mode_switch 后 target.set_style / set_transition
```

---

## 点 1 — 控制器：布置与目标（`manager/mod.rs`）

- **新增**
```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode { Multiple, Span, Single }

/// 一个目标落在哪里。
#[derive(Debug, Clone)]
pub enum Placement {
    /// 所有在线屏显示同一张（`multiple`；也是没有屏幕信息的平台的唯一布置）
    All { screens: Vec<ScreenInfo> },
    /// 整个桌面当一块画布（`span`）；由系统铺放，后端不需要屏几何
    Span,
    /// 只有这一块屏（`single`）
    One { screen: ScreenInfo },
}

/// 当前布局：控制器据设置与在线屏算出，manager 与轮播都只读它。
#[derive(Debug, Clone)]
pub struct Layout {
    pub display_mode: DisplayMode,
    pub targets: Vec<(String, Placement)>,   // 活跃目标，顺序：默认目标在前
    pub default_target: String,
}

impl WallpaperController {
    /// 按设置与 screens::screens() 计算；顺带把缺失的活跃目标从种子落盘（01 点 4）。
    pub fn layout(&self) -> Layout;
    /// 不指定目标的操作落到哪：命令层把 `target: Option<String>` 交给它解析。
    pub fn resolve_target(&self, target: Option<&str>) -> Result<(String, Placement), String>;
    /// 光标所在屏的目标（01 点 4）；托盘「下一张」用。
    pub fn target_at_cursor(&self) -> String;
    /// 按能力归一化后的样式 / 过渡（读目标里 style[mode]，不合法取能力第一项）。
    pub fn effective_style(&self, cfg: &WallpaperTargetConfig) -> String;
    pub fn effective_transition(&self, cfg: &WallpaperTargetConfig) -> String;
    /// 把一个目标的当前壁纸重新输出一次（改样式、改显示器模式、屏幕变化后用）。
    pub async fn reapply_target(&self, target_id: &str) -> Result<(), String>;
    /// 屏幕 watcher 回调：重算 layout → 窗口模式 reconcile → 原生 single 给新接入的屏输出其目标
    /// （span 由系统自己重排，不用重设）。不重置轮播计时。
    pub fn on_screens_changed(&self);
}
```
  > 说明：`resolve_target(Some(id))` 时 id 必须在活跃集合里，否则报错（防止给休眠屏设图）。

- **修改** `capabilities()` 输出三维能力（**修改**已有结构，不另起）：
```rust
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayModeCapability {
    pub value: DisplayMode,
    pub label: Value, pub desc: Value,
    /// None = 可用；Some = 不可用的原因（i18n map），前端置灰并显示
    pub unavailable: Option<Value>,
    pub styles: Vec<WallpaperOption>,
    pub transitions: Vec<WallpaperOption>,
    /// true：该组合下样式对所有目标只有一个值（Windows 原生 single），写样式时级联
    pub shared_style: bool,
}

pub struct WallpaperCapabilities {
    pub modes: Vec<WallpaperOption>,
    // 删除：styles / transitions（mode → options）
    pub display_modes: HashMap<String, Vec<DisplayModeCapability>>,   // 新增：壁纸模式 → 三个显示器模式
}
```

- **新增** `set_display_mode(mode)`（由命令调用）：校验能力 → 停轮播 → 写设置 → `layout()`（种子落盘）→ 窗口模式 `reconcile` / 原生逐目标 `reapply_target` → 重启轮播。

## 点 2 — manager trait（`manager/mod.rs`）

- **修改**
```rust
#[async_trait]
pub trait WallpaperManager: Send + Sync {
    /// 修改：带显示器模式。显示器模式不可用时内容无意义，可用与否由 unavailable_reason 判断。
    fn supported_styles(&self, display: DisplayMode) -> Vec<WallpaperOption>;
    fn supported_transitions(&self, display: DisplayMode) -> Vec<WallpaperOption>;
    /// 新增：None = 可用
    fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str /* i18n key */> { 
        (display != DisplayMode::Multiple).then_some("settings.displayModeUnsupported")
    }
    /// 新增
    fn shared_style(&self, _display: DisplayMode) -> bool { false }

    /// 修改：一次输出 = 文件 + 样式 + 过渡 + 布置；不再拆成 set_style / set_transition / set_wallpaper_path
    async fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str,
                           placement: &Placement) -> Result<(), String>;

    /// 新增：窗口集合对齐 layout；原生后端默认空实现
    fn reconcile(&self, _layout: &Layout) -> Result<(), String> { Ok(()) }

    fn cleanup(&self) -> Result<(), String>;
    fn init(&self) -> Result<(), String>;   // 窗口模式里改成 reconcile(&controller.layout())
}
```
- **删除** `set_style`、`set_transition`、`set_wallpaper_path`。
  > 说明：现有调用点（`set_wallpaper_style` / `set_wallpaper_rotation_transition` / `set_wallpaper_mode` / 启动恢复 / `native.rs` 内部反读当前壁纸）统一改成「命令层取目标当前壁纸 → `set_wallpaper(…, placement)`」，原生后端不再反读设置。

## 点 3 — 轮播多目标调度（`wallpaper/rotator.rs`）

- **修改** 选图函数加目标参数，状态读写换成目标配置（逻辑不变）：
```rust
fn resolve_source(target_id: &str, wallpaper_mode: &str, allow_wpe: bool) -> Result<RotationSource, String>;
fn start_position(target_id: &str, src: &RotationSource) -> u64;   // 读 cfg.rotation_position / current_image_id
fn pick_next(target_id: &str, wallpaper_mode: &str, allow_wpe: bool) -> Result<Option<(ImageInfo, u64)>, String>;

/// 修改：切一个目标；定时与手动共用。
async fn advance_and_apply(target_id: &str) -> Result<bool, String> {
    let controller = WallpaperController::global();
    let (_, placement) = controller.resolve_target(Some(target_id))?;
    // allow_wpe：窗口模式为 true（现状规则不变）
    let picked = spawn_blocking(move || pick_next(…)).await??;
    let Some((image, next)) = picked else { return Ok(false) };
    settings.update_wallpaper_target(target_id, seed, |c| c.rotation_position = next as i64)?;  // 先推进位置
    let cfg = settings.get_wallpaper_target(target_id).unwrap();
    controller.active_manager().await?.set_wallpaper(
        &image.local_path, &controller.effective_style(&cfg), &controller.effective_transition(&cfg), &placement).await?;
    settings.update_wallpaper_target(target_id, seed, |c| c.current_image_id = Some(image.id.clone()))?;
    // lastSetWallpaperAt 照旧
    Ok(true)
}
```

- **修改** 调度循环：ticker 与开关判断不变（现状 c），到点时把「切一张」换成「对每个活跃目标切一张」。
```rust
loop {
    let woke_by_timer = tokio::select! { _ = ticker.tick() => true, _ = notify.notified() => false };
    if stopping { break; }
    let manual = take_manual();                       // 新增：手动切换请求，见下
    let targets: Vec<String> = if woke_by_timer {
        if !settings.get_wallpaper_rotation_enabled() { continue; }   // 现状：全局开关
        controller.layout().targets.into_iter().map(|(id, _)| id).collect()   // 修改：所有活跃目标
    } else {
        manual.into_targets(&controller.layout())      // 新增：All 或指定的几个
    };
    for id in &targets {
        if let Err(e) = advance_and_apply(id).await { warn!(…) }      // 一个目标失败不影响其它
    }
    if !woke_by_timer { ticker.reset(); }              // 现状语义：手动切换后下一次自动切换从现在起算
}
```
  - 手动请求从一个位标志改成 `Mutex<Manual>`（`None` / `All` / `Targets(BTreeSet<String>)`，同一轮内合并）；「重置计时」仍是位标志。`notify` 与状态机（Idle / Starting / Running / Stopping）不变。
  - 线程存活条件与现状相同：只看全局开关。
  - 各目标按顺序切（默认目标在前），窗口模式下每个窗口各自做过渡，观感上同时；原生 single 下逐屏调用系统 API，先后差几十毫秒。
  > 说明：手动切一个目标也会重置全局计时器，其它屏的下一次自动切换随之顺延至多一个间隔。这是沿用现状「手动切换后从现在起算」的最简做法。
- **修改** 公开方法：`rotate(target: Option<&str>)`（`Some` = 只切这个目标；`None` = 所有活跃目标）、`reset()`、`ensure_running()` 不变。线程未运行时 `rotate` 直接在调用处切，与现状一致。
- **修改** `relocate_position_for_mode(wallpaper_mode)` 对所有目标执行一遍。
- **Android 不变**：只有 `multiple` 一个目标，`android_queue` 改读 `multiple` 目标配置。

## 点 4 — 命令（`commands/wallpaper.rs`）

- **修改**（加可选 `target`，缺省为默认目标，经 `resolve_target`）：
  - `set_wallpaper_by_image_id(image_id, target?)`
  - `set_wallpaper_rotation_path(path, target?)`：只写这个目标的路径；路径变了 `rotate(Some(target))`（现状 `:341` 的语义，换成只切该目标）。
  - `set_wallpaper_rotation_enabled(enabled)`、`set_wallpaper_rotation_interval_minutes(minutes)`、`start_wallpaper_rotation()`：**不加 `target`**，全局。
  - `set_wallpaper_style(style, target?)`：写 `cfg.style[mode]`；`shared_style` 时对当前显示器模式的全部活跃目标写同一值；随后 `reapply_target`。
  - `set_wallpaper_rotation_transition(transition, target?)`：写 `cfg.transition[mode]`；轮播开着且过渡不是 `none` 时 `rotate(Some(target))` 演示一次（现状 `:431` 的语义）。
  - `get_current_wallpaper_target(target?)` / `get_current_wallpaper_path(target?)` / `get_current_wallpaper_image_id(target?)` / `clear_current_wallpaper_image_id(target?)`：缺省时**若调用方是壁纸窗口**，取该窗口的 assignment（见 03 点 3），否则默认目标。
  - `set_wallpaper_mode(mode)`：删掉 `swap_style_transition_for_mode_switch`；按新模式能力检查当前显示器模式是否可用，不可用则先回落 `multiple`；其后对每个活跃目标做现有的「WPE / 文件不存在时兜底换图」并 `set_wallpaper(…, placement)`。
  - `set_wallpaper_enabled(true)`：恢复时对每个活跃目标恢复（`init_wallpaper_on_startup` 同改）。
- **新增**
  - `set_wallpaper_display_mode(mode: DisplayMode)` → `controller.set_display_mode`
  - `set_wallpaper_default_screen(screen_id: String)`（只在 single 下有意义，屏必须在线）
  - `forget_wallpaper_target(target_id: String)`（只允许删不在活跃集合里的 `screen:*`）
  - `list_wallpaper_screens()`（01 点 1）
- **删除** `get_wallpaper_rotation_style` / `get_wallpaper_rotation_transition` 等扁平 getter（壁纸窗口改读目标，见 03）；`settingsDescriptors.ts` 对应条目同删。

## 点 5 — IPC / CLI / MCP

- **修改** 已有 IPC 变体加 `target: Option<String>`（`SettingsGetWallpaperRotationPath`、`SettingsSetWallpaperRotationPath`、`…Transition`、`SettingsGetCurrentWallpaperImageId`、`SettingsSetCurrentWallpaperImageId`；`…Enabled`、`…IntervalMinutes` 是全局的，不动），handler 转调命令；协议版本按 `cocs/cli/CLI_IPC.md` 的规则 +1。
- **修改** CLI 对应子命令加 `--target <id>`；`kabegame-cli wallpaper screens` 列屏（走 IPC，因为要主程序的 watcher 缓存；主程序不在时本进程枚举一次）。
- **修改** MCP 壁纸工具同加可选 `target`。

## 点 6 — 扁平键消费方改造清单

| 位置 | 现状 | 改为 |
|---|---|---|
| `kabegame-core/src/commands/album.rs:47` 删画册 | 只看 `wallpaperRotationPath` | `update_all_wallpaper_targets`：路径以该画册为根的目标都置回 None |
| `kabegame-core/src/commands/image.rs:146` 删图 | 清全局当前壁纸 | 所有目标里 `current_image_id` 命中的清空 |
| `kabegame-core/src/storage/hidden_cleanup.rs:166`、`organize.rs:544` | 同上 | 同上（收集所有目标的当前 id 集合） |
| `kabegame/src/startup.rs:946` 启动恢复 | 恢复一张 | 对 `layout().targets` 逐个恢复 |
| `kabegame/src/tray.rs:182` 下一张 | `rotate()` | `rotate(Some(&controller.target_at_cursor()))`：只切光标所在屏；光标位置在菜单事件到达时读 |
| `kabegame/src/ipc/handlers/settings.rs` | 扁平 get/set | 见点 5 |
| `wallpaper/manager/native.rs` | 反读 `currentWallpaperImageId` / 过渡 / 样式 | 删除反读，参数全由 `set_wallpaper` 带入 |
| `wallpaper/manager/plasma_plugin.rs` | 读扁平键 | 只读 `multiple` 目标（即将下线，最小改动） |
| Android Worker | 读扁平键 | 01 点 3 |
| 前端 | 见 [05-frontend.md](05-frontend.md) | |
