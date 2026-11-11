# 多显示器壁纸 —— 总计划

> 本目录取代 `.claude/plans/wallpaper-multi-monitor.md`（7 月，Windows 调研）与
> `.claude/plans/wallpaper-multiscreen-manager.md`（7 月，「多屏开关 + 每屏独立 + 级联」模型）。
> 两份旧计划里的平台 API 调研仍然有效，在各分文档里按需引用；它们的设置模型与级联规则作废。
>
> 开发环境：macOS + DeskPad（虚拟显示器）。Linux 的 Plasma 插件模式即将下线，本计划不考虑；
> 以后 Linux 若用 Chromium 离屏渲染实现窗口模式，按本计划的「目标 → 每屏输出」模型接入即可。

| 文件 | 内容 |
|---|---|
| [README.md](README.md) | 总体设计、窗口方案（每屏一窗，暂不支持 span）、能力矩阵、分期、已定事项 |
| [01-screens-and-targets.md](01-screens-and-targets.md) | 显示器枚举与热插拔、目标 id、设置模型与 v005 迁移 |
| [02-backend.md](02-backend.md) | 控制器、manager trait、轮播（一个节拍切所有目标）、托盘按光标所在屏、命令与 IPC |
| [03-window-mode.md](03-window-mode.md) | 窗口模式：每屏一窗（multiple / single）、就绪 / ping / 鼠标转发 / 音频 |
| [04-native-mode.md](04-native-mode.md) | 原生模式：逐屏设置、系统自带的 span（Windows / GNOME）、各平台 |
| [05-frontend.md](05-frontend.md) | 设置页（布局图、目标选择）、目标选择弹窗、其它入口的目标化 |
| [06-verification.md](06-verification.md) | 真机验证（DeskPad / Windows 多屏）、文档 / 回归 / changelog |
| [90-window-span-deferred.md](90-window-span-deferred.md) | **暂缓**：窗口模式 span 的多窗口切片设计（留档） |

---

## 进度（2026-11-11）

实现以代码与 `cocs/wallpaper/MULTI_SCREEN.md` 为准；本计划里与实现不同的小处见各期回归文档（`versions/latest/regression.md` 的 P1–P4 各节）。

| 期 | macOS | Windows | Linux / 其它 |
|---|---|---|---|
| P1 目标化骨架 | 完成，真机回归通过 | 代码同一份，**未编译、未验** | 同左（Linux / Android 未编译） |
| P2 显示器枚举 + 布局图 | 完成 | **枚举未写**（屏列表为空，设置页没有布局图） | 未写 |
| P3 窗口模式每屏一窗、选屏弹窗、托盘按光标 | 完成 | **未做**：仍是一个窗口铺主屏，`single` 置灰；要做 wemt `AttachOptions.rect` 与多窗口挂载 | 无窗口模式 |
| P4 原生逐屏 | 完成（`NSWorkspace` 逐屏，样式 fill / fit / stretch / center） | **未做**：`IDesktopWallpaper` STA 线程 | Plasma 逐 containment 未做 |
| P5 原生 span | 不适用（系统没有跨屏铺放） | **未做**：位置「跨区」 | GNOME `spanned` 未做 |
| P6 Linux 补齐 | — | — | 未做 |

实现中改定、与下文不同的几处：
- 切壁纸模式的样式 / 过渡：只在新模式名下没有值时才带过去（已定事项 7）。
- 窗口后端的 `reconcile()` 不带参数，布局在它自己的锁内现算；壁纸窗口地址带 `&slot=<n>`。
- `ScreenInfo` 多了 `pixelWidth` / `pixelHeight`；`wallpaper-screens-change` 的载荷是 `{ screens }`。
- macOS 设图在阻塞线程上调用（系统调用一次约 0.6 s），不在主线程；视频 / 目录在原生后端被跳过。
- CLI 没有壁纸子命令、MCP 没有壁纸工具，02 点 5 里给它们加 `--target` 的一条作废。

