# 多显示器壁纸：显示器模式与壁纸目标

## 当前实现范围

多显示器壁纸分期实现，目前完成了前三期的大部分与第四期的 macOS 部分：

- **目标化骨架**：设置、控制器、轮播、命令与前端都按「壁纸目标」组织；
- **显示器枚举与设置页布局图**：macOS 上能枚举在线显示器并跟随热插拔，设置页的壁纸分区有显示器模式选择器与显示器布局图；
- **窗口模式每屏一窗**：窗口模式下每块在线屏一个壁纸窗口，随热插拔增减；macOS 的窗口模式可以选 `multiple`（各屏同一张）与 `single`（逐屏独立）；
- **目标选择弹窗**：有多个活跃目标时（逐屏独立且不止一块屏），设置页以外的「设为壁纸」「设为轮播」「用当前视图轮播」先弹窗选一块显示器；托盘「下一张」不弹窗，切光标所在那块屏的目标。
- **macOS 原生模式逐屏设置**：原生模式经 `NSWorkspace` 一块屏一块屏地设系统桌面图片，可以选 `multiple` 与 `single`，显示方式有填充、适应、拉伸、居中四种（逐屏生效）；见下文「原生模式：macOS 逐屏」。

各平台、各壁纸模式现在能用的显示器模式：

| 平台 · 壁纸模式 | `multiple` | `span` | `single` |
| --- | --- | --- | --- |
| macOS · 窗口 | 每屏一窗，同一张 | 不可用（窗口模式暂不支持跨屏拼接） | 每屏一窗，各显示自己的目标 |
| Windows · 窗口 | 一个窗口，只铺主屏 | 不可用 | 不可用（后续版本） |
| macOS · 原生 | 每块屏各设一次，同一张 | 不可用（系统没有跨屏铺放） | 每块屏设自己目标的那张 |
| Windows / Linux / Android · 原生 | 所有显示器同一张 | 不可用（后续版本） | 不可用（后续版本） |
| Linux · Plasma 插件、Android | 只有这一项，不显示选择器 | — | — |

下面这些尚未实现，文档里提到它们的地方描述的是已经留好的接口，不是可用功能：

- Windows / Linux 的显示器枚举：这两个平台 `screens()` 恒返回空，设置页不显示布局图（Android、Web 同样为空，也不计划显示）。Windows 的窗口模式因此退化成一个不绑定屏的壁纸窗口（label `wallpaper`，铺主屏），与多屏改造前相同；
- `span` 显示器模式：所有组合都不可用（macOS 上不会有：窗口模式暂不支持，系统也没有跨屏铺放）；
- Windows / Linux 原生模式的 `single`：这两个平台的原生后端收到逐屏的布置直接报错；
- CLI 的 `--target` 参数与列屏命令。

## 概念

**显示器模式**（设置键 `wallpaperDisplayMode`）决定一张壁纸怎么落到多块屏上：

| 值 | 含义 | 目标 |
| --- | --- | --- |
| `multiple` | 各屏复制：所有显示器显示同一张 | 一个，id 为 `multiple` |
| `span` | 跨屏拼接：整个桌面当一块画布 | 一个，id 为 `span` |
| `single` | 逐屏独立：每块在线屏各自设置 | 每块屏一个，id 为 `screen:<屏幕持久标识>` |

**壁纸目标**（target）是设置的单位：轮播路径与位置、样式、过渡、当前壁纸都挂在目标上。屏幕持久标识取平台逐屏壁纸 API 本身使用的值（Windows 为 device interface 路径，macOS 为 display UUID），这样窗口定位与原生 API 能用同一个 id。

**壁纸模式**（`wallpaperMode`：`native` / `window` / `plasma-plugin`）是另一个维度，决定用哪个后端输出。能力按「壁纸模式 × 显示器模式」给出。

仍是全局设置、不属于目标的：轮播开关 `wallpaperRotationEnabled`、轮播间隔 `wallpaperRotationIntervalMinutes`、壁纸模式、打开壁纸、音量、倍速、暂停与 WPE 相关设置。

## 显示器枚举

`kabegame/src/wallpaper/screens.rs` 回答「现在有哪些屏、各在哪、叫什么、持久标识是什么」。不用 Tauri 的 monitor API：kbcef runtime 的 `available_monitors()` 是启动时的一次性快照，名字为空、没有持久标识，也不随热插拔更新。

```rust
pub struct ScreenInfo {            // JSON 为 camelCase
    pub id: String,                // 平台持久标识；目标 id = screen:<id>
    pub name: Option<String>,      // 友好名，拿不到为 None
    pub x: i32, pub y: i32,        // 左上原点的平台桌面坐标
    pub width: u32, pub height: u32,
    pub pixel_width: u32, pub pixel_height: u32,   // 物理像素分辨率
    pub scale: f64,                // 物理像素 / 点
    pub primary: bool,
}
```

- **顺序**：主屏第一，其余按 `(y, x)`。
- **坐标**：左上原点、y 向下的平台桌面坐标，主屏左边、上边的屏坐标为负。单位随平台不同（macOS 是点，Windows 计划用物理像素），所以另给 `pixel_width` / `pixel_height` 供界面显示分辨率，前端不按平台自己换算。
- **缓存**：`screens()` 只读进程内缓存，可以在任意线程调用，不触发枚举。缓存由 `start_watcher()` 填充并维护，在它之前、以及没有平台实现的平台上为空。
- `screen_at_cursor()`：光标所在的屏，光标不在任何一块屏的矩形里（两块屏高低错开留下的空角）或没有屏幕信息时为 `None`。右、下边界不含。

### macOS（`screens/mac.rs`）

- 列表来自 `NSScreen.screens`，每块屏取 `frame`、`backingScaleFactor`、`localizedName` 与 `deviceDescription["NSScreenNumber"]`（即 `CGDirectDisplayID`）。`NSScreen` 只能在主线程读，枚举经 `dispatch2::run_on_main` 派过去（已在主线程时直接执行）。镜像显示时一组镜像只出一块屏。
- **持久标识**是 `CGDisplayCreateUUIDFromDisplayID` 的 UUID 字符串（大写、带连字符，如 `37D8832A-2D66-02CA-B9F7-8F30A301B230`）。`CGDirectDisplayID` 重启、重新接入后会变，不能用作标识。拿不到 UUID 的屏不进列表并告警。
- **坐标换算**：`NSScreen.frame` 是 Cocoa 屏幕坐标（主屏左下为原点、y 向上）。两个坐标系的原点都在主屏上，只差主屏高度：`y = 主屏高度 − (frame.y + frame.height)`，x 不变。换算后与窗口服务的 CG 全局坐标（`CGDisplayBounds`）一致。
- **主屏**指原点所在、带菜单栏的那块（`CGMainDisplayID`），不是 `NSScreen.mainScreen`（那是键盘焦点所在的屏）。
- **名字**是 `localizedName`，语言跟应用自身的本地化走，不一定与「系统设置」里显示的相同。
- **光标**：`NSEvent.mouseLocation`（类属性，任意线程可读），同样按主屏高度翻转 y。

### 热插拔 watcher

`start_watcher()` 先同步枚举一次填进缓存，再起一个线程（`wallpaper-screens`）维护它。它在 `startup::init_wallpaper_controller` 里、壁纸控制器初始化**之前**调用：控制器初始化时就要按在线屏算布局、补种目标；该函数在主线程上执行，所以首次枚举不需要派发。

线程循环只有一个动作：重新枚举一次，和缓存比。

- **唤醒**：每 2 s 一次；macOS 另登记 `CGDisplayRegisterReconfigurationCallback`，系统重排完成后的那次回调 `unpark` 线程，让它立刻再枚举（重排开始前的那次回调忽略）。回调只负责唤醒，不带数据，登记失败也只是退回纯轮询。
- **去抖**（`Debounce`）：快照与缓存不同后，同一份快照要保持 300 ms 才提交；中途又变成另一份就从新的那份重新计时，变回缓存的样子就当什么都没发生。接上一块屏时系统会连发几次重排、先报临时位置。
- **提交**（`commit`）依次做三件事：换缓存 → `WallpaperController::on_screens_changed(previous)` → 发事件 `wallpaper-screens-change`。`previous` 是换下来的那份在线屏。顺序有讲究：控制器先把新接入的屏的目标补种落盘，前端收到屏幕事件时目标配置已经在了。
- `on_screens_changed(previous)` 先同步重算布局、补种缺失的活跃目标，然后（壁纸开着时）按壁纸模式让输出跟上，都放在异步运行时上做，不挡住后面的事件：
  - 窗口模式：把窗口集合对齐到在线屏，见下文「窗口模式：每屏一窗」；
  - 原生模式、且后端能只设一块屏（目前只有 macOS）：只给**新接入**的屏输出它该显示的目标，见下文「原生模式：macOS 逐屏」；
  - 其余情况不输出：不能逐屏的原生后端由系统自己把同一张铺到新屏上。

  它**不碰轮播计时**。

屏的增减、移动、改分辨率、换主屏都会让快照不同，都走同一条路径。

