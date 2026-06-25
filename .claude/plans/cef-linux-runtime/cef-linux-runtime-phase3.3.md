# Phase 3.3 — 端到端跑起来 + 验证

> 父:[phase3](cef-linux-runtime-phase3.md)。
>
> **目标**:在 Linux 真正 `bun dev -c kabegame` 用 CEF 启动并看到 kabegame 前端;确认其余平台不受影响。把"能编译"推进到"能运行 + 截图"。

## 现状锚点
**a. crate 自身可检查**:`cargo check -p tauri-runtime-cef --features cef-backend` 通过。
**b. kabegame 检查被 FFmpeg build script 卡**(phase3 落地记录):
```text
cargo check -p kabegame --features standard  →  rusty_ffmpeg build script 失败
缺:FFMPEG_PKG_CONFIG_PATH / FFMPEG_LIBS_DIR / FFMPEG_LINK_MODE
```
这些由 bun 构建插件注入;直接 cargo 需同等环境。

## 点 1 — 解决构建环境
- **任务**:走 `bun dev -c kabegame`(构建插件会设 FFmpeg 环境 + CEF_PATH/LD_LIBRARY_PATH);或手动 export(值参照 `scripts/run.ts` 的 ffmpeg 配置)。
  > 注意:CEF 运行还需 `CEF_PATH` + `LD_LIBRARY_PATH` 指到 libcef;确认构建插件对 Linux CEF 后端也注入(否则补)。

## 点 2 — 实际启动 + 观测
- **任务**:Linux 启动 kabegame(CEF 后端),截图确认前端 first paint;记录:子进程数、`do_message_loop_work` 驱动是否稳、有无崩溃/白屏、devUrl vs production。
- **诊断**:沿用 §DEBUG_INGEST 或日志;窗口标题/类名定位 + `import` 截图(tao X11 窗口可截,见 minimal 经验)。

## 点 3 — 平台门控回归
- **任务**:确认 `cargo check`/构建在 **Android / Windows / macOS** 路径**不编译** `tauri-runtime-cef`(target-cfg 依赖 + 入口 cfg 分流),行为与改造前一致。

## 验收
- `bun dev -c kabegame`(Linux)用 CEF 渲染出 kabegame 前端(交互依赖 3.2,IPC 依赖 Phase 4)。
- 其余平台 check/构建通过且未触达 CEF。

## 风险
- FFmpeg/CEF 两套 native 依赖的环境变量与 `bun` 插件耦合;Linux CEF 后端可能需要给构建插件补 CEF 库路径注入。
- dev devUrl 可跑但 production 前端需 3.1 的 scheme handler。

## 落地记录(2026-06-24)

### 现状:已能启动并正确渲染 ✅
- 构建环境(点1)**已由 `scripts/plugins/mode-plugin.ts` 解决**:Linux standard/light 自动注入 `CEF_PATH` + `LD_LIBRARY_PATH` 并校验 `libcef.so`。直接 cargo 时手动设 `FFMPEG_PKG_CONFIG_PATH=third/FFmpeg-build/install/lib/pkgconfig` + `CEF_PATH` + `LD_LIBRARY_PATH` 即可 `cargo build -p kabegame --features standard`。
- 入口门控(点3)**已落地**:`main.rs` 最早调用 `execute_cef_subprocess_and_exit()`(Linux+standard/light),并跳过单例转发;`lib.rs` 有独立的 Linux CEF `run()`(`Builder::<Cef<EventLoopMessage>>`)。
- **验证**:`target/debug/kabegame`(带 CEF env)直接启动,正确渲染 `https://example.com`(HTTPS+证书验证+OSR blit 全通)、`about:blank` 稳定存活,不再闪退。

### 🔴 关键排障:启动即 SIGSEGV(window 闪现即退)
现象:`bun dev` 窗口闪现立即关闭;直接跑二进制 SIGSEGV,日志停在 `[cef-runtime] first OSR frame`。

排查路径(逐一排除):
1. 删 `--single-process` —— 是真 bug(Chromium 单进程已弃用、`V8 Proxy resolver` 报错),**已删**,但删后仍崩。
2. `CEF_NO_BLIT` 跳过 softbuffer → 仍崩(非 blit)。
3. `CEF_NO_PAINT` 跳过 on_paint 拷贝 + 打印线程 → on_paint 在主线程(排除跨线程 Rc race),仍崩。
4. gdb 活体抓栈失败(被损坏的堆拖挂);改用 **core dump + `eu-stack`** 拿到真实栈。
5. 栈定位:`NSS cert verify → NSS_InitReadWrite → SECMOD_LoadModule → 系统 libsqlite3 → 调空指针`。
6. 对照:`cefsimple`/`osr` 例子加载 HTTPS **不崩**(它们不链接 sqlite);`about:blank` 也崩(证书验证启动即跑,与页面无关)。
7. **根因**:`nm -D target/debug/kabegame | grep sqlite3_` = **51 个导出符号**(rusqlite 内置 SQLite **3.45.0**)。主可执行符号全局优先 → NSS softokn 的 `sqlite3_*` 绑到 kabegame 的 3.45.0 而非系统 **3.46.1** → VFS/结构不匹配 → 空指针。

### ✅ 修复(已生效)
`src-tauri/kabegame/build.rs`:Linux + standard/light 写一个 linker version script 把 `sqlite3_*` 本地化:
```
{ local: sqlite3_*; };   // 经 -Wl,--version-script 注入
```
效果:导出 `sqlite3_` 由 51 → 0;softokn 改绑系统 libsqlite3;kabegame 自身 rusqlite 走静态解析不受影响。详见 README §9.4。

### ⚠️ 仍是 Phase 3 最小渲染路径(未接全应用)
`lib.rs` 的 Linux CEF `run()` 只 `Builder::<Cef>::new().build(context)` 推一个 main 窗口,**不挂插件/invoke_handler/setup/init()/http_server** → 前端能渲染,但调后端命令会失败(IPC = Phase 4)。

### 🧹 诊断脚手架(本次已全部清理 ✅)
排障期临时加入的以下开关/打印**已删除**,代码已回到干净状态(`cargo build -p kabegame --features standard` 通过、`sqlite3_` 导出=0、运行不崩、无回归):
- `runtime.rs`:event-loop 起点 thread-id 打印、`CEF_EXTRA_SWITCHES`。
- `webview.rs`:`CEF_NO_BLIT` / `CEF_NO_PAINT` / on_paint 线程打印 / `CEF_FORCE_URL`。
- **保留的真实修复**:`kabegame/build.rs` version script(隐藏 `sqlite3_*`)、删除 `--single-process`。
