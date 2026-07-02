# Phase 2 — JS 运行时 prelude + 入口契约(逐点实施方案)

> 对应总 plan [`v8-runtime-master-plan.md`](./v8-runtime-master-plan.md) 的 **Phase 2**;
> 前置:[`phase1-host-ops.md`](./phase1-host-ops.md)(`op_kabegame_*` host op 层 + `KabegameOpState` +
> 协作式取消)。目标:**定死运行时与插件的契约** ——
> 只加载**自包含单文件** `crawl.v8.js`,prelude 把裸 op 挂到 `globalThis.__kabegame_*`,
> `console.*` → task-log,cancellation 接入 event loop(`terminate_execution` 硬中断),
> 并提供与 Rhai `execute_crawler_script_with_runtime` **同形**的调度入口(Phase 4 接线)。
>
> 验证遵循 CLAUDE.md:`cargo check` + `v8.rs` 测试模块,不跑全量 build。

---

## Phase 1 实际 op 集(以 `~/kabegame` 实现为准)

> Phase 1 实施时精简了 op 面:DOM 解析(`query/query_by_text/find_by_text/get_attr`)、
> URL 工具(`url_encode/resolve_url/is_*_url`)、正则(`re_*`)、工具函数(`md5/unix_time_ms/rand_f64`)
> 及签名(`xhh_*`)全部移至 **plugin-sdk JS 侧**实现,Rust op 层只保留无法在 JS 内做的能力。
>
> 实际落地的 14 个 ops(`src/plugin/v8/ops.rs`):

| op 名 | async? | 说明 |
|-------|:---:|------|
| `op_kabegame_to` | ✅ | 异步抓取 + push PageStack |
| `op_kabegame_back` | ✅ | pop PageStack |
| `op_kabegame_fetch_json` | ✅ | 抓取 + parse JSON,不改 PageStack |
| `op_kabegame_current_url` | ✅ | 读 PageStack 栈顶 URL |
| `op_kabegame_current_html` | ✅ | 读 PageStack 栈顶 HTML |
| `op_kabegame_current_headers` | ✅ | 读 PageStack 栈顶 headers |
| `op_kabegame_plugin_data` | — | 读插件私有 JSON 缓存 |
| `op_kabegame_set_plugin_data` | — | 写插件私有 JSON 缓存 |
| `op_kabegame_set_header` | — | 改 OpState header map |
| `op_kabegame_del_header` | — | 改 OpState header map |
| `op_kabegame_warn` | — | emit task-log(level=warn) |
| `op_kabegame_add_progress` | — | 累加进度 |
| `op_kabegame_download_image` | ✅ | await DownloadQueue |
| `op_kabegame_create_image_metadata` | — | Storage::insert_image_metadata_row |

---

## 边界与非目标

- **不做** ModuleLoader:`RuntimeOptions.module_loader = None` 是**契约的一部分** —— 插件里任何
  `import` 语句在运行期直接报错,从运行时侧强制"作者必须 bundle 成自包含单文件"(决策 D4/D6)。
- **不做** `.kgpg` 内 `crawl.v8.js` 的检测/装载(`Plugin.v8_script` 字段、`script_type = "v8"`)——
  属 Phase 4 调度集成;本 Phase 入口 API 只收 `script_content: &str`。
- **不做** SDK(Phase 3);测试直接用 `globalThis.__kabegame_*` 写入口脚本。
- snapshot **降级为可选项**(见点 6 的取舍说明),不作为本 Phase 退出闸。

---

## 现状锚点

**a. Phase 1 后的 `v8.rs`**(`~/kabegame/src-tauri/kabegame-core/src/plugin/v8.rs`)

```rust
// Phase 1 已实现(~/kabegame,未提交):
mod ops;
pub use ops::KabegameOpState;

extension!(
    kabegame_v8,
    ops = [
        ops::op_kabegame_to, ops::op_kabegame_back, ops::op_kabegame_fetch_json,
        ops::op_kabegame_current_url, ops::op_kabegame_current_html, ops::op_kabegame_current_headers,
        ops::op_kabegame_plugin_data, ops::op_kabegame_set_plugin_data,
        ops::op_kabegame_set_header, ops::op_kabegame_del_header,
        ops::op_kabegame_warn, ops::op_kabegame_add_progress,
        ops::op_kabegame_download_image, ops::op_kabegame_create_image_metadata,
    ],
    options = { ctx: KabegameOpState },
    state = |state, options| { state.put(options.ctx); },
);

const ENTRY_SPECIFIER: &str = "file:///crawl.v8.js";
// 现状:无正式 prelude,注释标注 "Phase 2"

pub struct JsPluginRuntime { runtime: JsRuntime }
impl JsPluginRuntime {
    pub fn new(ctx: KabegameOpState) -> Result<Self> { /* extensions, module_loader: None */ }
    pub async fn run_crawl(&mut self, entry_code: String, args: JsonValue) -> Result<JsonValue>
    // 现状:单 args 参数、返回 JsonValue(Phase 2 定稿为 common/custom 双参 + 返回 () + 错误归一)
}
// 现状:无 execute_crawler_script_v8 调度入口(Phase 2 新增)
```