## 设置模型

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `wallpaperTargets` | `{ [targetId]: WallpaperTargetConfig }` | 全部目标的配置；默认空表，缺失的活跃目标由控制器补种 |
| `wallpaperDisplayMode` | `"multiple" \| "span" \| "single"` | 默认 `multiple`；读取时非法值按 `multiple` |
| `wallpaperDefaultScreen` | 屏幕持久标识或 `null` | `single` 下的默认显示器；`null` 或该屏不在线时取主屏 |

`WallpaperTargetConfig`（`kabegame-core/src/settings/wallpaper_targets.rs`，JSON 为 camelCase）：

| 字段 | 说明 |
| --- | --- |
| `rotationPath` | 轮播来源 PathQL 路径（不含分页尾）；`null` 表示还没设置，轮播首次使用时写入默认随机路径 |
| `rotationPosition` | 下一张在轮播路径里的 0 起序号；`-1`（`WALLPAPER_ROTATION_FROM_START`）表示刚换了路径，下一次从第 1 张开始 |
| `style` | 壁纸模式 → 样式，如 `{ "native": "fill", "window": "fit" }`，可以缺键 |
| `transition` | 壁纸模式 → 过渡，可以缺键 |
| `currentImageId` | 当前壁纸的图片 id |

路径与位置的语义见 [ROTATION_PATHQL.md](ROTATION_PATHQL.md)。字段的规范化在 `WallpaperTargetConfig` 的方法里：`set_rotation_path` 去首尾空白与末尾 `/`，值真正变化时把位置置为 `-1` 并返回 `true`；`set_rotation_position` 不低于 `-1`；`set_current_image_id` 把空串当作未设置。解析 settings.json 时逐字段宽松处理，类型不对的字段取默认值，不是对象的目标条目跳过。

设置层（core）只提供按目标 id 寻址的读写，不认识显示器模式：

- `get_wallpaper_targets()` / `get_wallpaper_target(id)`：目标不存在返回 `None`；
- `update_wallpaper_target(id, seed, f)`：读-改-写一个目标，不存在时以 `seed()` 为初值并落盘；
- `update_all_wallpaper_targets(f)`：对所有已有目标执行 `f`；
- `remove_wallpaper_target(id)`、`clear_wallpaper_targets_current_images(removed_ids)`。

这几个写入口共用一把互斥锁（轮播线程、命令、删图清理会并发改同一个 map），**有变化才发一次 `setting-change`，载荷是整个 map**：`{ "wallpaperTargets": { … } }`。改一个字段也会让所有观察方收到全量，观察方要自己比较关心的字段有没有变。

### 设置迁移 v005

`settings/migrations/v005_wallpaper_targets.rs` 把 7 个扁平键并入 `wallpaperTargets.multiple` 后删除旧键，并写入 `wallpaperDisplayMode = "multiple"`：

| 旧键 | 目标字段 |
| --- | --- |
| `wallpaperRotationPath` | `rotationPath` |
| `wallpaperRotationPosition` | `rotationPosition` |
| `wallpaperStyleByMode` + `wallpaperStyle` | `style` |
| `wallpaperTransitionByMode` + `wallpaperRotationTransition` | `transition` |
| `currentWallpaperImageId` | `currentImageId` |

规则：

- `wallpaperStyle` / `wallpaperRotationTransition` 是当前壁纸模式下用户最后看到的值，记到 `wallpaperMode` 名下并覆盖 `ByMode` 里同模式的值；`wallpaperMode` 缺失时用平台默认模式。历史 snake_case 键 `wallpaper_style_by_mode` / `wallpaper_transition_by_mode` 一并合并，优先级最低。
- 旧键在就以旧键为准、逐字段覆盖 `multiple` 里已有的值（降级到旧版本再升级时，旧键是用户最后一次的选择）；旧键显式为 `null` 也算「在」。旧键不在的字段保留已有值，都没有才用默认值，所以重跑结果不变。
- 类型不对的旧值按没有处理；位置不低于 `-1`；非法的 `wallpaperDisplayMode` 改成 `multiple`；其它目标与全局键不动。
- 全新安装不跑迁移，`wallpaperTargets` 是空表，`multiple` 目标由控制器启动时补种。

Android 的轮播 Worker 直接读 settings.json，迁移后它读的是 `wallpaperTargets.multiple` 的 `rotationPath` 与 `style.native`。Web 版前端另有一条本地迁移（`stores/localSettingsMigrations.ts`），见下文「前端」。

## 控制器

`WallpaperController`（`kabegame/src/wallpaper/manager/mod.rs`）是唯一知道显示器模式、活跃目标、默认目标与目标覆盖哪些屏的地方。manager 只按它给的布置输出，轮播器只按目标 id 调度，core 的设置层不参与这些判断。

```rust
pub enum Placement {
    All { screens: Vec<ScreenInfo> },   // 所有在线屏同一张（multiple；没有屏幕信息时屏列表为空）
    Span,                               // 整个桌面一块画布（span）
    One { screen: ScreenInfo },         // 只有这一块屏（single）
}

pub struct Layout {
    pub display_mode: DisplayMode,
    pub targets: Vec<(String, Placement)>,   // 活跃目标，默认目标在前
    pub default_target: String,
}
```

### 活跃目标与默认目标

`compute_layout(display_mode, screens, default_screen)` 是纯函数：

- `multiple` → 活跃目标 `["multiple"]`，默认目标是它；
- `span` → `["span"]`；
- `single` → 每块在线屏一个 `screen:<id>`。默认目标是 `wallpaperDefaultScreen` 对应的屏；它不在线或未设置时取主屏，没有主屏标记时取第一块。默认目标排第一，其余保持枚举顺序。屏不在线时不改写设置，屏回来后默认恢复。
- `single` 但没有任何屏幕信息 → 按 `multiple` 给出（返回的 `Layout.display_mode` 也是 `Multiple`）。

不在活跃集合里的目标（断开的屏、别的显示器模式的目标）保留在设置里，不调度、不输出。

### 生效的显示器模式

设置里的显示器模式在当前壁纸模式下不可用时，按 `multiple` 生效（`display_mode_for(wallpaper_mode)`）。为了让「设置里的值 = 实际生效的值」，有两处把回落后的值写回设置：

- 启动时 `init_global` → `align_settings()`；
- 切壁纸模式时 `set_wallpaper_mode`。

前端因此可以直接照设置算活跃目标。

### 补种

`layout()` / `layout_for(display, seed)` 算完布局后，把设置里还没有的活跃目标落盘，保证之后各目标各自独立。种子的优先级：调用方给的 `seed`（切显示器模式、切壁纸模式时是切换前的默认目标）→ 本布局默认目标已有的配置 → 全新目标。全新目标各字段为默认值，只有一个例外：平台默认过渡（Windows 为 `fade`，其余平台为 `none`）在当前能力表里但不是第一项时，显式写到当前壁纸模式名下。

`layout()` 有写设置的副作用，轮播每一轮、每个带 `target` 的命令都会调用它；目标都已存在时不写、不发事件。

### 目标解析

- `resolve_target(target: Option<&str>)`：`None` 或空串取默认目标；指定的目标必须在活跃集合里，否则报错（不能给休眠屏或别的显示器模式的目标设图）。
- `target_at_cursor()`：托盘「下一张」用它。规则在纯函数 `target_for_cursor(layout, cursor_screen)` 里：
  - `single` 下取光标所在屏（`screens::screen_at_cursor()`）的目标；
  - 光标不在任何一块屏的矩形里、取不到光标位置，或那块屏不在当前布局里（刚接上、布局还没重算）时用默认目标；
  - `multiple` / `span` 只有一个目标，光标在哪都是它。

  每次调用记一条 debug 日志「光标所在屏: <屏 id>，对应壁纸目标: <目标 id>」，核对坐标系时看它。

## 能力

`get_wallpaper_capabilities` 的结构是「壁纸模式 → 该模式下列出的显示器模式」：

```rust
pub struct WallpaperCapabilities {
    pub modes: Vec<WallpaperOption>,
    pub display_modes: HashMap<String, Vec<DisplayModeCapability>>,   // JSON: displayModes
}

pub struct DisplayModeCapability {
    pub value: DisplayMode,
    pub label: Value, pub desc: Value,     // i18n map
    pub unavailable: Option<Value>,        // None = 可用；Some = 不可用原因的 i18n map
    pub styles: Vec<WallpaperOption>,
    pub transitions: Vec<WallpaperOption>,
    pub shared_style: bool,                // JSON: sharedStyle
}
```

- 列出哪些显示器模式：Android 与 `plasma-plugin` 只列 `multiple`，其余壁纸模式列全部三项。
- 可用性来自 manager 的 `unavailable_reason(display)`，返回不可用原因的 i18n 键。默认实现对 `multiple` 以外一律返回 `settings.displayModeLater`（「该显示器模式将在后续版本提供」），Windows / Linux / Android 的原生后端与 Plasma 插件用的就是它。覆盖了它的有两处：
  - 窗口后端：`span` 返回 `settings.displayModeSpanWindow`（「窗口模式暂不支持跨屏拼接」）；`single` 在 macOS 可用，在 Windows 仍返回 `settings.displayModeLater`（没有显示器枚举，无从逐屏）；
  - macOS 的原生后端：`single` 可用，`span` 返回 `settings.displayModeSpanNoSystem`（「系统没有跨屏铺放，该模式不可用」）。macOS 上 `span` 因此在两种壁纸模式下都置灰，原因各不相同。
