# Linux 桌面环境自动检测（移除 `--desktop`）设计方案

## 背景与目标

当前 Linux 平台发布包按桌面环境拆分为 **Plasma** / **GNOME** 两套，其根本原因是后端壁纸实现通过编译期 `cfg(desktop="plasma|gnome")` 进行裁剪；前端也通过 `VITE_DESKTOP -> __DESKTOP__` 在编译期锁定 `IS_PLASMA/IS_GNOME`，导致同一个安装包无法在不同桌面环境下自适配。

本方案目标：

- **移除**开发/构建入口的 `--desktop` 选项（不再需要用户指定桌面环境）。
- **运行时自动检测**桌面环境（至少 Plasma / GNOME；其它桌面 Unknown）。
- **仅在程序启动时检测一次**并缓存；之后全程序只读取缓存结果，不再调用检测函数。
- 前端 UI 基于 **运行时检测结果**进行差异化展示（不再依赖编译期 `IS_PLASMA/IS_GNOME`）。
- 打包产物在 Linux 上不再按桌面环境拆分（同一个 deb 适配多桌面环境）。

非目标：

- 不强行支持所有 Linux 桌面环境的壁纸设置（Unknown 可回退到已有策略或报错）。
- 不在此文档中讨论“窗口模式壁纸”或 Windows/macOS/Android 的实现。

---

## 总体方案概览

### 后端（Rust / Tauri）

- 新增 `detect_linux_desktop()`：运行时检测桌面环境（读取环境变量 + 能力探测兜底）。
- 新增全局缓存：使用 `OnceLock` 保存检测结果。
- 启动时（Tauri `.setup()`）调用 `init_linux_desktop()` 执行一次检测并写缓存。
- 业务代码只调用 `linux_desktop()` 读取缓存结果。
- 壁纸原生实现从“编译期二选一”调整为“**运行时选择 + 失败回退**”：
  - Plasma：`qdbus/qdbus6` + `org.kde.plasmashell evaluateScript`
  - GNOME：`gsettings org.gnome.desktop.background ...`
  - 运行时选择，如果选择的实现失败则尝试另一套实现（防止环境变量不准/依赖缺失）。

### 前端（Vue）

- 新增后端命令 `get_linux_desktop_env`（或同名/同义命令），返回后端缓存结果（字符串：`plasma|gnome|unknown`）。
- 前端启动时调用一次该命令，将结果缓存到 store（例如 `settingsStore` 或新建 `runtimeStore`）。
- UI 中依赖桌面环境差异的地方，改为读取“运行时桌面环境”而非编译期 `IS_PLASMA/IS_GNOME`。

### 构建/发布（scripts）

- 删除 `--desktop` 参数及 `DesktopPlugin` 的强制逻辑。
- 不再注入 Rust `--cfg desktop="plasma|gnome"`；也不再设置 `VITE_DESKTOP`。
- Linux release 产物命名不再包含 `_plasma/_gnome`。

---

## 后端详细设计

### 1) 数据结构与缓存 API

新增一个模块（建议路径）：`src-tauri/app-main/src/desktop_env.rs`

建议公共 API：

- `pub fn init_linux_desktop()`：仅在启动阶段调用一次，检测并写入缓存
- `pub fn linux_desktop() -> LinuxDesktop`：业务代码读取缓存结果
- `fn detect_linux_desktop() -> LinuxDesktop`：仅供 `init_linux_desktop` 使用（禁止业务直接调用）

推荐枚举：

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxDesktop {
  Plasma,
  Gnome,
  Unknown,
}
```

缓存容器：

```rust
static LINUX_DESKTOP: OnceLock<LinuxDesktop> = OnceLock::new();
```

### 2) 检测算法（detect_linux_desktop）

检测只运行一次，优先级建议如下（从高到低）：

1. **环境变量识别（优先）**
   - 读取：`XDG_CURRENT_DESKTOP`、`XDG_SESSION_DESKTOP`、`DESKTOP_SESSION`
   - 常见值：
     - Plasma/KDE：`KDE`, `plasma`, `KDE;Plasma`
     - GNOME/Ubuntu：`GNOME`, `ubuntu:GNOME`, `GNOME-Flashback`
   - 额外辅助：`KDE_FULL_SESSION`、`KDE_SESSION_VERSION`（存在即可认为更偏向 KDE/Plasma）

2. **能力探测兜底**
   - GNOME：`gsettings get org.gnome.desktop.background picture-options` 成功
   - Plasma：存在 `qdbus6` 或 `qdbus`（更严格可再试探 `org.kde.plasmashell` 调用）

3. **未知**
   - 以上均无法判断则返回 `Unknown`

重要原则：

- **不依赖前端**：检测只在后端完成。
- **失败回退**留在壁纸执行层：检测有误时，执行壁纸命令仍可能成功（见下节）。

### 3) 启动时调用位置（只调用一次）

在 Tauri 启动入口 `.setup(|app| { ... })` 中加入一次性初始化，建议位置：

- `init_globals()` 成功之后
- `init_wallpaper_controller(app)` 之前

原因：壁纸控制器后续会触发原生壁纸路径/样式的读写，需要先准备好桌面环境缓存。

### 4) 壁纸 Native 实现从“编译期开关”迁移到“运行时选择”

现状（需要迁移的典型结构）：

- `NativeWallpaperManager::set_wallpaper_path` 在 Linux 下通过 `#[cfg(all(target_os="linux", desktop="plasma|gnome"))]` 分叉。
- `NativeWallpaperManager::get_style` / `set_style` 使用 `#[cfg(desktop="plasma")]` / `#[cfg(desktop="gnome")]`。