在 Windows 机器上接手时的顺序：先 `deno task check -c kabegame` 把 P1–P4 里动过的 `cfg(windows)` 代码编译过（清单在回归文档与各期报告里：`native.rs` 的样式 / 过渡改由参数带入、`manager/window.rs` 重写、`wallpaper/window.rs` 的 `mount(screen)`、`commands/window.rs`），跑 P1 回归里标了 Windows 的 case，再依次做 P2（`screens/win.rs`）→ P3（wemt 按矩形挂载）→ P4（STA 线程）→ P5（位置 22）。

---

## 总体设计思路

新增一个全局的**显示器模式** `wallpaperDisplayMode`，三个值：

- **`multiple`（各屏复制）**：所有显示器显示同一张壁纸，**一个目标**，id 为 `multiple`。现在的行为就是它（原生模式本来就是「所有显示器」；窗口模式现在只挂主屏，迁移后变成每屏一份）。
- **`span`（跨屏拼接）**：把所有显示器的布局并成一个矩形容器（并集外接矩形），当成一整个显示目标。**一个目标**，id 为 `span`。**当前只在系统自带跨屏铺放的地方提供**：Windows 原生（壁纸位置「跨区」）与 GNOME（`spanned`），铺放方式由系统决定，没有样式可选。窗口模式、macOS、Plasma 不支持，选项置灰并给原因。
- **`single`（逐屏独立）**：每个显示器一个目标，id 为 `screen:<平台持久标识>`；另有一个**默认显示器** `wallpaperDefaultScreen`，是目标选择弹窗的预选项，也是不弹窗的入口（应用背景、CLI / MCP 不带目标时）落到的地方。

**目标（target）是设置的单位**：轮播路径与位置、样式、过渡、当前壁纸挂在目标上，存在一个设置键 `wallpaperTargets: { [targetId]: TargetConfig }` 里；原来的 7 个扁平键（`wallpaperRotationPath` / `Position`、`wallpaperStyle`、`wallpaperRotationTransition`、两个 `ByMode`、`currentWallpaperImageId`）由迁移 v005 并入 `wallpaperTargets.multiple` 后删除。**轮播开关与间隔是全局的**（键不变）：一开全开，到点时每个活跃目标按自己的路径各切一张。壁纸模式（原生 / 窗口）、打开壁纸、音量、倍速、暂停、WPE 相关设置也仍是全局的。`span` 与 `multiple` 的目标不随显示器增减变化；`single` 的目标按屏幕持久标识记账，断开的屏幕配置保留（休眠），重新接上就恢复。切显示器模式时各模式的目标各自保留，新模式缺的目标从旧模式的默认目标复制一份，用户不会看到空白屏。

**能力按「平台 × 壁纸模式 × 显示器模式」三维给出**，后端是唯一来源：哪些显示器模式可选（不可选时带原因）、该组合下有哪些样式与过渡、样式是不是全屏共用（Windows 原生只有一个全局 position）、能不能显示 WPE 网页 / 场景。前端只照着禁用，core 里那两份按平台写死的 `normalize_style_for_mode` / `normalize_transition_for_mode` 删掉，归一化改由控制器按能力做。

**窗口方案：每屏一窗，窗口模式暂不支持 span。** 窗口模式下每块在线屏一个壁纸窗口，窗口矩形就是那块屏，用本屏自己的 DPI 与刷新率，完整渲染一幅画面；`multiple` 时各窗口显示同一个目标，`single` 时各显示自己那块屏的目标。`WallpaperStage` 与场景宿主不改。窗口模式做 span 需要多窗口切片（每个窗口只露出并集画面的一块）并让视频、场景跨窗口对齐，暂缓，设计留在 [90-window-span-deferred.md](90-window-span-deferred.md)。multiple 下同一个视频各窗口各播一份，只有主屏窗口出声，播放位置不对齐。