- 样式与过渡来自 manager 的 `supported_styles(display)` / `supported_transitions(display)`。目前各后端不看 `display` 参数：窗口模式与 Plasma 插件是五种样式、四种过渡；原生模式的样式 Windows / GNOME 五种、Plasma 四种（无 `stretch`）、macOS 四种（`fill` / `fit` / `stretch` / `center`，无 `tile`）、Android 只有 `fill`，过渡 Windows 为 `none`（显示为「跟随系统」）与 `fade`，其余平台只有 `none`。
- `shared_style` 为 `true` 表示该组合下样式对所有目标只有一个值（系统只有一个全局壁纸位置），写样式时要级联到全部活跃目标。目前没有后端返回 `true`：macOS 原生的样式是随每次设图带给系统的选项，逐屏各记各的。

后端是能力的唯一来源，前端只照能力表显示与禁用，不写平台判断。原来 core 里按平台写死的 `normalize_style_for_mode` / `normalize_transition_for_mode` 已删除。

## 有效样式与过渡

目标里按壁纸模式存的值只在**读取时**按能力归一化，不写回：

1. 取 `style[壁纸模式]`（或 `transition[壁纸模式]`）；
2. 值在该「壁纸模式 × 显示器模式」的选项里就用它；
3. 否则取选项第一项；选项为空时样式取 `fill`、过渡取 `none`。

后端是 `WallpaperController::effective_style` / `effective_transition`（指定模式的版本带 `_in` 后缀），前端是 `utils/wallpaperTargets.ts` 的 `effectiveStyle` / `effectiveTransition`，两边规则相同。前端多一条：能力表还没读到时先用存下来的值，免得界面在能力表到达前后跳一下。

## manager trait

```rust
pub trait WallpaperManager: Send + Sync {
    fn supported_styles(&self, display: DisplayMode) -> Vec<WallpaperOption>;
    fn supported_transitions(&self, display: DisplayMode) -> Vec<WallpaperOption>;
    fn unavailable_reason(&self, display: DisplayMode) -> Option<&'static str>;   // i18n 键；None = 可用
    fn shared_style(&self, display: DisplayMode) -> bool;
    async fn set_wallpaper(&self, file_path: &str, style: &str, transition: &str,
                           placement: &Placement) -> Result<(), String>;
    fn reconcile(&self) -> Result<(), String>;                            // 默认空实现
    fn window_assignment(&self, label: &str) -> Option<WindowAssignment>; // 默认 None
    fn cleanup(&self) -> Result<(), String>;
    fn init(&self) -> Result<(), String>;
}
```

`reconcile` 把后端的输出面（窗口集合）对齐到当前布局，只有窗口后端有实现。它不带布局参数：布局由后端在自己的锁内现算。如果让调用方先算好再传进来，排队等锁期间屏幕又变了，旧布局会盖掉新布局。`window_assignment` 返回某个壁纸窗口的布置，同样只有窗口后端有。

一次输出就是一次 `set_wallpaper`：文件、样式、过渡、布置全部由调用方带入，**后端不反读设置**。原来的 `set_style` / `set_transition` / `set_wallpaper_path` 与控制器上的 `set_wallpaper(path, style)` 已删除；「改样式后让它生效」由调用方取目标的当前壁纸再调一次 `set_wallpaper` 表达（`WallpaperController::reapply_target`）。

各后端现状：

- **原生**（`native.rs`）：
  - macOS：系统只有逐屏的入口。`Placement::All` 对布置里的每块屏各设一次，`Placement::One` 设一次，`Placement::Span` 报错；样式随每次调用带给系统。见下文「原生模式：macOS 逐屏」。
  - 其余平台：`Placement::All` 走 `set_all`，其余两种布置报错。Windows 先把样式写进注册表的壁纸位置，再设一次壁纸让它生效，过渡为 `fade` 时由这一次设壁纸触发系统淡入；Linux 把样式随壁纸一起交给 GNOME / Plasma；Android 把样式交给壁纸插件。
- **窗口**（`window.rs`）：样式、过渡与当前壁纸由壁纸页面从 `setting-change` 里自己读。`set_wallpaper` 只按这张壁纸是不是网页 / 场景壁纸，给显示该目标的窗口开关桌面鼠标转发：`Placement::All` 对应全部窗口，`Placement::One` 对应铺那块屏的窗口。详见下文「窗口模式：每屏一窗」。
- **Plasma 插件**（`plasma_plugin.rs`）：`set_wallpaper` 什么都不做。当前壁纸、样式、过渡由调用方写进 `multiple` 目标，Plasma 侧的插件（源码不在本仓库）经 IPC 与 `setting-change` 自己读取并显示。

## 窗口模式：每屏一窗

窗口模式下**每块在线屏一个壁纸窗口**，窗口矩形就是那块屏，各自完整渲染一幅画面。两种可用的显示器模式只差在每个窗口显示哪个目标：

| 显示器模式 | 每个窗口显示的目标 | 声音 |
| --- | --- | --- |
| `multiple` | 都是 `multiple` | 只有主屏窗口出声 |
| `single` | 各自那块屏的 `screen:<id>` | 各窗口都出声 |

不开「一个大窗口跨所有屏」：每屏一窗让每个窗口用本屏自己的缩放与刷新率，热插拔只是增删窗口。`multiple` 下同一个视频、场景、网页在几个窗口里各运行一份，互不同步（各屏是各自完整的一幅，没有接缝）；声音只让主屏窗口发出，免得同一段音频叠在一起。

### label 池

壁纸窗口的 label 取自固定的池 `wallpaper::WALLPAPER_LABELS`：`wallpaper`、`wallpaper-1` … `wallpaper-7`，共 8 个。判断「这个 label 是不是壁纸窗口」统一用 `wallpaper::is_wallpaper_label`。

用固定池而不是按屏动态起名，是因为下面这些登记都要事先知道 label：

| 登记 | 位置 | 时机 |
| --- | --- | --- |
| ACL 特赦 `acl_exempt_webview` | `lib.rs` | Builder 期，之后不能再加 |
| `main-capability`、`wpe-web-capability` 的 `windows` | `capabilities/main.json(.handlebars)`、`wpe-web.json` | 静态文件；有单测比对它们与池一致 |
| 场景宿主的运行时 capability | `wallpaper/wpe_scene_host.rs` | 启动时 |
| `allow_file_documents` / `allow_app_local_resources` / `disable_wheel_zoom` | `manager/window.rs` 的 `create_window` | 每个窗口建窗前，按它的 label |

所以池里每个窗口的待遇与原来唯一的 `wallpaper` 窗口相同：应用页免 ACL，网页壁纸与场景宿主的 iframe 能加载、能调它们被授权的命令。超过 8 块屏时只给前 8 块（主屏第一，其余按 `(y, x)`）开窗口并记一条告警。

label 先到先得：建窗时取池里第一个空闲的（正在销毁、还没从 Tauri 的窗口表里消失的也算占用）。全新启动时主屏拿到 `wallpaper`。同一块屏在它的窗口存续期间不换 label；屏断开再接回会重新分配，可能拿到另一个。

各壁纸窗口的地址是 `index.html?window=wallpaper&slot=<label 在池里的序号>`。`slot` 页面不读，只为让调试工具按 URL 分清是哪个窗口。

### 窗口表与对齐

`WindowWallpaperManager` 持有一张窗口表（label → 窗口、它铺的屏、它的布置）。期望的窗口表由纯函数 `plan_windows(layout)` 给出：

- `Placement::All`：每块屏一条，目标相同，主屏那条出声（没有主屏标记时取第一块）；
- `Placement::One`：这块屏一条，出声；
- `Placement::Span`：不出窗口；
- 屏列表为空（没有显示器枚举的平台）：一条不绑定屏的，铺满窗口所在的屏。

对齐（`align`）按**屏的持久标识**比对现有窗口与期望的窗口表（纯函数 `diff_windows`）：

| 情况 | 处理 |
| --- | --- |
| 同一块屏已有窗口 | 保留，页面不重载 |
| ……屏的矩形或其它信息变了 | 重新铺放到新矩形（macOS 重设 frame） |
| ……布置变了 | 记下新布置，并向该窗口发 `wallpaper-assignment` |
| 屏已不在表里 | 销毁窗口（它的 ping 看门狗与鼠标转发随之停止），撤销就绪标记 |
| 表里的屏还没有窗口 | 先登记布置，再建窗；全部建完后逐个等页面就绪、挂到桌面层 |

先登记布置再建窗，是因为页面初始化时就来取布置，早于它报告就绪。缺的窗口先全部建出来再逐个等就绪，各页面因此并行加载。某个窗口建窗或挂载失败时把它摘掉并销毁，其余窗口照常对齐。

三个入口共用对齐：

