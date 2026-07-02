# Phase 1 — Host op 层(对齐 Rhai API)逐点实施方案

> 对应总 plan [`v8-runtime-master-plan.md`](./v8-runtime-master-plan.md) 的 **Phase 1**;承接
> [`phase0-spike.md`](./phase0-spike.md)(deno_core 已接入、`JsPluginRuntime` 骨架 + 测试就绪)。
> 目标:把 Rhai 的**全部 host 函数**重写为 `op_kabegame_*`,用 **deno_core 异步 op + `.await`**
> 取代 Rhai 的 **`reqwest::blocking` + `tokio::Handle::block_on`**;cancellation 用
> `CancellationToken` 接入 event loop,可中断 async op。
>
> 验证遵循 CLAUDE.md:用 `cargo check` 诊断核对,不跑全量 build。本 Phase 仍**不接调度层**
> (Phase 4),通过 `v8.rs` 的 `#[cfg(test)]` 用例 + mock OpState 验证每个 op 的输入输出与取消行为。

---

## 边界与非目标

- **能力面 1:1 对齐** `docs/RHAI_API.md`,不增不减语义(签名/返回结构尽量等价,便于 Phase 6 迁移内置插件)。
- 删除 Phase 0 的占位 `op_kabegame_echo` 与探针 prelude(正式 prelude 是 Phase 2,本 Phase 仅
  在测试里手动把 op 挂到 `globalThis`,或直接 `Deno.core.ops.op_kabegame_*` 调用)。
- **不做**:入口契约/`crawl.v8.js` 加载(Phase 2)、`script_type` 调度分发(Phase 4)、
  snapshot、沙箱加固(Phase 7)。
- **复用而非重写下载链路**:`op_kabegame_download_image` 直接 `await DownloadQueue::download_image(..)`
  (Rhai 现在是 `block_on` 同一个 future),不动 `crawler/downloader/*` 业务。

---

## 现状锚点

**a. 每任务上下文 = 未来 OpState 的内容**(`src-tauri/kabegame-core/src/plugin/rhai.rs:529`)

```rust
pub struct RhaiCrawlerRuntime {
    pub(crate) engine: Engine,
    download_queue: Arc<crate::crawler::DownloadQueue>,
    images_dir: Shared<PathBuf>,            // Shared<T> = Arc<Mutex<T>>
    plugin_id: Shared<String>,
    task_id: Shared<String>,
    current_progress: Shared<Arc<Mutex<f64>>>,
    output_album_id: Shared<Option<String>>,
    http_headers: Shared<HashMap<String, String>>,
}
// 现状:每任务上下文靠一组 Arc<Mutex<..>> holder 在 reset_for_task() 里就地更新,
//       host 函数运行期从 holder 读“当前任务”的上下文(engine 只注册一次、跨任务复用)。
```

> 导航/页面状态**不在**上面这组 holder 里,而在全局 `TaskScheduler` 的 per-task PageStack:
> `TaskScheduler::global().get_stack_sync(&task_id)`(`rhai.rs:255`)给出 `current_url/current_html/headers`;
> `to()` 成功后 `stack_guard.push(PageStackEntry{..})`(`rhai.rs:896`)。

**b. host 函数注册(同步、靠 holder 读上下文)**(`rhai.rs:662` `register_crawler_functions`)

> `docs/RHAI_API.md` 能力面 = 需要重写的 op 全集(共 30 个,见下「点 0 — op 清单」)。

**c. 异步桥接 = blocking client + `block_on`**(`rhai.rs:131` / `rhai.rs:304` / `rhai.rs:449`)

```rust
// 下载:在 Rhai 引擎线程内 block_on 同一个 async future
let fut = dq_handle.download_image(parsed_url, images_dir, plugin_id, task_id, /*..*/);
tokio::runtime::Handle::current()
    .block_on(fut)                                    // 现状:同步阻塞桥接
    .map_err(|e| format!("Failed to download image: {}", e).into())

// 页面抓取:reqwest::blocking::Client，循环里轮询取消
let client = create_blocking_client()?;               // reqwest::blocking::Client (rhai.rs:449)
// for attempt in 1..=max_attempts { loop {
if TaskScheduler::global().is_task_canceled_blocking(task_id) {   // 现状:轮询式取消
    return Err("Task canceled".to_string());
}
let resp = client.get(&current_url).headers(..).send();          // 现状:阻塞 IO
```