**b. 调度侧对 Rhai 的调用形态 = v8 入口要镜像的形状**(`src/crawler/task_scheduler.rs:661`)

```rust
tokio::task::spawn_blocking(move || {
    let mut rhai_runtime = crate::plugin::rhai::RhaiCrawlerRuntime::new(download_queue);
    crate::plugin::rhai::execute_crawler_script_with_runtime(
        &mut rhai_runtime,
        &plugin_for_exec,       // &Plugin
        &images_dir,            // &Path
        &plugin_for_exec.id,    // plugin_id
        &task_id,
        &rhai_script,           // 脚本内容字符串
        merged_config_for_exec, // HashMap<String, serde_json::Value>
        output_album_id,        // Option<String>
        http_headers,           // Option<HashMap<String, String>>
    )
})
.await
// 现状:worker 在 spawn_blocking 线程上同步执行;Rhai 内部各 host 函数自行 block_on。
```

**c. config 注入规则**(`src/plugin/rhai.rs:1630`)

```rust
// 现状:base_url 仅当插件提供了非空 baseUrl 且 merged_config 未含同名键时注入
if !plugin_base_url.is_empty() && !merged_config.contains_key("base_url") {
    scope.push_constant("base_url", plugin_base_url.to_string());
}
// Null 值被跳过不注入(Rhai 无原生 null)
```

**d. deno_core 0.405 关键 API(已对照 `~/code/deno/libs/core` 核实)**

```text
extension!(name, ops=[..], esm_entry_point="ext:kabegame_v8/prelude.js",
           esm=[dir "src/plugin/v8", "prelude.js"])       // prelude 以内置 ESM 随扩展初始化执行
JsRuntime::v8_isolate().thread_safe_handle() -> IsolateHandle  // 可跨线程
IsolateHandle::terminate_execution() -> bool               // 硬中断
Deno.core.createSystemTimer(callback, after, isRefed)      // setTimeout shim 底座(01_core.js:1222)
deno_core 不提供 globalThis.setTimeout(仅 ext/web 封装)
```

---

## 点 1 — 正式 prelude(`src/plugin/v8/prelude.js`,**新建**;`v8.rs` 修改)

- **新增**:`prelude.js`,通过 `extension!` 的 `esm` 内嵌(随扩展初始化执行)。内容三块:
  1. **op 映射**:显式逐条列出全部 14 个 `__kabegame_*` 对应 `Deno.core.ops.op_kabegame_*`
     (显式 > 循环反射;这份清单即 ABI / `engines.kabegame` 对应版本)。
  2. **console 重定向**:`console.*` → 新增 `op_kabegame_log(level, msg)`;
     多参数 join,非字符串 `JSON.stringify`(等价 rhai `on_print/on_debug`)。
  3. **`setTimeout`/`clearTimeout` shim**:基于 `Deno.core.createSystemTimer`(bundle 常隐式依赖)。