- `init()`：进入窗口模式（启动、切到窗口模式、重新打开壁纸）；
- `reconcile()`：显示器模式或在线屏变了之后。后端不在窗口模式时什么都不做，所以屏幕变化与模式切换交错也不会凭空建窗；
- `cleanup()`：离开窗口模式或关闭壁纸。销毁表里全部窗口，并把池里每个 label 都查一遍，异常路径留下的窗口也一并销毁。

它们由一把锁串行（对齐期间要等页面就绪，可能持有数秒）；窗口表另有一把只在读写瞬间持有的锁，持有期间不调用会同步等主线程的窗口接口。

对齐之后控制器把各活跃目标重新输出一次（`realign_outputs`），窗口后端借此给新建的窗口按它的壁纸类型开鼠标转发。

### 挂载

- **macOS**：`window_mount_macos::mount_to_desktop(window, screen)` 把窗口设成无边框、桌面图标层之下、忽略鼠标，frame 设成那块屏的矩形。屏的矩形是左上原点的点坐标，换回 Cocoa 屏幕坐标时用主屏高度翻转 y（与枚举时的换算互逆）。建窗时位置与大小就按目标屏给，挂载时再精确铺一次。各窗口各自 frame 到各自的屏，与系统「显示器具有单独的空间」的设置无关。
- **Windows**：没有显示器枚举，窗口不绑定屏，仍是建一个全屏窗口、经 `tauri-plugin-wemt` 挂到 WorkerW（见 [WINDOW_MOUNT_WEMT.md](WINDOW_MOUNT_WEMT.md)）。

### 布置

```rust
pub struct WindowAssignment {   // JSON 为 camelCase：{ targetId, audible }
    pub target_id: String,      // 这个窗口显示哪个壁纸目标
    pub audible: bool,          // 出不出声
}
```

- 窗口启动时调 `get_wallpaper_window_assignment()` 取自己的布置，后端按调用方 label 查表；
- 之后布置变化（切显示器模式、主屏换了）时后端 `emit_to(label, "wallpaper-assignment", 布置)`，只送到那一个窗口；
- 窗口先登记监听再取初值，所以不会漏掉两者之间的变化。

布置与带着目标配置的 `setting-change` 不走同一条通道，到达先后不保证。窗口收到指向一个本地还没有配置的目标的布置时先不动画面，等配置到了再算。

### 就绪、ping、鼠标转发

三者都是每个窗口各一份：

- **就绪握手**：后端记一个「已就绪的 label」集合。页面初始化完调 `wallpaper_window_ready`，命令按调用方 label 登记；后端建窗后等到这个 label 才挂载并显示。销毁窗口时撤销，否则同一个 label 下次重建时会被当成已就绪。
- **ping 看门狗**：每个窗口挂载后启动自己的看门狗，序号各自独立。`wallpaper-ping { label, seq }` 是广播事件，每个窗口只应答 label 是自己的那一条；`wallpaper_pong` 按调用方 label 记，页面替不了别的窗口应答。一个窗口失联只重载它自己。
- **桌面鼠标转发**：每个显示网页或场景壁纸的窗口各有一条转发线程，按自己窗口的范围判断光标在不在里面。光标在哪块屏，就只有那块屏的窗口收到移动与点击，其它窗口在光标离开时收到一次离开。

WPE 网页壁纸的音频 / 媒体订阅本来就按 `(label, frame, 类型)` 归属，多窗口不需要改。

## 原生模式：macOS 逐屏

macOS 的原生后端经 `NSWorkspace.setDesktopImageURL(_:for:options:)` 设系统桌面图片（`manager/native_mac.rs`）。这个入口一次只设一块屏，所以两种显示器模式只差在调几次、各带哪张图：

| 布置 | 做什么 |
| --- | --- |
| `Placement::All { screens }`（`multiple`） | 对 `screens` 里的每块屏各设一次，同一张图、同一种样式 |
| `Placement::One { screen }`（`single`） | 只设这一块屏 |
| `Placement::Span` | 报错；能力表里标为不可用，正常流程走不到 |

`All` 的屏列表为空（显示器枚举还没填充或失败）时有兜底：直接对系统当前的每一块 `NSScreen` 各设一次。一块屏失败不影响其余屏，全部试过后把失败的屏一起报出来。原来用 osascript 让 System Events 给「每个桌面」设图的路径已删除。

### 屏的对应

屏按持久标识（display UUID，即 `ScreenInfo::id`）现查 `NSScreen`：`screens::find_ns_screen(mtm, id)` 走的是与枚举相同的「`NSScreen` → `CGDirectDisplayID` → UUID」路径，所以设到的屏与布局里的屏一定是同一块；有一条读真机屏幕的单测核对「枚举到的每块屏都能按 id 查回同一个 frame」。`NSScreen` 对象在热插拔后会失效，不缓存，每次设图前现查；屏已不在线时报「显示器不在线」。

### 线程

查屏在主线程（`NSScreen` 只能在主线程读），**设图在调用线程**，不在主线程：`setDesktopImageURL` 要等系统的壁纸服务，实测一次 0.6 s 上下、偶尔超过 1 s（图与选项都没变时几毫秒就返回），放在主线程会让整个应用界面卡住这么久，每块屏一次。做法是 `ScreenRef`：主线程上查到的 `NSScreen` 带到调用线程，只原样传给 `NSWorkspace`、不读写它的属性，用完送回主线程释放。原生后端把整次输出放在 `spawn_blocking` 里，不占异步运行时的工作线程。

### 样式

样式是每次设图带给系统的选项，**逐屏生效**，系统按屏记住。映射在纯函数 `options_for_style`：

| 样式 | `NSWorkspaceDesktopImageScalingKey`（`NSImageScaling`） | `NSWorkspaceDesktopImageAllowClippingKey` | 效果 |
| --- | --- | --- | --- |
| `fill` | 3（`ProportionallyUpOrDown`） | `true` | 等比盖满屏幕，多出的裁掉 |
| `fit` | 3 | `false` | 等比完整显示，留边 |
| `stretch` | 1（`AxesIndependently`） | 不带 | 两个方向各自拉满，会变形 |
| `center` | 2（`None`） | 不带 | 原始大小居中，留边；比屏大的部分裁掉 |

留边的颜色由 `NSWorkspaceDesktopImageFillColorKey` 给，固定黑色。没有平铺：系统的缩放选项里没有对应项，能力表不列 `tile`；窗口模式的 `tile` 也带不到原生模式（`carry_to_mode` 只带新模式支持的值），原生模式读取时按能力取第一项 `fill`。

macOS 26.6 实测（2026-11-11）：四种样式设下去之后，另起一个进程用 `desktopImageOptions(for:)` 读回，缩放值分别是 3 / 3 / 1 / 2，`fill` 与 `fit` 的允许裁剪分别是 `true` / `false`（`stretch` / `center` 读回时没有这个键，带不带都一样）；副屏的画面也确实是四种不同的铺法。`NSImageScaleProportionallyDown`（0）不用：系统把它记成「3 + 允许裁剪」，与 `fill` 没有区别。同一张图只换选项再设一次也会生效，所以改样式不需要换图。

### 能显示什么

`NSWorkspace` 对文件类型不挑：把视频、甚至目录交给它都不报错，桌面图片会被指到一个它画不出来的东西上（原来的 osascript 路径下系统是默默不理）。所以原生后端在交给系统之前先过 `native_mac::can_display`：路径是目录（WPE 壁纸）或视频文件时**跳过、保持系统壁纸现状**，返回成功并记一条 debug 日志。设单张与轮播在更早的地方就拦掉了视频与 WPE，会走到这里的是切壁纸模式、启动恢复、关开壁纸时目标里留着的旧壁纸。

WebP、AVIF、HEIC 这些格式 macOS 自己能解，直接把原图交给系统，不经过原生壁纸的兼容副本（[NATIVE_WALLPAPER_COMPAT.md](NATIVE_WALLPAPER_COMPAT.md) 只管 Windows / Linux）。

### 屏幕变化

原生模式下 `on_screens_changed(previous)` 只给**新接入**的屏输出，规则在纯函数 `outputs_for_new_screens(layout, previous)`：

- `multiple`：新接入的屏各出一条只落这块屏的输出（`Placement::One`），目标仍是 `multiple`，于是新屏得到大家都在显示的那一张与同一种样式；
- `single`：新接入的屏输出它自己的目标——以前留下的配置，或刚从默认目标补种的那份；
- 已在线的屏不重设（系统按屏记着各自的桌面图片，重设一遍只会白白闪一下），断开的屏什么都不用做；
- 只是挪了位置、改了分辨率、换了主屏的屏不算新接入（按 id 判断）。

「新接入」是拿这次提交的在线屏与上一次提交的比。变化前一块屏都没有时（比如全部显示器休眠后醒来），每块屏都算新接入，各设一次。目标没有当前壁纸、或当前壁纸是视频 / WPE 时不输出。

### 只改当前 Space

`setDesktopImageURL` 只改那块屏**当前 Space** 的桌面图片，别的 Space 仍是它们各自原来的图；应用不遍历 Space（系统没有公开的入口）。原来的 osascript 路径也是如此（System Events 的「desktop」对应的是显示器，不是 Space）。