**d. 取消语义**(`rhai.rs:142` 等)
`TaskScheduler::global().is_task_canceled_blocking(&task_id)` —— 同步轮询;每次 IO/下载前手动判一次。

---

## 点 0 — op 清单(`docs/RHAI_API.md` → `op_kabegame_*` 映射)

| 分组 | Rhai 名 | 新 op | async? | 备注 |
|------|---------|-------|:--:|------|
| 导航 | `to(url)` | `op_kabegame_to` | ✅ | 异步抓取 + push PageStack |
| 导航 | `back()` | `op_kabegame_back` | — | pop PageStack(纯状态) |
| 导航 | `fetch_json(url)` | `op_kabegame_fetch_json` | ✅ | 抓取并 parse JSON,**不**改 PageStack |
| 页面 | `current_url()` | `op_kabegame_current_url` | — | 读 PageStack 栈顶 |
| 页面 | `current_html()` | `op_kabegame_current_html` | — | 读 PageStack 栈顶 |
| 页面 | `current_headers()` | `op_kabegame_current_headers` | — | 读 PageStack 栈顶 |
| 状态 | `plugin_data()` | `op_kabegame_plugin_data` | ✅? | 读私有 JSON 缓存(见 PLUGIN_DATA.md);I/O 走 async |
| 状态 | `set_plugin_data(map)` | `op_kabegame_set_plugin_data` | ✅? | 写私有 JSON 缓存 |
| 头 | `set_header(k,v)` | `op_kabegame_set_header` | — | 改 OpState header map |
| 头 | `del_header(k)` | `op_kabegame_del_header` | — | 改 OpState header map |
| 日志 | `warn(msg)` | `op_kabegame_warn` | — | `task-log`(level=warn) |
| 进度 | `add_progress(n)` | `op_kabegame_add_progress` | — | 写 OpState progress |
| 入库 | `download_image(url[,opts])` | `op_kabegame_download_image` | ✅ | `await DownloadQueue::download_image` |
| 入库 | `create_image_metadata(map[,opts])` | `op_kabegame_create_image_metadata` | ✅? | `Storage::insert_image_metadata_row` |
| 日志 | `print/debug`(Rhai `on_print/on_debug`) | 运行时 hook,非 op | — | Phase 2 prelude 把 `console.*` → `task-log` |

> 以下能力移至 **plugin-sdk JS** 层实现,不开 Rust op:
> - **DOM 解析**(`query/query_by_text/find_by_text/get_attr`):在 SDK JS 内用浏览器原生 `DOMParser` / `querySelector` 实现,无需 `scraper` 绑定。
> - **工具函数**(`parse_json`/`url_encode`/`resolve_url`/`is_*_url`/`re_*`/`md5`/`unix_time_ms`/`rand_f64`/`sleep`):JS 原生(`JSON.parse`/`encodeURIComponent`/`URL`/`fetch`类型判断/`RegExp`/`SubtleCrypto`/`Date.now`/`Math.random`/`setTimeout`)覆盖全部语义,无需 op 绑定。
> - **小黑盒签名**(`xhh_hkey/xhh_nonce`):已从 API 面去除。
>
> `plugin_data/set_plugin_data/create_image_metadata` 是否 async 取决于其底层 I/O:若底层是
> `Storage` 同步 rusqlite,则 op 可同步;若涉及文件 I/O 则做 async。
> **实现时按现状底层签名定**,本清单标 `✅?` 表示待定。

---

## 点 1 — OpState 装配(`v8.rs`)

- **新增**
  - `KabegameOpState`:把现状那组 per-task holder 收敛成**一个** OpState 结构(deno_core 用
    `OpState` 单一容器 `put`/`borrow`,天然替代散落的 `Arc<Mutex<..>>`)。
    > 说明:导航/页面状态仍走全局 `TaskScheduler` PageStack(沿用现状,避免双写),OpState 只持
    > 「下载/入库/头/进度/取消」所需上下文。
  - `JsPluginRuntime::new` 接收上下文并 `op_state.put(KabegameOpState{..})`;`RuntimeOptions.extensions`
    用带 `state_fn` 的 `extension!`(`op_state.put(..)`)。

