# Phase 3.4 — 窗口/Webview 方法补齐 + DPI/光标 + run_iteration

> 父:[phase3](cef-linux-runtime-phase3.md)。收尾性,可与 3.1–3.3 并行/穿插。
>
> **目标**:把 kabegame 主窗口实际用到的 `WindowDispatch` / `WebviewDispatch` 方法从 stub 补成可用,处理 DPI 缩放与窗口语义,使主窗口行为与换引擎前一致。

## 现状锚点
**a. webview 有 stub**(`src/webview.rs:226`)
```rust
fn unsupported<T>() -> Result<T> {                       // 现状:部分 webview 操作未实现
    Err(Error::CreateWebview(Box::new(std::io::Error::other(
        "operation is not implemented by the CEF runtime yet"))))
}
```
**b. `run_iteration` 仅轻量 pump/blit**(phase3 落地记录),主路径用 `run`/`run_return`。

## 点 1 — 窗口方法补齐(`window.rs`)
- **修改**:补 kabegame 用到的 setter/getter —— decorations / resizable / min-max size / always-on-top / 标题 / 可见性 / 居中 / `set_size` 时同步 OSR view(`view_rect` + `host.was_resized()`)。其余非必需保留 stub。

## 点 2 — Webview 方法补齐(`webview.rs`)
- **修改**:把 `unsupported()` 收敛到真正用不到的方法;补 kabegame 需要的:`set_size` / `set_position` / `set_focus` / `reload` / `print`(可选) / `bounds` 等;尺寸变化驱动 `was_resized`。

## 点 3 — DPI / 缩放 / 光标
- **修改**:窗口 `scale_factor` → CEF `screen_info.device_scale_factor`(已在 OSR handler 用到则统一来源);窗口移屏/缩放变化 → 重设并 `was_resized`。
- **修改**:`OnCursorChange` → tao 光标(与 3.2 点 3 合并去重)。

## 点 4 — `run_iteration` 对齐
- **修改**:`run_iteration` 与 `run`/`run_return` 共用同一帧逻辑(pump CEF + 派发 RunEvent + blit),避免行为分叉。

## 验收
- kabegame 主窗口:缩放/最小化/最大化/标题/(无边框若用)正常;高 DPI 下不糊不错位。
- 无"operation not implemented"在正常使用路径上触发。

## 风险
- 无边框 + 自定义标题栏 + 拖拽(kabegame 若用)在 OSR 下的命中区域。
- 多显示器 DPI 切换。