```js
// src/plugin/v8/prelude.js —— 运行时唯一注入面(ABI)。
// SDK 是 __kabegame_* 的薄封装(Phase 3 实现)。
const ops = Deno.core.ops;

// 1) 裸 op 映射(与 Phase 1 实际 op 集对应)
globalThis.__kabegame_to                  = (url)         => ops.op_kabegame_to(url);
globalThis.__kabegame_back                = ()            => ops.op_kabegame_back();
globalThis.__kabegame_fetch_json          = (url)         => ops.op_kabegame_fetch_json(url);
globalThis.__kabegame_current_url         = ()            => ops.op_kabegame_current_url();
globalThis.__kabegame_current_html        = ()            => ops.op_kabegame_current_html();
globalThis.__kabegame_current_headers     = ()            => ops.op_kabegame_current_headers();
globalThis.__kabegame_plugin_data         = ()            => ops.op_kabegame_plugin_data();
globalThis.__kabegame_set_plugin_data     = (map)         => ops.op_kabegame_set_plugin_data(map);
globalThis.__kabegame_set_header          = (k, v)        => ops.op_kabegame_set_header(k, v);
globalThis.__kabegame_del_header          = (k)           => ops.op_kabegame_del_header(k);
globalThis.__kabegame_warn                = (msg)         => ops.op_kabegame_warn(msg);
globalThis.__kabegame_add_progress        = (n)           => ops.op_kabegame_add_progress(n);
globalThis.__kabegame_download_image      = (url, opts)   => ops.op_kabegame_download_image(url, opts);
globalThis.__kabegame_create_image_metadata = (map, opts) => ops.op_kabegame_create_image_metadata(map, opts);

// 2) console → task-log
function fmt(args) {
  return args.map((a) => {
    if (typeof a === "string") return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(" ");
}
globalThis.console = {
  log:   (...a) => ops.op_kabegame_log("print", fmt(a)),
  info:  (...a) => ops.op_kabegame_log("info",  fmt(a)),
  warn:  (...a) => ops.op_kabegame_log("warn",  fmt(a)),
  error: (...a) => ops.op_kabegame_log("error", fmt(a)),
  debug: (...a) => ops.op_kabegame_log("debug", fmt(a)),
};

// 3) 最小 timer shim(bundle 常隐式依赖;基于 deno_core 内部原语)
globalThis.setTimeout  = (cb, ms = 0, ...args) =>
  Deno.core.createSystemTimer(() => cb(...args), ms, true);
globalThis.clearTimeout = (id) => Deno.core.cancelTimer(id);
```

- **新增**(`ops.rs`):`op_kabegame_log`(sync,`#[op2(fast)]`)—— console 需要带 level 的通用日志:

```rust
/// console.* 与 SDK log 的统一出口(等价 rhai on_print/on_debug → task-log)。
#[op2(fast)]
pub fn op_kabegame_log(state: &mut OpState, #[string] level: String, #[string] message: String) {
    let task_id = state.borrow::<KabegameOpState>().task_id.clone();
    GlobalEmitter::global().emit_task_log(&task_id, &level, &message);
}
```

- **修改**(`v8.rs`):`extension!` 增加 `op_kabegame_log` + esm 装载:

```rust
extension!(
    kabegame_v8,
    ops = [
        ops::op_kabegame_to, ops::op_kabegame_back, ops::op_kabegame_fetch_json,
        ops::op_kabegame_current_url, ops::op_kabegame_current_html, ops::op_kabegame_current_headers,
        ops::op_kabegame_plugin_data, ops::op_kabegame_set_plugin_data,
        ops::op_kabegame_set_header, ops::op_kabegame_del_header,
        ops::op_kabegame_warn, ops::op_kabegame_add_progress,
        ops::op_kabegame_download_image, ops::op_kabegame_create_image_metadata,
        ops::op_kabegame_log,   // 新增
    ],
    esm_entry_point = "ext:kabegame_v8/prelude.js",    // 新增
    esm = [ dir "src/plugin/v8", "prelude.js" ],        // 新增
    options = { ctx: KabegameOpState },
    state = |state, options| { state.put(options.ctx); },
);
```

---

## 点 2 — 入口契约(`v8.rs`:`run_crawl` 定稿)

**契约条文**(写入 rustdoc,Phase 3 的 SDK 文档与 Phase 6 的 `docs/JS_API.md` 引用它):

1. 入口文件名 `crawl.v8.js`(决策 D7),**必须自包含**:`module_loader = None`,任何运行期
   `import` 解析请求直接报错(提示"插件必须 bundle 为自包含单文件")。
2. 必须 `export async function crawl(common, custom)`(允许同步函数 —— `call_with_args` 对非 Promise 直接 resolve;
   允许 top-level await —— `mod_evaluate` + event loop 驱动)。
3. 配置拆成**两个对象参数**(取代 Rhai 的全局常量注入):
   - **`common`**:宿主公共配置,所有插件结构一致(当前含 `base_url` —— 取插件 manifest 的
     `baseUrl`,空则为 `null`)。原锚点 c 的"merged_config 未含同名键才注入"条件随命名空间
     拆分**消失**:`base_url` 恒在 `common`,与 `custom` 键不冲突。
   - **`custom`**:插件自定义配置 = `merged_config`(config.json 声明 + 用户设置合并,
     serde_json 直接转 v8)。差异决策:**JS 侧保留 null**(Rhai 因无原生 null 而跳过,JS 无此限制)。
   > 类型层面(Phase 3):`common` 对应 SDK 固定类型 `KbCommonCfg`;`custom` 由插件用 SDK 的
   > **TS 类型函数**声明,如
   > `type KonachanConfig = kbCustomCfg<[kbCfgField<"start_page", kbCfgInt>, kbCfgField<"end_page", kbCfgInt>]>`。