## 切换

### 改样式、改过渡

- `set_wallpaper_style(style, target?)`：先按当前组合的能力校验，不支持直接报错。把值写到目标的 `style[当前壁纸模式]`，`shared_style` 时对全部活跃目标写同一值，然后对受影响的目标各 `reapply_target` 一次。目标没有当前壁纸、图片行或文件已不存在时 `reapply_target` 什么都不做，所以原生模式下没有当前壁纸时改样式不会去动系统的壁纸位置，下次设图时才带上。macOS 原生的样式不共用：逐屏独立下改一块屏的样式只重设那一块屏，各屏复制下重设每一块屏。
- `set_wallpaper_rotation_transition(transition, target?)`：同样先校验，写 `transition[当前壁纸模式]`；轮播开着且过渡不是 `none` 时把这个目标切一张来演示。
- 设单张壁纸（`set_wallpaper_by_image_id`）与启动恢复交给后端的过渡固定是 `none`，不读也不改目标里存的过渡。这个参数只对原生后端有意义；窗口模式的过渡由壁纸页面按目标的有效过渡自己做，所以窗口模式下设单张也会播放过渡。

### 切壁纸模式

`set_wallpaper_mode(mode)` 的顺序：

1. 停轮播；按新模式算生效的显示器模式与新布局，缺的目标从切换前的默认目标复制。
2. 逐个活跃目标确定新模式下要显示的文件：当前壁纸是 WPE 目录型壁纸而新模式不是窗口模式、或文件已不存在时，从画廊随机取一张兜底；任何一个目标无图可用就中止并恢复轮播。没有当前壁纸的目标跳过。
3. 所有检查通过后才动后端生命周期（新后端 `init`，旧后端 `cleanup`），中止时不留半切换状态。
4. **沿用样式与过渡**（`carry_style_to_mode`，规则在纯函数 `carry_to_mode` 里）：样式与过渡按壁纸模式各记各的。对设置里的每个目标（不只是活跃的），样式、过渡分别判断：
   - 新模式名下**已经有值**：一律不动。来回切换后各模式仍是各自上次的设置；
   - 新模式名下**还没有值**（这个目标第一次进入该模式）：取它在旧模式下的有效值，新模式也支持就写到新模式名下；不支持就不写，读取时照常按能力取第一项。

   例：逐屏独立下副屏在窗口模式设了「适应 / 淡入淡出」，切到原生再切回窗口，副屏窗口模式的样式、过渡仍是「适应 / 淡入淡出」。
5. 显示器模式有回落就写回设置；用新模式下的有效样式、过渡逐目标输出；写 `wallpaperMode`；各目标按当前壁纸重定位轮播位置；按开关恢复轮播。

### 切显示器模式

`WallpaperController::set_display_mode(mode)`（命令 `set_wallpaper_display_mode`）：按能力校验（不可用时错误信息就是不可用原因）→ 停轮播 → 写设置 → 重算布局（缺的目标从切换前的默认目标复制）→ 后端 `reconcile` 并逐目标 `reapply_target` → 按开关恢复轮播。入口是设置页的显示器模式选择器。

窗口模式下在 `multiple` 与 `single` 之间切换不重建窗口：屏没变，每个窗口只收到一条新的布置，改读另一个目标。各显示器模式的目标各自保留，例如从 `single` 切回 `multiple` 再切回来，各屏仍是原来各自的壁纸。

切壁纸模式时，当前显示器模式在新模式下不可用就回落 `multiple` 并写回设置（上一节第 5 步）。macOS 上窗口与原生两种模式都支持 `single`，互切时显示器模式保持不变，各屏的目标配置与各模式名下的样式都保留；切到原生时每块屏的系统桌面图片换成它自己目标的当前壁纸（当前壁纸是视频的目标保持系统壁纸现状，是 WPE 壁纸的按上一节第 2 步换成兜底图）。会回落的是新模式确实不支持的情况，例如 Windows 上从窗口模式的 `single`（待实现）切到原生：显示的是 `multiple` 目标的当前壁纸，再切回窗口模式时显示器模式仍是 `multiple`，要逐屏独立需重新选一次。

### 关开壁纸、启动恢复

`init_wallpaper_on_startup`（启动与重新打开壁纸共用）对布局里的每个活跃目标各恢复一次：目标有当前壁纸且图片行、文件都在，就以有效样式输出；图片行或文件不存在、输出失败时清空该目标的 `currentImageId`。

窗口模式下，关闭壁纸会销毁全部壁纸窗口，重新打开时按当前布局重建；逐屏独立下应用重启后各屏恢复各自的壁纸。macOS 原生模式下每个活跃目标按它的布置输出一次：各屏复制时每块屏各设一次同一张，逐屏独立时每块屏设一次自己的那张，没有多余的重设；关闭壁纸不动系统桌面图片。

## 轮播

开关与间隔是全局的，一个 ticker。到点时对所有活跃目标各切一张，每个目标按自己的路径与位置选图；一个目标失败不影响其它目标。逐屏独立下各屏因此在同一个节拍各换一张、各走各的路径（窗口模式与 macOS 原生模式都是；原生模式逐屏调系统接口，两块屏先后差一秒左右）；断开的屏的目标不在活跃集合里，不调度。`WallpaperRotator::rotate(target: Option<&str>)` 可以只切一个目标：换某个目标的轮播路径、演示过渡、托盘「下一张」都只切对应的目标。选图与线程的细节见 [ROTATION_PATHQL.md](ROTATION_PATHQL.md)。

## 命令与事件

Tauri 命令（主窗口与壁纸窗口免 ACL，注册在 `lib.rs` 的 `generate_handler!`）：

| 命令 | 说明 |
| --- | --- |
| `set_wallpaper_by_image_id(imageId, target?)` | 把图设为目标的壁纸 |
| `get_current_wallpaper_image_id(target?)`、`clear_current_wallpaper_image_id(target?)` | 目标的当前壁纸 id |
| `get_current_wallpaper_path(target?)`、`get_current_wallpaper_target(target?)` | 目标的当前壁纸路径 / 渲染用的完整描述 |
| `get_wallpaper_window_assignment()` | 调用方壁纸窗口的布置 `{ targetId, audible }`；调用方不是壁纸窗口、或窗口不在册时为 `null` |
| `set_wallpaper_rotation_path(path, target?)` | 目标的轮播路径 |
| `set_wallpaper_style(style, target?)`、`set_wallpaper_rotation_transition(transition, target?)` | 目标在当前壁纸模式下的样式 / 过渡 |
| `get_wallpaper_targets()` | 整个目标 map，形状与 `setting-change` 里的相同 |
| `get_wallpaper_display_mode()`、`set_wallpaper_display_mode(mode)` | 显示器模式 |
| `get_wallpaper_default_screen()`、`set_wallpaper_default_screen(screenId)` | 默认显示器；屏必须在线，空串表示清除 |
| `forget_wallpaper_target(targetId)` | 删除一个目标的配置；只允许删不在活跃集合里的 `screen:*` |
| `list_wallpaper_screens()` | 在线显示器列表（`ScreenInfo[]`，主屏在前；没有屏幕枚举的平台为空） |
| `get_wallpaper_capabilities()` | 能力表，见上 |

`target` 都是可选的目标 id，缺省为当前显示器模式的默认目标，经 `resolve_target` 解析。有一个例外：上表第二、三行的四个「当前壁纸」命令不带 `target` 时，如果调用方是壁纸窗口，取的是该窗口的布置目标（逐屏独立下就是它那块屏的目标），不是默认目标。`set_wallpaper_rotation_enabled`、`set_wallpaper_rotation_interval_minutes`、`start_wallpaper_rotation`、`set_wallpaper_mode`、`set_wallpaper_enabled` 是全局的，不带 `target`；`start_wallpaper_rotation` 返回结果里的路径与回落标记只报默认目标的。

已删除的命令：`get_wallpaper_rotation_path`、`get_wallpaper_rotation_style`、`get_wallpaper_rotation_transition`、`get_wallpaper_style_by_mode`、`get_wallpaper_transition_by_mode`。要读这些值，取 `get_wallpaper_targets()` 再按上面的规则归一化。

名字容易混：`get_current_wallpaper_target` 返回的 `WallpaperTarget` 是「当前壁纸这张图怎么渲染」的描述（路径、类型、兼容副本、网页入口等），不是本文的壁纸目标配置。

事件：

- `setting-change`：`{ wallpaperTargets }`（整个 map）、`{ wallpaperDisplayMode }`、`{ wallpaperDefaultScreen }`。没有逐字段的目标事件。
- `wallpaper-assignment`：`{ targetId, audible }`，某个壁纸窗口的布置变了。用 `emit_to(label, …)` 只发给那一个窗口，主窗口收不到。
- `wallpaper-screens-change`：`{ screens: ScreenInfo[] }`，在线屏变化后的完整列表（顺序同 `list_wallpaper_screens`）。它是通用事件（`GlobalEmitter::emit`）。主窗口与壁纸窗口免 ACL，可以直接监听；它没有加进畅游、爬虫、网页壁纸的监听作用域。屏幕在线与否不是设置，所以不走 `setting-change`。

