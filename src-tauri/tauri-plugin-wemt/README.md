# tauri-plugin-wemt

把 Tauri 2 窗口挂到 Windows 桌面图标层后方（Wallpaper Engine 式的桌面壁纸挂载）。

目标是 **Tauri 2.12.x**；插件本身不依赖 Wallpaper Engine，也不复用它的任何二进制。

## 状态

- 已完成：WE 2.8.0.42 的静态反编译 + 两轮运行时观测（见 `step3-callchain-report-20261025.md`）。
- 已完成：Rust 插件实现及 Kabegame Windows 窗口壁纸接入（宿主发现、挂载/解挂、样式与 DPI、状态模型、命令与权限文件）。
- 已完成：插件编译验证。
  - `cargo check --no-default-features` 通过（只编译平台层，无 Tauri 依赖，零警告）。
  - `cargo check`（含 Tauri 2.12.0 命令层）通过；本机 `tauri-build` 的 `.crate` 归档未缓存，验证时用 `[patch.crates-io]` 指向本地 registry 源码目录，验证后已移除。
- 未完成：Kabegame 应用级编译与新二进制的 CEF 真机验证、多显示器实测、Explorer 重启后自动重挂（需 `refresh` 手动触发）。应用级 `cargo check` 因本机正在运行的 CEF 占用运行时文件而在 `cef-dll-sys` 构建脚本处中断；本次插件检查通过。

## 构建

```bash
cargo check                     # 完整插件（需要 crates.io 拉取 tauri-build）
cargo check --no-default-features   # 仅平台层，离线可用
```

正常构建需要网络获取 `tauri-build`；若本机 registry 仅有解压源码而无 `.crate` 归档，可临时在 `Cargo.toml` 追加：

```toml
[patch.crates-io]
tauri-build = { path = "<你的 CARGO_HOME>/registry/src/<index>/tauri-build-2.7.3" }
```


## 行为依据（为什么这样实现）

运行时实测（3840×2160 @150%，Windows 11）：

```
Progman (explorer)
└─ WorkerW 0xE05D0   WS_CHILD|WS_VISIBLE，整屏物理像素，属性 WallpaperEngineParent=1
   └─ WPEDesktopDX11Window 0x25096C   WS_CHILD|WS_VISIBLE，ex NOACTIVATE|NOREDIRECTIONBITMAP|LAYERED
```

据此确定：

1. 优先找 `Progman` 直属的背景 `WorkerW`；尚未出现时向 `Progman` 发 `0x052C`（先用本机 WPE 分支的 `0xd,1`，再尝试 `0,0`），每种参数有界重试，`SendMessageTimeoutW` 超时 2.5s。
2. 宿主选择：`WorkerW`、无 `SHELLDLL_DefView` 子窗口、高度 > 0x100；保留旧桌面结构的枚举回退。
3. 挂载：清除标题/边框/最大化/最小化与 `WS_POPUP`，设置 `WS_CHILD` 和 `WS_EX_NOACTIVATE`，再 `SetParent(hwnd, host)`；通过 `MapWindowPoints` 将目标监视器坐标换成宿主客户区坐标后 `SetWindowPos`，并校验实际父窗口。
4. 解挂：`SetParent` 回原父窗口，恢复 style/exStyle/rect，必要时 `ShowWindow`。
5. 宿主校验：`IsWindow` + 属性标记 + 实际父窗口；失效即视为 `hostLost`，由 `refresh` 重新发现。

## 与 WE 的有意差异

| 项 | WE | 本插件 | 原因 |
|---|---|---|---|
| 宿主标记属性 | `WallpaperEngineParent` | `WemtHost` | 避免与已安装的 WE 互相误认所有权 |
| 内部 0x404 容器协议 | 用于临时容器/预览窗口 | 不实现 | 运行时证实桌面主窗口创建时即 parent=host，不需要该协议 |
| Unity 外部进程嵌入 | 有特殊分支 | 不支持 | 没有建立运行时证据 |
| 主壁纸窗口创建 | 创建时以 WorkerW 为 parent | Tauri/CEF 先创建窗口，再转成 WorkerW 子窗口 | 由 Tauri 管理窗口生命周期，最终桌面层级相同 |
| 宿主扩展样式 | 改写为 `0x080000A0` | 使用 Explorer 当前样式 | 避免在多程序共用的宿主上覆盖样式；需真机检验 |

## Rust API

```rust
use tauri::Manager;

tauri::Builder::default()
    .plugin(tauri_plugin_wemt::init())
    .run(tauri::generate_context!())
    .unwrap();

// 应用后端可对已有 WebviewWindow 调用同一状态管理路径：
// tauri_plugin_wemt::attach_window(&window, None)?;
// tauri_plugin_wemt::detach_window(&window)?;
```

命令（前端 `invoke("plugin:wemt|…")`）：

| 命令 | 说明 |
|---|---|
| `wemt_attach` | 挂载当前 webview 窗口；可选 `{ monitor }`、`{ showHost }` |
| `wemt_detach` | 恢复原父窗口、样式与位置 |
| `wemt_status` | 返回 `detached` / `attached` / `hostLost` / `failed` |
| `wemt_refresh` | 宿主失效后重新发现并重挂 |

返回结构见 `src/models.rs` 与 `guest-js/index.ts`（两者字段一一对应）。

## 权限

`permissions/default.toml` 默认放行四个命令；可改为只放行 `allow-status`：

```toml
[permissions]
"wemt:default" = []
```

（Tauri 2 的权限清单通常由 `tauri-build`/插件脚手架生成；本仓库为手写版本，联网后建议用官方脚手架重新生成并校验。）

## 前端

```ts
import { attach, detach, status } from "@tauri-plugin/wemt-api";

await attach({ showHost: true });
console.log(await status());
await detach();
```

## 已知限制

- 仅在单显示器、3840×2160 @150% 环境实测；多显示器与混合 DPI 未验证。
- 依赖 Explorer 的 `WorkerW`；Explorer 重启后需调用 `refresh`（尚无自动监听）。
- 3D/视频类内容需要应用自己渲染；插件只负责窗口层级与几何。
- 非 Windows 平台返回 `unsupported`。
- 没有 `build.rs`：离线环境下未接入 `tauri-build`，权限与 schema 未做构建期校验。