4. `crawl` 返回值**忽略**(产出通过 `download_image` 入库,与 Rhai 一致);
   Promise reject / 模块求值异常 → 任务失败,错误串带 JS 栈。
5. 取消:协作式(Phase 1 CancellationToken)为主;`terminate_execution` 兜底(点 3)。

- **修改**(`run_crawl`):返回类型改 `Result<(), _>`(忽略返回值);入参从单个 `args: JsonValue`
  改为 `common: JsonValue, custom: JsonValue` 两个,`call_with_args` 传两个 v8 值;错误路径归一取消(点 3)。
- `run_crawl` 接收 `plugin_id: &str` 用于 specifier(`file:///{plugin_id}/crawl.v8.js`,栈可读)。

---

## 点 3 — cancellation 接入 event loop(`terminate_execution` 硬中断)

> Phase 1 协作式取消覆盖"卡在 op/IO"的情形;本点补"脚本纯 CPU 死循环(不回 Rust)"的兜底。

- **新增**(`execute_crawler_script_v8`,见点 4):
  - 取 `v8_isolate().thread_safe_handle()` → spawn watcher task → 等 cancel → `terminate_execution()`;
  - 任务正常结束后 abort watcher;
  - terminate 使 event loop 报 `"execution terminated"` → 与协作式取消统一映射为 `"Task canceled"`。

```rust
let isolate_handle = rt.runtime_mut().v8_isolate().thread_safe_handle();
let cancel_clone = cancel.clone();
let watcher = tokio::spawn(async move {
    cancel_clone.cancelled().await;
    isolate_handle.terminate_execution();
});
let result = rt.run_crawl(&plugin_id, script_content.to_string(), config).await;
watcher.abort();
normalize_cancel_error(result, &cancel)
```

```rust
fn normalize_cancel_error(
    result: anyhow::Result<()>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(e) => {
            let msg = e.to_string();
            if cancel.is_cancelled() || msg.contains("execution terminated") || msg.contains("Task canceled") {
                Err("Task canceled".to_string())
            } else {
                Err(msg)
            }
        }
    }
}
```

---

## 点 4 — 调度入口 `execute_crawler_script_v8`(`v8.rs`,**新增**;Phase 4 接线)

- **新增**:签名镜像 `rhai::execute_crawler_script_with_runtime`,供 `task_scheduler.rs` 的
  `spawn_blocking` 直接替换:

```rust
/// V8 后端调度入口，签名镜像 rhai::execute_crawler_script_with_runtime。
/// 设计为在 tokio spawn_blocking worker 线程内调用（JsRuntime 非 Send，全程单线程）。
///
/// 此处 block_on 是每任务一次的入口边界（worker 线程驱动本任务 event loop），
/// 不是 Phase 1 已消灭的 per-op 阻塞桥接——语义不同。
pub fn execute_crawler_script_v8(
    download_queue: Arc<crate::crawler::DownloadQueue>,
    plugin: &Plugin,
    images_dir: &Path,
    plugin_id: &str,
    task_id: &str,
    script_content: &str,
    merged_config: HashMap<String, serde_json::Value>,
    output_album_id: Option<String>,
    http_headers: Option<HashMap<String, String>>,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    // 拆双参:common 固定结构(base_url 等),custom = merged_config 原样。
    let (common, custom) = build_crawl_configs(plugin, merged_config);
    tokio::runtime::Handle::current().block_on(async move {
        let ctx = KabegameOpState {
            download_queue,
            images_dir: images_dir.to_path_buf(),
            plugin_id: plugin_id.to_string(),
            task_id: task_id.to_string(),
            output_album_id,
            headers: http_headers.unwrap_or_default(),
            progress: 0.0,
            cancel: cancel.clone(),
        };
        let mut rt = JsPluginRuntime::new(ctx).map_err(|e| e.to_string())?;
        // 点 3:cancel watcher
        let isolate_handle = rt.runtime_mut().v8_isolate().thread_safe_handle();
        let watcher = tokio::spawn(async move {
            cancel.cancelled().await;
            isolate_handle.terminate_execution();
        });
        let result = rt.run_crawl(plugin_id, script_content.to_string(), common, custom).await;
        watcher.abort();
        normalize_cancel_error(result, &ctx_cancel)
    })
}
```

> `JsRuntime` 非 `Send`,`JsPluginRuntime` 不能跨 `spawn`;`tokio::task::spawn_blocking` +
> `Handle::current().block_on` 是在 blocking worker 线程内跑 single-thread async executor,
> 与 Rhai 的 `spawn_blocking` + 同步调用是等价的调度形态(调度层 Phase 4 接线时 drop-in 替换)。
> v8 与 Rhai 的关键差异:**每任务新建 isolate**(更强隔离,已为 Phase 7 per-task 隔离铺路)。