app IPC 的对应变体（协议 v5）见 [../cli/CLI_IPC.md](../cli/CLI_IPC.md)。桌面应用 Web 服务器的 JSON-RPC 复用 `get_wallpaper_capabilities`，返回的也是新结构；经 `get_settings` 读设置的外部调用方要改读 `wallpaperTargets`。

## 前端

- **形状与纯规则**：`utils/wallpaperTargets.ts`。类型 `WallpaperTargetConfig` / `WallpaperTargets` / `WallpaperScreen` / `DisplayModeCapability`，以及与后端同规则的 `effectiveDisplayMode`、`activeTargetIds`、`effectiveStyle` / `effectiveTransition`；屏与目标的对应也在这里：`targetIdOfScreen`（一块屏在某个显示器模式下属于哪个目标）、`screenIdOfTarget`、`defaultScreenId`、`disconnectedScreenTargets`。不碰 store 与 IPC，主窗口与壁纸窗口共用。
- **读写入口**：`composables/useWallpaperTarget.ts`。
  - `useWallpaperTarget(targetId?)`：返回目标的 `id`、`config`、有效的 `style` / `transition`、当前组合的能力 `combo`、`currentImageId`、`rotationPath`、`loading`，以及 `setRotationPath` / `setStyle` / `setTransition`。不传 `targetId` 就是默认目标，这时写命令不带 `target`，由后端落到默认目标。
  - `useWallpaperDisplayMode()`：实际生效的显示器模式。
  - `useActiveWallpaperTargets()`：活跃目标 id，默认目标在前。
  - `useActiveWallpaperImageIds()`：所有活跃目标的当前壁纸 id 集合。
  - `useActiveWallpaperRotationPaths()` 与非组件场合用的 `activeWallpaperRotationPaths()`：所有活跃目标的轮播路径（没设路径的目标不算）。
  - `useWallpaperRotationSources()`：每个活跃目标一条 `{ targetId, path }`，与活跃目标同序，没设路径的目标也在（`path` 为 `null`）。要判断「是不是每块屏都在轮播它」时用它。
  - `activeWallpaperTargets()`：活跃目标的即时快照，给不在组件里的调用点用；与 `useActiveWallpaperTargets()` 是同一份计算。
  - `setWallpaperRotationPath(path, target?)`：给先选了目标的入口用的写路径函数；绑定在某个目标上的界面仍用 `useWallpaperTarget(id).setRotationPath`。
  - `wallpaperTargetScreenName(targetId)`：逐屏目标所在屏的显示名（屏的名字，没有名字时是「显示器 N」，N 与布局图上的序号相同）；不是逐屏目标或屏不在线时为 `null`。
- **真值只有一份**：`settingsStore.values.wallpaperTargets`。描述符里它是只有 getter（`get_wallpaper_targets`）的 `tauri` 键，不经 `settingsStore.save`；写操作直接调带 `target` 的命令，不做本地乐观副本，等后端的 `setting-change` 落地。「保存中」状态由各设置项自己持有：新值落地或命令返回即结束，先到者为准（样式、过渡两个设置项如此）。
- **能力**：`useWallpaperCapabilities` 提供 `displayModesFor(mode)` 与 `comboFor(mode, display)`，取代原来的 `stylesFor` / `transitionsFor`。
- **在线屏**：`composables/useWallpaperScreens.ts`，全应用一份。首次使用时先登记 `wallpaper-screens-change` 再读一次 `list_wallpaper_screens`，之后只跟事件走（事件带完整列表，不回读；读取在途时先到的事件优先，过时的读取结果不覆盖它）。`useWallpaperTarget` 系列与布局图读的是同一个 ref，所以活跃目标、默认目标随热插拔自动重算。`wallpaperScreensLoaded()` 返回首次读取结束（成功或失败）的 Promise，按在线屏做一次性判断的地方先等它，免得把「还没读到」当成「没有屏」。
- **显示器模式选择器**：`components/settings/items/WallpaperDisplayModeSetting.vue`。选项、可不可选、不可选的原因全部取自能力表里当前壁纸模式的那一组：不可选的项置灰，悬停显示 `unavailable`；可选的项悬停显示该模式的说明。写入走 `set_wallpaper_display_mode`，被拒时回到原值并提示后端给的原因。选中框显示的是生效的模式。能力表只列一项时（Android、Plasma 插件模式）设置页整行不显示。单项不可选与悬停说明是通用分段控件 `KbSegmentedControl` 的选项字段（`disabled`、`tip`）。
- **显示器布局图**：`components/wallpaper/WallpaperScreenLayout.vue`（不在 `settings/` 下：目标选择弹窗要共用）。
  - 入参：`v-model:selected`（目标 id）、`displayMode`、`defaultScreen`、`showDisconnected`。屏列表自己取（`useWallpaperScreens`），没有在线屏时什么都不渲染。
  - 事件：除 `update:selected` 外还有 `confirm(targetId)`，双击一块屏、或焦点在屏块上按回车时发出（回车会先选中再确认）。目标选择弹窗用它直接返回，设置页不监听。
  - 可用宽度量的是画布里一个高度恒为 0 的元素，不是画布本身：布局图会把画布撑高，直接量画布会再触发一次测量，在对话框里挂载时（初始宽度为 0）浏览器会报 `ResizeObserver loop completed with undelivered notifications`。
  - 几何是纯函数 `utils/wallpaperScreenLayout.ts` 的 `layoutScreens`：并集外接矩形 → 平移到原点 → 等比缩放到不超过「容器宽 × 132 px」。各边先缩放再取整，相邻两块屏共用的边取到同一个整数，贴在一起的屏不重叠也不裂缝；块与块之间再各自内缩 2 px 留缝。
  - 每块显示序号（列表顺序，主屏是 1）、名字、物理像素分辨率，主屏带「主屏」角标，逐屏独立下默认屏另带「默认」角标。块小到放不下时依次省掉分辨率、名字与角标，只留序号；完整信息始终在 `title` 里。
  - 选中的含义随显示器模式变：`multiple` / `span` 下所有屏同属一个目标，点哪块都选中它、所有块一起高亮（`span` 另画并集外框）；`single` 下每块屏各是一个目标。
  - 只有一块屏时照画，下面附一行说明。`showDisconnected` 且逐屏独立时，列出配置还在但屏已不在线的目标（屏的名字不存盘，显示标识的前 8 位）及「忘记」入口（`forget_wallpaper_target`）。
- **设置页壁纸分区**（`views/Settings.vue`）分三层：
  1. 全局：打开壁纸、壁纸模式（排在显示器模式之前，它决定哪些显示器模式可选）、显示器模式、轮播开关、轮播间隔；
  2. 显示器布局图：有在线屏信息才显示，说明文字随显示器模式变；逐屏独立下选中的屏不是默认屏时有「设为默认」；
  3. 选中目标的设置：轮播路径、当前壁纸（含属性按钮）、样式、过渡。

  逐屏独立下第二、三层才真正分屏：点布局图里的一块屏，第三层就是那块屏的目标；「已断开」列表里是配置还在、屏不在线的目标，「忘记」后那块屏再接回来时从默认目标重新复制一份。

  之后是其余全局项：暂停、音量、倍速、媒体集成、场景后处理、WPE 目录。**选中的目标是页面本地状态**，记在 `localStorage`（`kabegame-settings-wallpaper-target`），不进设置；记下的目标不在当前活跃集合里（换了显示器模式、那块屏断开）时显示默认目标，记录本身不动，屏接回来还是它。第三层的写命令都带选中目标的 id。
- **目标选择弹窗**：设置页以外凡是要落到某个目标的操作都先经它。
  - 入口是命令式函数 `pickWallpaperTarget({ action })`（`composables/useWallpaperTargetPicker.ts`，写法同 `askSettingChoice`）：模块级的待处理请求，加挂在 `App.vue` 的宿主 `components/wallpaper/WallpaperTargetPickerHost.vue`，调用方 `await` 结果。`action` 是 `"setWallpaper"` 或 `"setRotation"`，只决定标题。
  - 返回值是目标 id，可以直接当命令的 `target`；用户取消返回 `null`，调用方此时什么都不做。
  - **只有一个活跃目标时不弹**，直接返回它：各屏复制、跨屏拼接，或逐屏独立但只接一块屏。判断用的是 `activeWallpaperTargets()`，与后端布局同规则；调用前先等 `wallpaperScreensLoaded()`。
  - 同时只有一个请求：后来的顶掉前一个，前一个按取消返回，弹窗不关、标题与预选按新请求重置。
  - 弹窗里是布局图（固定按逐屏独立画、不列断开的屏），预选默认屏，打开后焦点在预选的屏块上。点一块屏选中；「确认」、双击屏块、回车返回；「取消」、右上角、Esc、点遮罩、Android 返回键返回 `null`。不带「记住选择」，默认屏只作预选。
  - 打开期间活跃目标变了：只剩一个（副屏断开、显示器模式被改成各屏复制）时直接以它返回并关闭；选中的屏断开但还有不止一块时，预选回到默认屏。
  - 开关与层级走统一的模态栈（`useModal`），所以压在预览等已打开的弹层之上。