**原生模式的 span 只用系统自带的跨屏铺放，不生成派生图片**：Windows 把壁纸位置写成「跨区」（`WallpaperStyle = 22`），GNOME 写 `picture-options=spanned`，图片仍是原文件，其余走现有的「所有显示器」路径。把图片裁成每屏一张再逐屏设置的做法（静态拼接）不做，所以 macOS 与 Plasma 没有 span。

**选目标的交互统一成一个弹窗**：设置页里目标由布局图选；设置页以外凡是要落到某个目标的操作（设为壁纸、设为轮播画册、用当前视图轮播）先弹同一个目标选择弹窗，里面是和设置页共用的显示器布局组件。只有一个活跃目标时不弹。**托盘「下一张」**不弹窗，只切鼠标所在那块屏的目标。

**数据流**：显示器枚举（自建，见 01）→ 控制器算出「当前显示器模式的活跃目标」与「每个目标覆盖哪些屏」（`Placement`）→ 轮播器到点时对每个活跃目标选图、写回该目标的位置与当前壁纸 → manager 按 `Placement` 输出（原生逐屏 API / 窗口 reconcile）。窗口模式下壁纸窗口仍是自驱动的观察方：后端只给每个窗口一条布置（显示哪个目标、出不出声），窗口自己从 `setting-change` 里读该目标的样式、过渡与当前壁纸。

关键决策与理由：
1. **一个 `wallpaperTargets` 键而不是每个扁平键各变成 map**：目标的字段总是一起被调度器读写（选图后同时写位置与当前壁纸），一个键一次事件，原子；`ByMode` 两个键也随之消失（样式按壁纸模式存在目标里）。
2. **已有命令加可选 `target` 参数，不开平行命令**：`set_wallpaper_rotation_path(path, target?)` 等，缺省为默认目标；CLI 的 IPC 变体同样加可选字段。新增的只有显示器模式 / 默认屏 / 列屏幕 / 忘记目标四个必要入口。轮播开关与间隔的命令不变。
3. **显示器枚举不用 Tauri 的 monitor API**：kbcef runtime 的 `available_monitors()` 是启动时一次性快照（`tauri-runtime-kbcef/src/runtime.rs:2217`），`name` 恒为 `None`，不随热插拔更新，也没有持久标识；必须自建，且原生逐屏 API 要的就是平台持久标识（Windows 的 monitor device path、macOS 的 display UUID）。
4. **壁纸窗口 label 用固定池**（`wallpaper`、`wallpaper-1` … `wallpaper-7`）：ACL 特赦 `acl_exempt_webview` 在 Builder 期登记，用固定池不必改 tauri 补丁 17；超过 8 块屏只给前 8 块开窗口并告警。

---

## 能力矩阵

✅ 支持　❌ 禁用（UI 置灰并给原因）　⏳ 后续阶段　`共用` = 样式对该模式下所有目标只有一个值

### 显示器模式可用性

| 平台 · 壁纸模式 | multiple | span | single |
|---|:---:|:---:|:---:|
| Windows · 窗口 | ✅ 每屏一窗 | ❌ 暂不支持（见 90） | ✅ 每屏一窗 |
| macOS · 窗口 | ✅ 每屏一窗 | ❌ 暂不支持（见 90） | ✅ 每屏一窗 |
| Windows · 原生 | ✅ `SetWallpaper(NULL)` | ✅ 系统位置「跨区」 | ✅ `IDesktopWallpaper` 逐屏 |
| macOS · 原生 | ✅ | ❌ 系统没有跨屏铺放 | ✅ `NSWorkspace` 逐屏 |
| Linux · 原生 GNOME | ✅ | ✅ `picture-options=spanned` | ❌ GNOME 只有一个壁纸 |
| Linux · 原生 Plasma | ✅ | ❌ 系统没有跨屏铺放 | ⏳ 逐 containment（P6） |
| Linux · plasma-plugin | ✅（只此一项，不显示选择器） | ❌ | ❌ |
| Android | 不显示选择器，固定 multiple | — | — |