---

## 点 5 — 测试模块(`v8.rs` tests 扩充)

- **新增**用例(全部 `#[tokio::test]`,不依赖网络):
  1. **契约正常路径**:脚本用 `__kabegame_add_progress(0.5)` + `console.log({a:1})` + 异步等待(
     `await new Promise(r => setTimeout(r, 1))`),验证 prelude 就绪、`crawl(common, custom)` 的
     `common.base_url` 与 `custom` 里的 merged_config 字段各自到位、跑完无错。
  2. **import 被拒绝**:入口含 `import x from "y"` → 报错;验证 module_loader=None 强制。
  3. **协作式取消**:脚本 `while(true) { await __kabegame_download_image("http://x") }`,
     外部 cancel → 立即返回 `"Task canceled"`。
  4. **硬中断**:脚本 `for(;;){}`,cancel → terminate_execution → 错误归一 `"Task canceled"`。
  5. **console + timer shim**:`console.log({a:1})` 不抛;`await new Promise(r => setTimeout(r, 5))` 可完成。

---

## 点 6 — snapshot:降级为可选项(决策 O2)

> **决策:Phase 2 不实施 snapshot。** 原因与后续路径:
> 1. `snapshot::create_snapshot` 须在 **build.rs** 里构造 `extension!`。但 `op_kabegame_*` ops
>    引用 `kabegame-core` 自身类型(`DownloadQueue`/`Storage`…),build.rs **无法依赖本 crate**,
>    必须把 ops 拆成独立 crate 才能烘焙 op 注册表(参考 deno 自身的分层方式)。
> 2. 本运行时 JS 面只有一份极小 prelude;V8 冷启动大头已由 deno_core 自带的 **static snapshot**
>    覆盖,再烘 prelude 收益以毫秒计。
>
> 若 Phase 6 迁移内置插件后实测冷启动不达标,按「拆 `kabegame-v8-ops` crate + build.rs
> `create_snapshot`」路径实施(参考 `~/code/deno/libs/core/examples/snapshot/`)。

---

## 退出标准(对齐总 plan Phase 2)

- 能加载**自包含** bundle 并完整跑完 `crawl`:测试用例 1(add_progress/console/timer)通过;
- `import` 被运行时拒绝(用例 2);
- cancellation 双路径可中断:协作式(用例 3)+ `terminate_execution` 硬中断(用例 4);
- `console.*` + timer shim 可用(用例 5);
- `cargo check -p kabegame-core --lib` 通过;
- `execute_crawler_script_v8` 签名冻结,Phase 4 可在 `task_scheduler.rs` 的 `spawn_blocking` 处 drop-in 接线。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 新增 | `src/plugin/v8/prelude.js` | 14 op 映射 + console 重定向 + setTimeout shim |
| 新增 | `src/plugin/v8/ops.rs` | `op_kabegame_log`(fast sync op) |
| 修改 | `v8.rs` | `extension!` 加 `op_kabegame_log` + esm 装载;`run_crawl` 改 `common/custom` 双参、返回 `()` |
| 新增 | `v8.rs` | cancel watcher + `normalize_cancel_error` + `build_crawl_configs` + `execute_crawler_script_v8` |
| 新增 | `v8.rs` tests | 用例 1–5(契约/import 拒绝/协作取消/硬中断/console+timer) |
| 修改 | `v8-runtime-master-plan.md` | snapshot → O2 推迟决策 |

---

## 衔接 Phase 3 预告

- prelude 的 14 个 `__kabegame_*` 清单 = SDK 封装目标与 `engines.kabegame` ABI 基线;
- `crawl(common, custom)` 契约(本文点 2)= SDK 类型来源:`common` 对应固定导出类型 `KbCommonCfg`;
  `custom` 由插件作者用 SDK 提供的 **TS 类型函数**(泛型类型别名,非运行时函数)声明字段结构,如:
  ```ts
  type KonachanConfig = kbCustomCfg<[
    kbCfgField<"start_page", kbCfgInt>,
    kbCfgField<"end_page", kbCfgInt>,
  ]>;
  export async function crawl(common: KbCommonCfg, custom: KonachanConfig) { /* .. */ }
  ```
  与 config.json 的字段声明一一对应(Phase 3 设计 `kbCfgInt/kbCfgStr/...` 等字段类型集);
- DOM 解析/URL 工具/正则等由 SDK JS 实现(`DOMParser`/`URL`/`RegExp`),Phase 3 写 SDK 时对齐。