- **各入口**（都先 `pickWallpaperTarget`，再带 `target` 调命令）：

  | 入口 | 位置 | 说明 |
  | --- | --- | --- |
  | 图库 / 预览的「设为壁纸」（单选） | `useImageOperations.setWallpaper` | `set_wallpaper_by_image_id({ imageId, target })` |
  | 「设为壁纸」（多选） | 同上 | 先选屏，再建「桌面画册 N」并设成该目标的轮播路径；取消时不建画册 |
  | 画册「设为轮播」（详情栏按钮、画册树右键） | `views/Albums.vue` 的 `setWallpaperRotation` | `set_wallpaper_rotation_path({ path, target })`，轮播没开时顺带打开（开关是全局的） |
  | 查询行「用当前视图轮播」 | `GalleryQueryBar.vue` | 同上 |

  - 有多个活跃目标时成功提示带屏名（`pickedScreenName`），例如「已设为「DeskPad Display」的壁纸」；只有一个目标时提示照旧。
  - **与「需要窗口模式」引导的先后**：先选屏，再设图；这张图需要别的壁纸模式（视频、WPE 要窗口模式）时后端报错，前端才弹确认框并切模式（`utils/wallpaperMode.ts` 的 `setWallpaperByImageIdWithModeFallback`）。切模式可能让显示器模式回落（新模式不支持逐屏独立），先前选的 `screen:<id>` 就不在活跃集合里了：切完后读一次 `get_wallpaper_display_mode`（后端已把回落后的值写回），按 `activeTargetIds` 判断，目标还在就用它，不在就不带 `target`、落到新的默认目标。函数返回实际设到的目标，提示里的屏名以它为准。用户在确认框里取消不算失败，不提示。
  - 不弹窗的：「停止轮播」（关的是全局开关）、应用背景、切模式引导里的兜底换图（默认目标）、托盘「下一张」（后端按光标所在屏）。
  - 收藏视图里没有设轮播的入口，只有来源标记。
- **轮播来源标记**（都要求轮播开着）。有多个活跃目标时「在轮播它」分两档：

  | 界面 | 有目标在轮播它 | 每个目标都在轮播它 |
  | --- | --- | --- |
  | 画册树的显示器图标、收藏视图的 ↻ | 标记 | 标记 |
  | 画册详情栏徽标 | 「桌面轮播中 · <屏名>」 | 「桌面轮播中 · <全部屏名>」 |
  | 画册详情栏主按钮 | 「设为桌面轮播」（给另一块屏），下面另有一个「停止桌面轮播」 | 「停止桌面轮播」 |
  | 画册树右键菜单 | 「设为桌面轮播」与「停止桌面轮播」都有 | 只有「停止桌面轮播」 |
  | 查询行「用当前视图轮播」 | 可点，下面一行小字「<屏名> 正在轮播此视图」 | 「正在轮播此视图」，禁用 |

  只有一个目标时两档重合，与多屏改造前相同。「停止桌面轮播」始终关全局开关，所有屏一起停。判断用 `utils/wallpaperRotationPath.ts` 的 `rotatingTargetIds(sources, matches)`。收藏视图里各屏可以各用一条收藏视图，所以 ↻ 可能不止一行。应用背景与预览里的过渡跟随默认目标；网格的当前壁纸提示按「任一活跃目标命中」判断。
- **不再本地清当前壁纸**：图片被删时由后端清所有目标并发事件，前端不再在删除、移出画册或图片从当前视图消失时自己清空。删画册同理，前端只保留删除前的确认提示。
- **壁纸窗口**（`views/WallpaperWindow.vue`）：每块屏一个实例，不挂设置 store。
  - 显示哪个目标由后端的布置决定：启动时先登记 `wallpaper-assignment` 再调 `get_wallpaper_window_assignment`，取不到时按 `multiple` 目标、出声处理。它不再读显示器模式、默认屏与在线屏。
  - 启动时再拉 `get_wallpaper_targets` 与能力表，之后随 `setting-change` 更新自己留的一份目标表，只看 `wallpaperTargets[布置的目标]`：样式、过渡按能力归一化后就地更新（用哪个组合的能力由目标 id 推出，`utils/wallpaperTargets.ts` 的 `displayModeOfTarget`）；这个目标的 `currentImageId` 变了才重新调 `get_current_wallpaper_target`，并明确带上目标 id。别的目标换壁纸、轮播位置等其它字段的写入都不触发；当前壁纸被清空时保留画面上的那张。
  - 布置换了目标时改读新目标；新目标的当前壁纸与画面上的相同就不重新取（从 `multiple` 切到逐屏独立时各屏的目标是从它复制的，画面不闪）。
  - 布置的 `audible` 为 `false` 时传给 `WallpaperStage` 的音量恒为 0，其余 props 各窗口相同。`WallpaperStage` 与场景宿主没有为多窗口改动。
  - dev 调试面板显示本窗口的 label 与目标。
- **Web 版**：没有壁纸后端。`wallpaperTargets` 走 localStorage，只用 `multiple.currentImageId` 记应用背景图（`utils/wallpaperMode.ts` 的 `setWallpaperOrBackground` / `clearWebBackgroundIfRemoved`）；`wallpaperDisplayMode`、`wallpaperDefaultScreen` 是只读占位；`useWallpaperTarget` 的写操作被拦下并提示桌面版。本地迁移把旧的 `kabegame-setting-currentWallpaperImageId` 并入本地的 `wallpaperTargets` 后删除旧键。

## 其它消费方

| 位置 | 行为 |
| --- | --- |
| 删画册（`kabegame-core/src/commands/album.rs`） | 所有目标（含不活跃的）里轮播路径以该画册为根的，路径置空、位置置 `-1` |
| 删图、清空隐藏、整理（`commands/image.rs`、`storage/hidden_cleanup.rs`、`storage/organize.rs`） | 所有目标里指向被删图片的 `currentImageId` 清空 |
| 托盘「下一张」（`tray.rs`） | `rotate(Some(target_at_cursor()))`：只切光标所在那块屏的目标，光标位置在菜单事件到达时读。逐屏独立以外的模式只有一个目标。macOS 每块屏都有菜单栏，从哪块屏的菜单栏点就切哪块屏 |
| Android Worker | 读 `wallpaperTargets.multiple`；Android 只有 `multiple`、只有原生模式 |
| dev 工具 `app_state`（`scripts/kabegame-dev/app.ts`） | 返回 `displayMode` 与 `targets`，不再有 `transition` / `transitionByMode` / `styleByMode` |

## 与重构前的行为差异

目标化那一期不改变用户可见行为，以下是有意的例外：

- 原生模式设单张壁纸不再把目标里存的过渡覆盖成 `none`（原来后端的 `set_transition("none")` 会顺手写设置）。
- 同一条轮播路径连续设两次，界面不再卡在保存中（原来等一个不会来的 `setting-change`）。
- 改轮播间隔后，下一次切换从改的那一刻起算一个新间隔。
- 当前壁纸那张图只是从当前视图消失（被隐藏、移出画册、被过滤掉）时，应用背景不再被清空；只有图片真的被删才清。
- 原生模式下没有当前壁纸时改样式，不再直接改系统的壁纸位置。
- Windows 原生模式一次轮播只设一次系统壁纸（原来样式、过渡、路径各触发一次）。
- 经 app IPC 设样式、过渡现在与 Tauri 命令是同一实现：按能力校验，并重新输出 / 演示。

macOS 原生模式改用逐屏接口带来的变化：

- 显示方式不再「跟随系统」：每次设图都带上目标的样式（默认填充），系统设置里手动选的铺法会被覆盖；留边固定为黑色。
- 当前壁纸是视频时切到原生模式、或在原生模式下启动，系统桌面图片保持原样（结果与以前相同，以前是系统不理会，现在是应用不交给系统）。
- 换壁纸不再启动 `osascript` 子进程，也不需要「自动化」授权（控制 System Events）。

每屏一窗带来的变化：

- macOS 窗口模式在多屏机器上从「只有主屏有壁纸」变成每块屏各有一份；视频、网页、场景壁纸每块屏各运行一份，资源占用随屏数增加。
- 壁纸窗口的地址多了 `&slot=<序号>`。

## 已知限制

- 屏断开后要等屏幕变化稳定（约 300 ms 去抖）才销毁它的窗口，接回后新窗口的页面要重新加载（实测约 0.3 s）。
- `multiple` 下各窗口的视频、场景动画、网页状态互不同步。
- 网页壁纸的 `localStorage` 各窗口共用同一分区（预览与桌面本来也共用），同一张网页壁纸在多块屏上同时写由页面自己负责。
- 样式、过渡只在目标第一次进入某个壁纸模式时沿用一次，之后两个模式各记各的：在窗口模式改了样式，原生模式下已有的样式不会跟着变。
- 目标选择弹窗打开时在线屏只剩一块，操作会直接落到剩下的那块屏，即使用户刚才选中的是断开的那块。
- 多块屏逐屏独立时「停止桌面轮播」没有逐屏的版本，关的是全局开关；要让某一块屏不再轮播某个画册，给它换一条轮播路径。
- 设置写盘有约 5 秒的去抖；这期间进程被强杀，刚做的显示器模式切换与目标改动会丢，重启后回到上一次落盘的状态。
- macOS 原生模式只改各屏**当前 Space** 的桌面图片；用了多个桌面（Space）时，别的桌面仍是原来的图。
- macOS 原生模式设一块屏要等系统 0.6 s 上下，多块屏逐块设，所以各屏复制下换图时各屏先后差一秒左右，不是同时变。
- macOS 原生模式没有平铺；过渡由系统决定，应用不能选。
- 原生模式下当前壁纸是视频的目标不输出：切到原生或在原生模式下重启后，那块屏留着上一张系统壁纸，直到给它设一张图片或轮播换到下一张。