```rust
/// 每任务运行期 host 上下文（取代 rhai.rs 里散落的 Arc<Mutex<..>> holder）。
pub struct KabegameOpState {
    pub download_queue: Arc<crate::crawler::DownloadQueue>,
    pub images_dir: PathBuf,
    pub plugin_id: String,
    pub task_id: String,
    pub output_album_id: Option<String>,
    /// 脚本可变 header（set_header/del_header）。初值来自任务 http_headers。
    pub headers: HashMap<String, String>,
    /// 进度累加（add_progress）。
    pub progress: f64,
    /// 取消令牌：op 入口与 IO await 处协作式检查（见点 9）。
    pub cancel: tokio_util::sync::CancellationToken,
}

extension!(
    kabegame_v8,
    ops = [
        op_kabegame_to, op_kabegame_back, op_kabegame_fetch_json,
        op_kabegame_current_url, op_kabegame_current_html, op_kabegame_current_headers,
        op_kabegame_plugin_data, op_kabegame_set_plugin_data,
        op_kabegame_set_header, op_kabegame_del_header,
        op_kabegame_warn, op_kabegame_add_progress,
        op_kabegame_download_image, op_kabegame_create_image_metadata,
    ],
    options = { ctx: KabegameOpState },
    state = |state, options| { state.put(options.ctx); },
);
```

> `TaskScheduler` / `Storage` / `Settings` / `GlobalEmitter` 都是 `global()` 单例,op 内直接取,**不**进 OpState。
> 现状锚点(`rhai.rs:142,222,256,277`)已证明它们以单例方式被 host 函数使用。

---

## 点 2 — 网络/导航 ops(async,取代 blocking client + block_on)

- **新增**(代表:`op_kabegame_to`)
  - 把 `http_get_text_with_retry`(现状 `reqwest::blocking`,`rhai.rs:304`)改写为 **async reqwest**;
    成功后 push PageStack(沿用 `rhai.rs:896` 逻辑)。重试上限沿用 `Settings::get_network_retry_count`。
  - **删除** blocking 路径与 `block_on`:IO 直接 `.await`,取消用 `select!` + `CancellationToken`(点 9)。

```rust
#[op2(async)]
#[string]
async fn op_kabegame_to(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
) -> Result<String, deno_error::JsErrorBox> {
    // 取出上下文快照（避免跨 await 持有 RefCell borrow / OpState）
    let (task_id, headers, cancel) = {
        let s = state.borrow();
        let k = s.borrow::<KabegameOpState>();
        (k.task_id.clone(), k.headers.clone(), k.cancel.clone())
    };
    // 异步抓取（取消感知）；client 用桌面 async reqwest（非 blocking）。
    let (final_url, html, resp_headers) =
        http_get_text_async(&task_id, &url, "to", &headers, &cancel).await?;
    // push PageStack（沿用 TaskScheduler 现状）。
    TaskScheduler::global().push_stack_sync(&task_id, final_url.clone(), html, resp_headers);
    Ok(final_url)
}
```

- `op_kabegame_fetch_json`:同样 async 抓取,返回 `#[serde] JsonValue`,**不** push PageStack(对齐 `docs/RHAI_API.md:204`)。
- `op_kabegame_back`:纯状态,pop PageStack(同步 op 即可)。

---

## 点 3 — 解析 ops → **移至 plugin-sdk JS**

`query / query_by_text / find_by_text / get_attr` **不实现为 Rust op**。

理由:JS 运行在 V8 内已有完整 DOM 能力(通过 `DOMParser` + `querySelector` + `querySelectorAll`),
在 plugin-sdk JS 层用原生 API 封装等价工具函数,既避免引入 `scraper` Rust 依赖,也去除
`scraper::Html`/`Selector`(`Rc`,非 `Send`)的跨 `.await` 持有风险。

Phase 2 prelude 负责在 SDK JS 里提供这些辅助函数(`kabegame.query(sel)` 等)。

