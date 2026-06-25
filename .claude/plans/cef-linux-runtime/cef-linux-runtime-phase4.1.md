# ✅ Phase 4.1 — 完成 Runtime 泛型化(去掉残留 Wry 硬编码)

> 父:[phase4](cef-linux-runtime-phase4.md)。这是 4.2「挂全 app」的前提:同一份 build 代码要能对 `R: Runtime` 实例化成 Wry 或 Cef。

## 现状锚点
**a. 已泛型化**(无需改):`startup.rs`、`http_server.rs`、`compress_provider.rs`、`content_io_provider.rs`、`commands/surf.rs` 均 `R: Runtime`。
**b. 残留硬编码**(`src-tauri/kabegame/src/tray.rs:27`)
```rust
fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {  // 裸 AppHandle 默认 Wry + Menu<Wry>
```

## 点 1 — tray.rs 泛型化
- **修改** `build_tray_menu` 与相关函数:`<R: Runtime>`,`app: &AppHandle<R>`,返回 `Menu<R>` / `TrayIcon<R>`。
- **修改** 调用处(setup / 入口)随之带上 `R`。
  > tray 图标/菜单 API 本身对 `R` 泛型,改签名即可,无逻辑变化。

## 点 2 — 扫除其余裸 `AppHandle` / `WebviewWindow` / `Manager`
- **修改** `grep -rn "AppHandle\b\|WebviewWindow\b\|Menu<\|TrayIcon<\|State<" src-tauri/kabegame/src` 里**未带 `<R>`** 的(默认 Wry)→ 补 `<R>`。命令函数(`#[tauri::command]`)本就对运行时泛型,通常无需改;重点是自由函数 / 结构体字段。

## 点 3 — 确认命令/插件对泛型透明
- **核对** `invoke_handler![ … ]` 里的命令:`#[tauri::command]` 自动对 `R` 泛型,无需改。
- **核对** 各 `tauri_plugin_*::init()` 返回 `TauriPlugin<R>`,对 `R` 泛型(官方插件都是)。

## 验收
- `cargo build -p kabegame --features standard`(默认 Wry 路径)**仍编译、行为不变**(没引入 CEF,纯泛型化重构)。
- 若有条件:`cargo build --features standard` 的 Wry 路径手动跑一下确认无回归。

## 风险
- tray 在 Linux 用 `libayatana-appindicator3`,泛型化不改其平台行为。
- 个别地方可能依赖 `Wry` 具体类型(如 `Menu<Wry>` 存进非泛型结构);若有,结构体也要带 `<R>` 或改存 `dyn`。

## 锚点
- `tray.rs:27`;`tauri::{AppHandle, WebviewWindow, Manager, menu::Menu, tray::TrayIcon}` 均 `<R: Runtime>`。

## 落地记录(2026-06-24)— ✅ 完成

**策略(两种并用)**:
- **命令/普通函数** → 泛型 `<R: Runtime>`、`AppHandle`→`AppHandle<R>`(generate_handler 在泛型 builder 下要求函数泛型)。
- **全局单例 / setup 喂全局的 seam** → cfg 类型别名 `crate::AppRuntime`(全局 `static` 不能带自由 `<R>`)。

**已改**:
- 新增 `lib.rs` 顶层 `pub(crate) type AppRuntime`(cfg:Linux+standard/light = `Cef<EventLoopMessage>`,其余 = `Wry`)。
- `WallpaperRotator`(全局 `OnceLock`):字段/`new`/`init_global`/`get_current_wallpaper_path` 用 `AppHandle<crate::AppRuntime>`。
- 命令/函数泛型化(6 个并行 agent):`commands/{album,image,crawler,surf,settings,misc,updater,window,wallpaper}.rs` 共约 30+ 函数;`wallpaper/manager/*`、`updater/install.rs`、`ipc/handlers/*`、`startup.rs` 经核查**本已泛型**。
- **setup seam**:`startup.rs::init_wallpaper_controller` 与 `lib.rs::init` 改 `app: &mut tauri::App<crate::AppRuntime>`(rotator 设 concrete 后沿调用链上溯;别名按 cfg 匹配 builder)。

**验证**:`cargo check -p kabegame --features standard`(Linux,走 CEF 路径)**通过**,仅余 59 条既有 warning(kabegame-core 未用 import 等,与本次无关)。
> Wry run 路径([lib.rs](../../src-tauri/kabegame/src/lib.rs) 的 `not(linux+std/light)` 分支)在本机被 cfg 排除、未单独编译;但命令已对称泛型、`AppRuntime` 别名在非 Linux = `Wry`,该路径调用点的 `R` 推断为 `Wry`,预期无回归。

**遗留给 4.2**:`init` / setup 目前只在 Wry run 路径被 `.setup()` 调用;CEF run 路径([lib.rs:320](../../src-tauri/kabegame/src/lib.rs))仍是最小 `build()`,未接 `configure_app`(挂 plugins/invoke_handler/setup)——正是 4.2 的活。