## 加功能时看哪里

- **开放一种显示器模式**：在对应 manager 覆盖 `unavailable_reason`，实现 `set_wallpaper` 对该 `Placement` 的分支。设置页的选择器与布局图照能力表与显示器模式自己变，不用改。
- **给 Windows / Linux 的原生后端开放逐屏独立**：先有显示器枚举；`native.rs` 里非 macOS 的 `set_wallpaper` 实现 `Placement::One`（Windows 记得先过 `ensure_native_wallpaper_path` 取兼容副本），并覆盖 `unavailable_reason`。`on_screens_changed` 看到原生后端的 `single` 可用，就会给新接入的屏补输出：各屏复制下补的也是 `Placement::One`（目标是 `multiple`），后端要能只设一块屏。系统只有一个全局壁纸位置的平台把 `shared_style` 返回 `true`。
- **给 Windows 加每屏一窗**：先加显示器枚举（下一条）；`WallpaperWindow::mount` 的 Windows 分支按屏的矩形挂载（`tauri-plugin-wemt` 的挂载选项要能接受矩形），`align` 里屏矩形变化的分支补上重挂，`create_window` 里按屏给位置与大小时注意 Windows 的桌面坐标是物理像素；然后把窗口后端 `unavailable_reason` 里 `single` 的平台判断放开。窗口表、对齐、布置、就绪、ping、转发都是公共的。
- **加一个要按壁纸窗口 label 登记的东西**：对 `WALLPAPER_LABELS` 整池登记，判断用 `is_wallpaper_label`，不要写 `"wallpaper"` 字面量。
- **给一个平台加显示器枚举**：在 `screens/` 下加平台模块，提供「枚举一次」与「光标位置」两个函数，接进 `start_watcher` 与 `cursor_position`；有系统通知就用它 `unpark` watcher 线程，没有就只靠 2 s 轮询。输出要满足：`id` 是该平台逐屏壁纸 API 认的持久标识，坐标左上原点，`pixel_width` / `pixel_height` 是物理像素，列表过一遍 `sort_screens`。去抖、提交与事件是公共的。
- **给目标加字段**：改 `WallpaperTargetConfig`（含 `from_json` 的宽松解析）与前端同名类型；注意种子是整份复制，新字段会随之复制到新目标。
- **新增按目标读写的命令**：加可选 `target`，经 `resolve_target` 解析；需要对外时给 IPC 变体加 `#[serde(default)] target`。
- **新增读目标的前端入口**：用 `useWallpaperTarget` 系列，不要直接读 `settingsStore.values.wallpaperTargets[...]` 后自己算默认目标。
- **新增一个要落到某个目标的操作入口**（设置页以外）：先 `const target = await pickWallpaperTarget({ action })`，为 `null` 就返回，再带 `target` 调命令；成功提示用 `pickedScreenName(target)` 决定带不带屏名。关全局开关这类不属于某个目标的操作不弹。
- **新增轮播来源的标记**：用 `useWallpaperRotationSources()` 加 `rotatingTargetIds`，区分「有目标命中」与「全部命中」，不要只看 `useActiveWallpaperRotationPaths()`。
- **改活跃目标、默认目标或归一化规则**：后端 `compute_layout` / `pick_option` 与前端 `utils/wallpaperTargets.ts` 要同步改，两边各有单测。

## 涉及文件

- `src-tauri/kabegame-core/src/settings/wallpaper_targets.rs`：目标 id、`WallpaperTargetConfig`、按目标读写与显示器模式 / 默认屏的存取
- `src-tauri/kabegame-core/src/settings/mod.rs`、`settings/migrations/v005_wallpaper_targets.rs`：设置键与迁移
- `src-tauri/kabegame/src/wallpaper/manager/mod.rs`：`DisplayMode` / `Placement` / `Layout`、能力、控制器、manager trait
- `src-tauri/kabegame/src/wallpaper/manager/{native,window,plasma_plugin}.rs`：三个后端；`window.rs` 里是窗口表、`plan_windows` / `diff_windows` 与对齐
- `src-tauri/kabegame/src/wallpaper/manager/native_mac.rs`：macOS 逐屏设桌面图片、样式 → 选项的映射、能不能显示的判断
- `src-tauri/kabegame/src/wallpaper/mod.rs`：壁纸窗口 label 池 `WALLPAPER_LABELS`、`is_wallpaper_label`
- `src-tauri/kabegame/src/wallpaper/window.rs`、`window_mount_macos.rs`：单个壁纸窗口（按 label 的就绪握手、挂载、看门狗、鼠标转发）与 macOS 按屏铺放
- `src-tauri/kabegame/src/commands/window.rs`、`capabilities/main.json.handlebars`、`capabilities/wpe-web.json`、`wallpaper/wpe_scene_host.rs`：按 label 的就绪命令与各处窗口列表
- `src-tauri/kabegame/src/wallpaper/screens.rs`：`ScreenInfo`、缓存、watcher、去抖与提交；`screens/mac.rs`：macOS 枚举、坐标换算与按 id 查 `NSScreen`
- `src-tauri/kabegame/src/wallpaper/rotator.rs`：按目标选图与轮播线程
- `src-tauri/kabegame/src/commands/wallpaper.rs`、`commands/settings.rs`、`lib.rs`：命令
- `src-tauri/kabegame/src/ipc/handlers/settings.rs`、`kabegame-core/src/ipc/ipc.rs`：app IPC 变体
- `src-tauri/kabegame/src/startup.rs`、`tray.rs`：启动恢复、托盘
- `src-tauri/kabegame-i18n/locales/*.yml`：显示器模式名称与不可用原因
- `src-tauri/tauri-plugin-wallpaper/android/.../WallpaperRotationWorker.kt`
- `apps/kabegame/src/utils/wallpaperTargets.ts`、`composables/useWallpaperTarget.ts`、`composables/useWallpaperCapabilities.ts`
- `apps/kabegame/src/composables/useWallpaperScreens.ts`、`utils/wallpaperScreenLayout.ts`、`components/wallpaper/WallpaperScreenLayout.vue`
- `apps/kabegame/src/composables/useWallpaperTargetPicker.ts`、`components/wallpaper/WallpaperTargetPickerHost.vue`（挂在 `App.vue`）：目标选择弹窗
- `apps/kabegame/src/composables/useImageOperations.ts`、`utils/wallpaperMode.ts`、`views/Albums.vue`、`actions/albumActions.ts`、`components/albums/AlbumDetailPanel.vue`、`components/gallery/GalleryQueryBar.vue`、`components/gallery/savedViews/SavedViewsSection.vue`、`utils/wallpaperRotationPath.ts`：各入口与轮播来源标记
- `apps/kabegame/src/components/settings/items/WallpaperDisplayModeSetting.vue`、`components/common/form/KbSegmentedControl.vue`
- `apps/kabegame/src/stores/settings.ts`、`stores/settingsDescriptors.ts`、`stores/localSettingsMigrations.ts`
- `apps/kabegame/src/views/WallpaperWindow.vue`、`views/Settings.vue`、`components/settings/items/WallpaperStyleSetting.vue`、`WallpaperTransitionSetting.vue`
- 测试：`wallpaper_targets.rs`、`v005_wallpaper_targets.rs`、`manager/mod.rs`（布局、光标所在屏对应的目标、切壁纸模式沿用样式的规则、屏幕变化后给哪些屏补输出）、`manager/native_mac.rs`（样式 → 选项、能不能显示）、`manager/window.rs`（窗口表、比对、布置落在哪些窗口）、`wallpaper/mod.rs`（label 池、capability 文件与池一致）、`window_mount_macos.rs`（坐标翻转）、`rotator.rs`、`ipc.rs`、`screens.rs`（排序、光标命中、去抖）、`screens/mac.rs`（Y 翻转、主屏判定，另有读真机屏幕的用例：枚举、按 id 查回、光标换算）内的单测；前端 `utils/wallpaperTargets.test.ts`、`utils/wallpaperScreenLayout.test.ts`、`composables/useWallpaperTarget.test.ts`、`composables/useWallpaperScreens.test.ts`、`composables/useWallpaperTargetPicker.test.ts`（含宿主组件）、`utils/wallpaperMode.test.ts`、`utils/wallpaperRotationPath.test.ts`、`views/WallpaperWindow.target.test.ts`、`stores/localSettingsMigrations.test.ts`