macOS 上 span 在两种壁纸模式下都不可用，选项始终置灰。只接一块屏时三种模式等价，选择器照常显示但附说明；布局图只画一块。切壁纸模式时若当前显示器模式在新模式下不可用（如 Windows 原生 span → 窗口），自动回落 `multiple`。

### 样式与过渡

| 平台 · 壁纸模式 · 显示器模式 | 样式 | 过渡 |
|---|---|---|
| 窗口 · multiple / single | fill fit stretch center tile | none fade slide zoom |
| Windows 原生 · multiple | fill fit stretch center tile | 跟随系统 / fade（现状） |
| Windows 原生 · single | 五种，**共用**（系统只有全局 position） | 跟随系统（逐屏 COM 总是系统淡入，`none` 做不到） |
| Windows 原生 · span | 只有 fill（系统铺放，只读） | 跟随系统 / fade（同 multiple） |
| macOS 原生 · multiple / single | fill fit stretch center（`NSWorkspace` 选项，逐屏） | 跟随系统 |
| GNOME · multiple | 五种 | 跟随系统 |
| GNOME · span | 只有 fill（系统铺放，只读） | 跟随系统 |
| Plasma · multiple | fill fit center tile（现状） | 跟随系统 |

### 媒体类型

视频 / WPE 仍只在窗口模式可用（现状），multiple / single 下每块屏各渲染一份，互不同步。原生模式（含 span）只有静态图片。

---

## 分期

每期都能单独合入、单独回归。

| 期 | 内容 | 用户可见变化 |
|---|---|---|
| **P1 目标化骨架** | 设置 v005、`wallpaperTargets`、控制器 `Placement`、轮播到点切所有活跃目标、命令加 `target`、能力三维化（暂时所有组合只开 `multiple`）、前端改读目标 | 无（零回归） |
| **P2 显示器枚举 + 设置页** | 自建枚举与热插拔（macOS 先，DeskPad 开发；再 Windows）、`list_wallpaper_screens`、布局组件 `WallpaperScreenLayout`、显示器模式选择器（只读展示能力）、设置页分层（轮播开关与间隔上移到全局层） | 设置页出现布局图 |
| **P3 窗口模式 multiple / single** | 窗口池、每屏一窗（wemt `AttachOptions.rect`、macOS 按屏 frame）、assignment、逐 label 就绪 / ping / 转发、音频只主屏出声；目标选择弹窗接进「设为壁纸」「设为轮播」；托盘「下一张」按光标所在屏 | macOS / Windows 窗口模式可选 single；multiple 铺到每块屏；多屏 single 下设壁纸 / 轮播先选屏 |
| **P4 原生 single** | Windows `IDesktopWallpaper` 逐屏（STA 线程）；macOS `NSWorkspace` 逐屏（替换 osascript，顺带支持 fit / stretch / center） | 原生模式可选 single |
| **P5 原生 span** | Windows 位置「跨区」、GNOME `spanned`（各加一行位置映射 + 能力；很小，可与 P4 一起合入） | Windows / GNOME 原生模式可选 span |
| **P6 Linux 补齐** | GNOME / Plasma 显示器枚举（布局图用）、Plasma 逐 containment | Linux 布局图画出真实排布；Plasma single |

开发顺序建议 P1 → P2(mac) → P3(mac) → P4(mac)，再在 Windows 上把 P2–P4 的 Windows 部分与 P5 补齐，最后 P6（macOS 没有 span，P5 只能在 Windows / GNOME 上做）。窗口模式的 span 不在分期内（[90-window-span-deferred.md](90-window-span-deferred.md)）。

---

## 已定事项