---

## 点 4 — 工具函数 → **全部移至 plugin-sdk JS**

以下能力均由 plugin-sdk JS 层用原生 API 实现,**不开 Rust op**:

| Rhai 名 | JS 替代 |
|---------|---------|
| `url_encode(s)` | `encodeURIComponent(s)` |
| `resolve_url(rel)` | `new URL(rel, currentUrl).href` |
| `is_image_url/is_media_url/is_video_url` | 按 MIME 类型或扩展名集合判断(SDK 内维护白名单) |
| `re_is_match(p,t)` | `new RegExp(p).test(t)` |
| `re_replace_all(p,r,t)` | `t.replace(new RegExp(p, 'g'), r)` |
| `md5(text)` | `SubtleCrypto.digest('MD5', ...)` 或轻量 JS 实现 |
| `unix_time_ms()` | `Date.now()` |
| `rand_f64()` | `Math.random()` |
| `xhh_hkey/xhh_nonce` | 已从 API 面去除 |
| `sleep(ms)` | `await new Promise(r => setTimeout(r, ms))` |
| `parse_json(text)` | `JSON.parse(text)` |

---

## 点 5 — 状态 ops(`plugin_data` / `set_plugin_data`)

- **新增**:对照 `cocs/crawler/PLUGIN_DATA.md` 与现状 `rhai.rs:721`。
  - `op_kabegame_plugin_data` 读、`op_kabegame_set_plugin_data` 写插件私有 JSON 缓存;
    plugin_id 取 OpState。底层 I/O 同步则同步 op,否则 async(见点 0 备注)。
  - `set_plugin_data` 入参 `#[serde] JsonValue`,需校验为 object(对齐现状 `rhai.rs:741` “value must be a Map”)。

---

## 点 6 — 头 ops(`set_header` / `del_header`)

- **新增**:同步 op,改 `OpState.headers`(替代现状 `http_headers` holder)。
  后续 `to/fetch_json/download_image` 抓取时合入该 map(沿用 `build_reqwest_header_map` 现状语义)。

---

## 点 7 — 日志/进度 ops(`warn` / `add_progress`)

- **新增**
  - `op_kabegame_warn`(同步):`GlobalEmitter::global().emit_task_log(task_id, "warn", msg)`(现状 `rhai.rs:277`)。
  - `op_kabegame_add_progress`(同步):累加 `OpState.progress`,并发 `add_progress` 事件(对齐现状进度语义)。
  - `print/debug`:**非 op** —— Phase 2 prelude 把 `console.log/console.warn` 重定向到 `task-log`
    (等价现状 `engine.on_print/on_debug`,`rhai.rs:558`)。本 Phase 测试可暂用 `Deno.core.print`。
  - `sleep`:**移至 plugin-sdk JS**(`await new Promise(r => setTimeout(r, ms))`),不开 op。

---

## 点 8 — 入库 ops(`download_image` / `create_image_metadata`)

- **新增**:`op_kabegame_download_image`(**async**)
  - 直接 `await` 现状同一个 future `DownloadQueue::download_image(url, images_dir, plugin_id, task_id,
    start_ms, output_album_id, headers, name, metadata_id)`(现状 `rhai.rs:152`),**去掉 `block_on`**。
  - opts 解析(`name` / `metadata_id`)沿用现状 `parse_download_image_opts_from_map`(`rhai.rs:169`)语义,
    改为从 `#[serde] opts: Option<JsonValue>` 读。
  - 入口先查取消(对齐现状 `rhai.rs:142`)。

```rust
#[op2(async)]
async fn op_kabegame_download_image(
    state: Rc<RefCell<OpState>>,
    #[string] url: String,
    #[serde] opts: Option<serde_json::Value>,
) -> Result<(), deno_error::JsErrorBox> {
    let (dq, dir, plugin_id, task_id, album, headers, cancel) = {
        let s = state.borrow();
        let k = s.borrow::<KabegameOpState>();
        (k.download_queue.clone(), k.images_dir.clone(), k.plugin_id.clone(),
         k.task_id.clone(), k.output_album_id.clone(), k.headers.clone(), k.cancel.clone())
    };
    if cancel.is_cancelled() { return Err(JsErrorBox::generic("Task canceled")); }
    let (name, metadata_id) = parse_download_opts(opts)?;   // 搬运 rhai.rs:169 语义
    let parsed = Url::parse(&url).map_err(|e| JsErrorBox::generic(format!("Invalid URL: {e}")))?;
    let start_ms = now_ms();
    dq.download_image(parsed, dir, plugin_id, task_id, start_ms, album, headers, name, metadata_id)
        .await
        .map_err(|e| JsErrorBox::generic(format!("Failed to download image: {e}")))
}
```

