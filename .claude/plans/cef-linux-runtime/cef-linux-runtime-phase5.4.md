# Phase 5.4 — 剩余 dispatch 方法 + 边角

> 父:[phase5](cef-linux-runtime-phase5.md)。收尾性,清掉仅剩的 `unsupported()`。
>
> **目标**:把 `WebviewDispatch` 里仅剩的两个 stub 实到位(或确认 kabegame 不需要而显式记录),并补 `with_webview` 等边角。

## 现状锚点(`src/webview.rs`)
```rust
fn print(&self) -> Result<()> { unsupported() }                 // webview.rs:148
fn reparent(&self, _window_id: WindowId) -> Result<()> { unsupported() }  // webview.rs:202
```
(window.rs 已无 stub。)

## 点 1 — `print`
- **修改**:接 CEF `BrowserHost::print()`。kabegame 若不需要打印,则保留但在文档/错误信息标注"有意不支持",并确认前端不会调用到。

## 点 2 — `reparent`
- **判断**:OSR + tao 架构下 webview 与窗口一对一绑定,`reparent`(把 webview 移到另一窗口)语义在本后端是否需要。
  - 需要 → 实现:解绑原窗口帧缓冲/输入,绑定到目标 tao 窗口。
  - 不需要(kabegame 不用)→ 保留 `unsupported()` 但注明,并确保 Tauri 上层不依赖。

## 点 3 — `with_webview` / 原生句柄回调
- **核对**:`WebviewDispatch::with_webview`(暴露原生 webview 句柄给用户回调)在 CEF 下给什么(Browser 指针?)。kabegame/插件若不用可最小实现。

## 验收
- 正常使用路径下不再触发 "operation is not implemented by the CEF runtime yet"。
- 未实现项均有明确文档说明 + 上层不依赖的确认。

## 风险
- `reparent` 若真要支持,涉及帧缓冲/输入/RequestContext 的迁移,与 5.2 多窗口耦合。