迁移后原则：

- 仅保留 `#[cfg(target_os = "linux")]`，确保 **Plasma + GNOME 两套代码都编译进同一个二进制**。
- 在 Linux 分支里：
  - `match linux_desktop()` 选择实现
  - 对选择的实现进行执行，失败则尝试另一套实现（回退一次即可）

推荐回退策略（示例）：

- 检测为 Plasma：
  1) `set_wallpaper_plasma(...)`
  2) 若失败 -> `set_wallpaper_gnome(...)`
- 检测为 GNOME：
  1) `set_wallpaper_gnome(...)`
  2) 若失败 -> `set_wallpaper_plasma(...)`
- 检测 Unknown：
  1) 先尝试 GNOME（`gsettings` 在多数发行版更常见）
  2) 再尝试 Plasma

注意：回退策略应该只在“执行层”做，不要在 `detect_linux_desktop()` 中做复杂执行，以保持检测函数轻量、可预测。

---

## 前端详细设计

### 1) 新增后端命令：读取缓存桌面环境

新增一个 Tauri command（命名建议：`get_linux_desktop_env`）：

- 返回：`"plasma" | "gnome" | "unknown"`
- 注意：该命令 **只读取缓存**（即调用 `linux_desktop()`），绝不触发重新检测

### 2) 前端启动时调用一次并缓存

新增一个 store 字段（建议）：

- `runtimeDesktopEnv: "plasma" | "gnome" | "unknown"`
- 默认值：`"unknown"`

启动时机建议：

- 应用初始化（例如根组件 mount 后或 settings 初始化流程中）调用一次 `invoke("get_linux_desktop_env")`，写入 store。

### 3) 替换 UI 里的编译期判断

现状示例：

- `packages/core/src/env.ts` 通过 `__DESKTOP__` 计算 `IS_PLASMA/IS_GNOME`
- `WallpaperStyleSetting.vue` 在 Linux 下使用 `IS_PLASMA` 限制样式选项

迁移后：

- 前端不再依赖 `IS_PLASMA/IS_GNOME`（这些常量要么删除、要么只用于旧逻辑兼容期）。
- 需要差异化展示的地方改为读 store 的 `runtimeDesktopEnv`：
  - 若为 Plasma：显示 Plasma 支持的样式集合
  - 若为 GNOME：显示 GNOME 支持的样式集合
  - Unknown：显示全量（或保守集合），并在用户选择不支持项时由后端回退/报错

---

## 构建与发布改造点

### 1) 移除 `--desktop` CLI 参数

需要调整：

- `scripts/run.ts`：删除 `--desktop` option（dev/start/build/check）
- `scripts/build-system.ts`：移除 `this.use(new DesktopPlugin())`
- `scripts/plugins/desktop-plugin.ts`：删除或不再参与 build 流程

### 2) 移除对 `VITE_DESKTOP` 和 Rust `--cfg desktop="..."` 的注入

当前 `DesktopPlugin` 做了两件事（都要移除）：

- `VITE_DESKTOP`：导致前端编译期常量 `__DESKTOP__` 固化
- Rust flags：`--cfg desktop="plasma|gnome"`：导致后端编译期裁剪

迁移后，前端桌面环境来自后端命令，后端桌面环境来自运行时检测。

### 3) Linux release 产物命名合并

当前 Linux asset 命名包含 desktop：

- `Kabegame-${mode}_${desktop}_${version}_${arch}.deb`

迁移后建议：

- `Kabegame-${mode}_${version}_${arch}.deb`

同时 README 下载表格应合并 Plasma/GNOME 两行（只保留 Linux 一行）。

---

## 兼容性与风险

- **环境变量不准**：通过执行层“失败回退”缓解。
- **依赖缺失**：
  - Plasma 可能缺 `qdbus/qdbus6`
  - GNOME 可能缺 `gsettings`（极少见，但在极简系统可能存在）
  - 通过回退与清晰错误提示缓解。
- **UI 与能力不一致**：
  - Unknown 时 UI 展示全量可能导致用户选到不支持项
  - 可通过：Unknown 时提示“桌面环境未知，某些选项可能无效”，或只展示保守集合。

---

## 验收标准（建议）

- Linux 上不需要 `--desktop` 即可启动（dev/start/build）。
- 同一个 `.deb`：
  - 在 KDE Plasma session 能成功设置壁纸（使用 qdbus 路径）
  - 在 GNOME session 能成功设置壁纸（使用 gsettings 路径）
- 程序日志显示桌面环境检测仅发生一次（可打印一条启动日志用于验证）。
- 前端壁纸样式下拉选项能随运行时桌面环境变化（Plasma/GNOME 不同集合）。