- `op_kabegame_create_image_metadata`:对照现状 `rhai.rs:222`(`Storage::insert_image_metadata_row`,
  含 `metadata_version`),入参 `#[serde]` map + opts;async/sync 依底层签名(点 0 备注)。

---

## 点 9 — cancellation 接入 event loop

- **新增**
  - OpState 持 `CancellationToken`(任务取消时由调度层 cancel —— Phase 4 接线;本 Phase 测试手动 cancel)。
  - **协作式取消**:每个 async op 在 IO `.await` 处用 `tokio::select!` 同时等 future 与 `cancel.cancelled()`,
    取消优先返回 `Err("Task canceled")`(等价现状轮询 `is_task_canceled_blocking`,但无需轮询)。
  - **硬中断**(可选,Phase 7 强化):保留 `JsRuntime::v8_isolate().terminate_execution()` 作为最后手段,
    用于脚本进入纯 CPU 死循环(无 op、event loop 不回 Rust)的场景。本 Phase 仅做协作式取消即满足退出标准。

```rust
let outcome = tokio::select! {
    biased;
    _ = cancel.cancelled() => return Err(JsErrorBox::generic("Task canceled")),
    r = real_io_future => r,
};
```

---

## 退出标准(对齐总 plan Phase 1)

- op 列表与点 0 清单逐项落地(14 个 op);
- **无 `block_on`**:`grep -n block_on src/plugin/v8.rs` 为空;网络/下载全 `.await`;
- cancellation 可中断 async op:测试里 cancel 后 `op_kabegame_to` / `op_kabegame_download_image` 立即返回 `Err`;
- `cargo check -p kabegame-core --lib` 通过(注:需先解决 Phase 0 记录的 emitter/queue WIP 编译错误,
  否则整库 check 受阻 —— 该 WIP 非本 Phase 引入);
- 新增 `v8.rs` 测试:对每组 op 至少一条用例(mock OpState + 直接 `Deno.core.ops.op_kabegame_*` 调用),
  覆盖正常路径 + 取消路径。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 删除 | `v8.rs` | Phase 0 占位 `op_kabegame_echo` + 探针 prelude |
| 新增 | `v8.rs`(或拆 `plugin/v8/ops.rs`) | `KabegameOpState` + 14 个 `op_kabegame_*` + 重试/opts 辅助函数(搬运 rhai.rs) |
| 修改 | `v8.rs` | `extension!` 列全部 ops + `state_fn` 注入 OpState;`JsPluginRuntime::new` 接收上下文 |
| 修改 | `Cargo.toml`(桌面 target) | 视需要新增 `tokio-util`(CancellationToken)、`deno_error`(若未随 deno_core 传递) |
| 新增 | `v8.rs` tests | 每组 op 正常 + 取消用例 |

> 若 op 体量大,建议把骨架 `v8.rs` 拆成 `plugin/v8/mod.rs`(`JsPluginRuntime`)+ `plugin/v8/ops.rs`(ops),
> 与 `mod.rs` 的 `#[cfg(not(android/ios))] pub mod v8;` 一致门控。

---

## 衔接 Phase 2 预告

- 正式 prelude:`globalThis.__kabegame_* = Deno.core.ops.op_kabegame_*` + `console.*` → `task-log`;
- 入口契约:加载自包含 `crawl.v8.js` → 取 `export async function crawl` → `run_event_loop` 驱动;
- plugin-sdk JS 层实现 DOM 解析辅助(`query/query_by_text/find_by_text/get_attr`)及工具函数(`url_encode/resolve_url/re_*/md5/sleep` 等)。