1. **窗口方案**：每屏一窗；窗口模式暂不支持 span。
2. **原生 span**：只用系统自带的跨屏铺放（Windows、GNOME），不生成派生图片；macOS、Plasma 不提供。
3. **轮播**：开关全局，一开全开；每个目标各有自己的轮播路径与位置。
4. **选目标**：设置页以外的「设为壁纸」「设为轮播」统一弹目标选择弹窗（与设置页共用布局组件），只有一个活跃目标时不弹。
5. **托盘「下一张」**：只切鼠标所在那块屏的目标。
6. **默认显示器模式**：迁移后与全新安装第一次打开都是 `multiple`（窗口模式在多屏机器上从「只有主屏」变成「每屏一份」）。
7. **切壁纸模式时的样式 / 过渡**：各壁纸模式各记各的；只有新模式名下还没有值时才把当前值带过去，已有值一律不动（所有目标同理，含不活跃的逐屏目标）。旧版「当前值能用就覆盖过去」的规则作废。

## 按推断处理、可改的地方

1. **轮播间隔**也按全局处理（和开关一起，一个节拍）。若要每屏不同间隔，调度要改回每目标一个到期时间。
2. **手动切一个目标会重置全局计时**（沿用现状「手动切换后从现在起算」），其它屏的下一次自动切换顺延至多一个间隔。
3. **Windows 托盘图标默认只在主任务栏**，从那里点「下一张」鼠标一定在主屏，所以默认配置下它只会切主屏；副屏要靠任务栏设置里「在所有显示器上显示任务栏」。macOS 每块屏都有菜单栏，不受影响。
4. **目标选择弹窗不带「记住选择」**，每次都选；默认屏只作预选。
5. **声音**：窗口模式 multiple 下只让主屏窗口出声；single 各屏各自出声（都乘全局音量）。
6. **布局图坐标**取平台桌面坐标（Windows 物理像素、macOS 点），混合 DPI 时与系统显示设置里的排布一致。
7. **断开的屏**：配置保留，设置页列出「已断开」并提供「忘记」；不自动清理。

---

## 现状锚点（总览，细节见各分文档）

**a. 控制器只按壁纸模式选后端，没有屏幕维度**（`src-tauri/kabegame/src/wallpaper/manager/mod.rs`）
```rust
pub async fn active_manager(&self) -> Result<Arc<dyn WallpaperManager + Send + Sync>, String> {
    let mode = Settings::global().get_wallpaper_mode();   // 现状：只有 native / window / plasma-plugin
    Ok(match mode.as_str() {
        "window" => self.window.clone(),
        _ => self.native.clone(),
    })
}
```

**b. 能力只有 mode → styles / transitions**（同文件）
```rust
pub struct WallpaperCapabilities {
    pub modes: Vec<WallpaperOption>,
    pub styles: HashMap<String, Vec<WallpaperOption>>,      // 现状：没有显示器模式维度
    pub transitions: HashMap<String, Vec<WallpaperOption>>,
}
```

**c. 轮播与当前壁纸全是扁平单值**（`src-tauri/kabegame-core/src/settings/mod.rs`）
```rust
WallpaperRotationEnabled, WallpaperRotationPath, WallpaperRotationPosition,
WallpaperRotationIntervalMinutes, WallpaperStyle, WallpaperRotationTransition,
WallpaperStyleByMode, WallpaperTransitionByMode, // 现状：按壁纸模式交换的缓存
CurrentWallpaperImageId,                         // 现状：全局唯一当前壁纸
```

**d. 窗口模式只有一个窗口，label 写死**（`src-tauri/kabegame/src/wallpaper/manager/window.rs`）
```rust
pub const WALLPAPER_LABEL: &str = "wallpaper";   // 现状：唯一壁纸窗口
// create_window(): .fullscreen(true) —— 铺满所在屏（主屏）
```

**e. Tauri 显示器列表是启动快照**（`src-tauri/tauri-runtime-kbcef/src/runtime.rs:2217`）
```rust
let monitors = cef_monitor_snapshot().unwrap_or_else(|| tao_monitor_snapshot(&event_loop));
// 现状：之后不再刷新；monitor_from_cef_display() 里 name: None
```
