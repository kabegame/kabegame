# Phase C（插件）：`plugin://` 按来源寻址 + 推荐配置进统一模型

范围：只做插件侧——`plugin://` 路径、插件事件、推荐配置数据源。自动配置页面的运行配置列表
（`usePagedRunConfigs` 观察方化、去掉写命令 `view` / `hold`、删 `pathql_view` / `pathql_count`）留给 C3，本计划不碰。
改动较大，按三步执行，**每步独立可编译、可验收**，做完一步再开下一步。

### 总体设计思路

推荐配置现在是一个"静态文件 + 动态导入态"的混合体。`/plugin_file?t=recommendedConfig` 读文件时，
后端顺手扫全部运行配置，给文件标上 `isImported`。为了让这个标注是新的，只能 `no-store`。
任一配置变化，前端就把所有推荐文件重新 HTTP 读一遍。写命令还另开一条路，额外回传 `recommended + recommendedSeq`，
于是前端要靠四个序号变量调和两条通路的先后。本计划把它收进 kbEvents 的统一模型：
推荐配置是 `plugin://…/<id>/<version>/recommended` 的一种 rows 数据，前端用 `usePathqlLookMany` 观察，
刷新只靠"事件窗口 + 用户操作"两条通路，新旧由核心的 pending 窗口判定，不再有序号补位。

寻址先要能区分来源。推荐配置不止来自已安装插件：商店里的未安装插件、本地 `.kgpg` 预览也有推荐配置，
`PluginFileOrigin` 现在有 `Installed / Store / Preview` 三种。所以 `plugin://` 改成和其它 PathQL 一样，
第一段是过滤维度：`installed/<id>/<version>`、`byStore/<sourceId>/<id>/<version>`、`byPreview/<token>/<id>/<version>`。
后面的子资源（`icon` / `doc` / `changelog` / `asset` / `provider` / `recommended` 等）对三种来源一视同仁。
**版本是路径的一部分**：插件升级后旧路径解析为空，新版本是新 key，前端观察集合自然换 key，用不着专门的失效逻辑。
pathql runtime 会按路径前缀缓存已解析的 provider，所以 provider 只持有坐标 `(origin, id, version)`，
每次读取时现场经 `resolve_plugin_file` 解析。这样同版本覆盖安装、卸载之后不会读到缓存住的旧 `Plugin`。

事件对齐其它实体的命名：`plugin-added` / `plugin-changed` / `plugin-deleted`，删掉旧覆盖安装事件名。
`plugin-changed` 和 `album-changed` 一样带 patch：`{ pluginId, changes }`。
- 包被覆盖安装（升级或同版本重装）时，`changes` 是新的完整插件 JSON，必然含 `version`。插件 store 合并它。
- 某插件推荐配置的导入态**实际变化**时，`changes` 只有 `recommendedConfigs: { <path>: { imported } }`。插件 store 忽略这种事件。

导入态事件由运行配置写命令在提交后发出：写前、写后各算一次受影响插件的导入态，有差异才发。
调度器只改计划时间这种写入就不会触发推荐配置刷新，这是改用 `auto-config-change` 做不到的。
前端观察方的 `refreshOn` 是"同一 pluginId，且 `changes` 含 `version` 或 `recommendedConfigs`"。
推荐配置不放进 `pathql_all` 批：`plugin://` 不是 SQL，不受读快照约束。只用 rows。

关键决策：
- 来源进路径，不另开命令或新 kind。这样 MCP、CLI `pathql query`、前端读的是同一份数据。
- 导入态差异由写侧计算后随事件推送，不由读侧轮询。
- 推荐配置行沿用旧的"文件内容 + 标注"形态，`parsePluginRecommendedPreset` 不用改。

### 现状锚点

**a. `plugin://` 只按 id 寻址已安装插件**（`kabegame-core/src/providers/programmatic/plugin_resource.rs`）
```rust
fn get_plugin(plugin_id: &str) -> Option<Arc<Plugin>> {
    plugin_manager()?.get(plugin_id)          // 现状：只有已安装插件，商店 / 预览不可达
}
impl Provider for PluginRootProvider {
    fn resolve(&self, name: &str, ...) -> ResolveRef {
        if get_plugin(name).is_none() { return ResolveRef::Terminal(None); }
        // 现状：plugin://<id> 直接到插件条目，路径里没有版本
        ResolveRef::Terminal(Some(ChildEntry { provider: Some(Arc::new(PluginEntryProvider { plugin_id: name.to_string() })), .. }))
    }
}
// PluginEntryProvider 子项：icon / description_template / doc / changelog / asset / provider，各自只持有 plugin_id
```

**b. 来源解析已经存在**（`plugin/package_file.rs`）
```rust
pub fn resolve_plugin_file(&self, id: &str, origin: &PluginFileOrigin, version: &str) -> Option<Arc<Plugin>> {
    let plugin = match origin {
        PluginFileOrigin::Installed => self.get(id)?,
        PluginFileOrigin::Store { source_id } => Arc::new(self.store_plugin_cache.load().get(source_id)?.get(id)?.clone()),
        PluginFileOrigin::Preview { token } => { /* 按 token+id+version 取预览缓存 */ }
    };
    (plugin.id == id && plugin.version == version).then_some(plugin)   // 版本不符即 None
}
```

**c. 推荐配置读文件时标注导入态**（`kabegame/src/plugin_file_server.rs`、`package_file.rs`）
```rust
let annotate = match query.t.as_deref() {
    None => false,
    Some("recommendedConfig") if is_recommended_config(&plugin, &entry) => true,
    _ => return StatusCode::NOT_FOUND.into_response(),
};
if annotate {
    // 现状：每读一个文件扫一遍全部运行配置；no-store，不可缓存
    let body = serde_json::to_vec(&annotate_recommended_config(&plugin, &entry, json)?)?;
    return Ok(([("content-type", "application/json; charset=utf-8"), ("cache-control", "no-store")], body).into_response());
}
// annotate_with_configs：content ∪ { pluginId, filename, isImported }
```

**d. 写命令回传导入态**（`commands/task.rs`）
```rust
async fn run_config_write_result(config_id, reason, seq, config, view: Option<String>,
    recommended: Option<Vec<RecommendedConfigRequest>>) -> Result<Value, String> {
    // 现状：两者都没传就返回单行（IPC handler 走这条），否则返回对象
    if view.is_none() && recommended.is_none() { return Ok(config); }
    // …… view 快照 + 对 recommended 每项读文件、扫配置算 isImported
    Ok(json!({ "configId", "reason", "config", "seq", "view", "recommended": states, "recommendedSeq" }))
}
// IPC：IpcRequest::StorageAddRunConfig { config } => run_configs::add_run_config(config)（最终传 None, None）
```

**e. 前端推荐配置：读文件 + 两条导入态通路 + 序号调和**（`services/recommendedPresets.ts`、`services/pluginFiles.ts`）
```ts
export async function fetchRecommendedConfig(plugin: Plugin, path: string): Promise<unknown> {
  const response = await fetch(pluginFileUrl(plugin, path, "recommendedConfig"), { cache: "no-store" });
  ...
}
// useRecommendedPresets：
let appliedSeq = 0; let importRevision = 0; let pendingSeq = 0;
const latestImported = new Map<string, boolean>();
registerRecommendedImportStates({ requests: ..., apply: (states, seq) => { if (seq < appliedSeq) return; ... } });
subscribeRunConfigEvents((event) => { /* 200ms 后把全部推荐文件重新 HTTP 读一遍 */ });
```

**f. 插件事件**（`ipc/events.rs`、`emitter.rs`、`plugin/mod.rs`、`stores/plugins.ts`）
```rust
PluginAdded { plugin: serde_json::Value },
PluginDeleted { #[serde(rename = "pluginId")] plugin_id: String },
// 历史形态：覆盖安装事件只含 plugin: serde_json::Value（完整插件 JSON）
// 历史行为：install_plugin_from_kgpg 按 was_update 区分覆盖安装与首次安装，均传完整 payload
```
```ts
// 历史监听：覆盖安装事件按 { plugin: Plugin } 直接 applyPlugin(event.payload?.plugin)
```

**g. 前端 / MCP 里写死的旧路径**
```ts
// PluginProviderPanel.vue
path: `plugin://${props.pluginId}/provider`,
path: `plugin://${props.pluginId}/provider/${encodeURIComponent(name)}`,
```
```rust
// mcp_server.rs 资源说明与模板：plugin://{id}、plugin://{id}/doc、/icon、/asset/{path}、/provider、/provider/{name} ……
```

---

## 步骤 1 — `plugin://` 按来源寻址（纯重排，不改行为）

### 点 1.1 — provider 树（`providers/programmatic/plugin_resource.rs`）
- **新增**
  - 坐标类型 `PluginCoord { origin: PluginFileOrigin, id: String, version: String }`，带 `fn plugin(&self) -> Option<Arc<Plugin>>`，内部调用 `resolve_plugin_file`。
  - 根下三个过滤段 provider：
    - `installed`：list 出已安装插件 id；fetch 出全部已安装插件的 lite 行（即现在的根 rows）。
    - `byStore`：list 出 store cache 里的 sourceId；`byStore/<sourceId>` list 出该源的插件 id。
    - `byPreview`：**不可列举**（token 是凭据），只能 resolve。
  - 插件 id 层：`<…>/<id>` 的 list 只有一个子项，即当前版本号；fetch 出该插件 lite 行。
  - 版本层：`<…>/<id>/<version>` 版本不符时 `Terminal(None)`；fetch 出 lite 行；子项和现在的 `PluginEntryProvider` 相同。
- **修改**
  - `PluginEntryProvider` 及全部子资源 provider 的字段改为 `coord: PluginCoord`，读取时调用 `coord.plugin()` 现场解析。
    > 说明：runtime 按路径前缀缓存 provider。持有 `Arc<Plugin>` 会在同版本重装、卸载后读到旧数据。
  - 根 `plugin://` 的 list 改为三个过滤段。根的 fetch 保持返回已安装插件 lite 列表，MCP 的 `plugin://` 资源语义不变。
  - `provider` 子资源三种来源都有，列出插件包里声明的 provider 定义。商店来源只从 `store_plugin_cache` 取，它只包含已下载到本地的 `.kgpg`。
    **任何子资源都不得触发商店下载**（不调用 `ensure_plugin_cached`），没有缓存的插件就是 resolve 为 `None`。
- **删除**
  - 根直接 resolve `<id>` 的分支，即旧路径 `plugin://<id>/…`。不保留兼容别名。
```rust
pub struct PluginCoord { pub origin: PluginFileOrigin, pub id: String, pub version: String }
impl PluginCoord {
    fn plugin(&self) -> Option<Arc<Plugin>> {             // 新增：每次读取现场解析
        plugin_manager()?.resolve_plugin_file(&self.id, &self.origin, &self.version)
    }
}
struct PluginDocProvider { coord: PluginCoord }          // 修改：plugin_id → coord
impl Provider for PluginDocProvider {
    fn fetch_rows(..) -> .. {
        let rows = self.coord.plugin()                    // 修改：get_plugin(&self.plugin_id) → coord.plugin()
            .map(|p| read_manifest_text(&p, "kbDoc", Some("default"))) ...
    }
}
```

### 点 1.2 — 调用方（`PluginProviderPanel.vue`、`mcp_server.rs`、pathql 客户端）
- **修改**
  - `PluginProviderPanel` 的路径改为 `plugin://installed/<id>/<version>/provider[/<name>]`，版本取自已安装插件。
    组件现在只有 `pluginId` prop，需要补版本（从 `usePluginStore` 取，或由 `PluginDetailContent` 传入）。
  - `mcp_server.rs`：
    - 资源说明（约第 99–107 行）、`ResourceTemplate`（约第 767–827 行）改成 `plugin://installed/{pluginId}/{version}/…`。
    - 补一行 `byStore/{sourceId}/{pluginId}/{version}` 的说明。
    - `resource_segments` 的测试用例改成新路径。
  - 运行 `deno task pathql:generate`，`plugin` 节点的类型如有变化随之更新。
- **新增**
  - `plugin_resource.rs` 单测：
    - 三种来源都能 resolve。
    - 版本不符时为 `None`。
    - `byPreview` 列举为空。
    - `byStore` 下的 `provider` 读取的是缓存包内的定义。
    - 未缓存的商店插件 resolve 为 `None`，且不发起下载。
    - 同版本重装后，读到的是新的 `Plugin`（验证坐标现场解析，不吃缓存）。

### 点 1.3 — 文档
- **修改**
  - `cocs/mcp/MCP_SERVER.md` 的 `plugin://` 路径表。
  - `cocs/README.md` 的 Provider DSL 状态行（`plugin://` 的寻址方式）。
  - `cocs/provider-dsl/RULES.md` 如有 `plugin://<id>` 的示例，一并改。

**步骤 1 验收**：
- `cargo test -p kabegame-core plugin_resource`。
- vue-tsc 通过。
- 真机：插件详情的 PathQL tab 能列出 provider，选中后能看到 DSL 源文。
- MCP `list_pathql_entry plugin://`，再逐层展开到 `installed/<id>/<version>/doc`。

---

## 步骤 2 — 事件改为 `plugin-added / plugin-changed / plugin-deleted`，写命令推送导入态差异

### 点 2.1 — 事件定义（`ipc/events.rs`、`emitter.rs`）
- **修改**
  - 旧覆盖安装 kind → `PluginChanged`，字符串为 `"plugin-changed"`，两处映射都要改。
  - 旧覆盖安装 payload `{ plugin }` → `PluginChanged { plugin_id, changes }`。
  - 旧覆盖安装 emitter → `emit_plugin_changed(plugin_id, changes)`，web / 无 emitter 的空实现同步改。
  - `IPC_PROTOCOL_VERSION` 不升：CLI 不订阅插件事件。如果 codex 查到有订阅方，就升一版并在说明里写明。
```rust
/// 插件变更（patch 语义，与 album-changed 一致）：
/// - 覆盖安装（升级 / 同版本重装）：changes 为新的完整插件 JSON，必含 version；
/// - 推荐配置导入态变化：changes 只有 recommendedConfigs: { <path>: { imported } }。
PluginChanged {
    #[serde(rename = "pluginId")] plugin_id: String,
    changes: serde_json::Value,
},
```

### 点 2.2 — 覆盖安装（`plugin/mod.rs` `install_plugin_from_kgpg`）
- **修改**
  - `was_update` 分支改为 `emit_plugin_changed(&plugin.id, payload)`，`payload` 即原来的完整插件 JSON。
  - 更新注释，以及 `install_from_store` 等处文档注释里的旧覆盖安装事件名。

### 点 2.3 — 导入态计算抽成共享函数（`plugin/package_file.rs`）
- **新增**
  - `pub fn recommended_import_states(plugin: &Plugin, configs: &[RunConfig]) -> Vec<(String, bool)>`：
    - 对 `kbRecommendedConfigs` 每一项读文件，用 `preset_content_matches` 判断，返回 `(path, imported)`。
    - 文件读取失败、解析失败的项跳过，并打 WARN。
  - `pub fn recommended_rows(plugin: &Plugin, configs: &[RunConfig]) -> Vec<Value>`：
    - 每项一行，形态为 `content ∪ { pluginId, filename, path, isImported }`。前者只是一种取值，两者共用读文件的逻辑。
- **删除**
  - `annotate_recommended_config` 与 `annotate_with_configs`：调用方在步骤 3 删掉，相关单测迁到 `recommended_rows`。
    > 步骤 2 先保留 `annotate_recommended_config`，让它委托给新函数，步骤 3 再删。

### 点 2.4 — 运行配置写入后推送差异（`commands/task.rs`）
- **新增**
  - 辅助函数 `recommended_diff_scope(plugin_ids) -> Snapshot` 与 `emit_recommended_diff(before: Snapshot)`：
    - 写前对受影响插件取一次导入态快照，写后再算一次，有差异才发事件：
      `emit_plugin_changed(id, json!({ "recommendedConfigs": { path: { "imported": b } } }))`。
    - 受影响插件的来源：
      - 已安装插件。
      - store cache 中同 id、且本地有包文件的条目，逐个比较。
    - 事件只按 pluginId 和 path 寻址，与版本无关。
      值取已安装插件的新状态；没有已安装插件时，取任一变化项的新状态。
  - 受影响的 pluginId：
    - add / copy：新配置的 `plugin_id`。
    - update：写前读旧配置，新旧 `plugin_id` 都算。
    - delete：写前读旧配置的 `plugin_id`。
- **修改**
  - `add/update/delete/copy_run_config` 接入上述前后快照。
  - IPC handler 的 `run_configs::add/update/delete_run_config` 也经过同一组函数，不能出现漏发的入口。
    > 说明：codex 需全仓 grep `Storage::global().(add|update|delete|copy)_run_config` 的非测试调用方，确认每个都经过这组函数。
  - 事件在写库提交之后发出，并受现有 `hold()` 约束，即与 `auto-config-change` 同一批放行。

### 点 2.5 — 前端插件 store 与事件表（`stores/plugins.ts`、`services/kbEvents/events.ts`）
- **修改**
  - `stores/plugins.ts`：去掉旧覆盖安装事件监听，改为监听 `plugin-changed`：
    `changes.version !== undefined` 时，按 `{ ...previous, ...changes }` 调 `applyPlugin`；没有 version 的事件忽略。
  - 三处注释里的旧覆盖安装事件名：`PluginImportDialog.vue`、`PluginDetail.vue`、`PluginBrowser.vue`。
- **新增**
  - `KbEventMap` 增加以下三项，供步骤 3 的 `refreshOn` 使用：
    - `"plugin-added": { plugin?: Plugin }`
    - `"plugin-changed": PluginChangedPayload`
    - `"plugin-deleted": { pluginId?: string }`
```ts
export type PluginChangedPayload = {
  pluginId?: string;
  changes?: { version?: string; recommendedConfigs?: Record<string, { imported: boolean }> } & Record<string, unknown>;
};
```

**步骤 2 验收**：
- cargo test：覆盖 `recommended_import_states`，以及 add / update（换插件）/ delete 三种写入的差异发与不发。
- vitest、vue-tsc 通过。
- 真机（用 debug ingest 记录 `plugin-changed`）：
  - 导入一个推荐配置：只发一次事件，`imported: true`。
  - 修改该配置的计划时间：不发事件。
  - 删除该配置：发 `imported: false`。
  - 覆盖安装同一插件：插件 store 更新。

---

## 步骤 3 — 推荐配置改为 `plugin://…/recommended` 观察方，删除旧通路

### 点 3.1 — `recommended` 子资源（`plugin_resource.rs`）
- **新增**
  - 版本层子项 `recommended`，三种来源都有：
    - fetch：`recommended_rows(plugin, Storage::global().get_run_configs()?)`，按 `kbRecommendedConfigs` 的声明顺序返回。
    - list：每个推荐文件的 path（供 MCP 发现）。
  - `recommended/<path>` 的 fetch 返回单行（MCP 读单个文件时使用）。
    > path 含 `/` 时，按 `asset/<path>` 的现有编码规则处理。

### 点 3.2 — 前端数据源（`services/recommendedPresets.ts`、`services/pluginFiles.ts`）
- **新增**
  - `pluginResourceBase(plugin)`，`fileOrigin` 与路径的对应：
    - 没有 `fileOrigin` → `installed/<id>/<v>`。
    - store → `byStore/<sourceId>/<id>/<v>`。
    - preview → `byPreview/<token>/<id>/<v>`。
    - 每段都要 `encodeURIComponent`。
- **修改**
  - `useRecommendedPresets` 内部改为 `usePathqlLookMany({ kind: "rows", … })`，返回值 `{ entries, presets, refresh }` 不变：
    - key：`enabled` 时，每个有推荐配置的插件一个 `plugin://<base>/recommended`；否则为空。
    - 新 key 进入观察集合就请求一次（用户操作通路，与树模型的做法相同）。
    - `refreshOn(key)`：`on("plugin-changed", p => p.pluginId === id && (p.changes?.version !== undefined || p.changes?.recommendedConfigs !== undefined))`。
    - `onResult`：用 `parsePluginRecommendedPreset` 解析该插件的行，填进 `entries` 里对应 key 的位置。
    - 行还没到的占位项按 `recommendedConfigPaths` 的声明顺序发布，`preset: null`，保持现在的骨架行为。
    - `refresh()`：对当前全部 key `pathqlRequest$.next`。
    - 读取失败：保留上一份数据；没有数据时移除该插件的占位，与现在的失败处理一致。
- **删除**
  - `recommendedPresets.ts` 中的 `generation`、`timer`、`appliedSeq`、`importRevision`、`pendingSeq`、`latestImported`，
    以及 `registerRecommendedImportStates`、`subscribeRunConfigEvents` 两处调用。
  - `pluginFiles.ts` 中的 `fetchRecommendedConfig`，及其测试（`pluginFiles.test.ts` 第 63–70 行附近）。
```ts
const look = usePathqlLookMany({
  kind: "rows",
  keys: () => (enabled.value ? withPresets().map((p) => recommendedKey(p)) : []),   // 新增
  refreshOn: (key) => {
    const id = pluginIdOfKey(key);
    return [on("plugin-changed", (p) =>
      p.pluginId === id && (p.changes?.version !== undefined || p.changes?.recommendedConfigs !== undefined))];
  },
  onResult: (key, { rows }) => applyRows(key, rows),                                  // 新增：按声明顺序替换占位
  onError: (key, error) => dropIfEmpty(key, error),
});
```

### 点 3.3 — 写通路去掉 `recommended`（`services/runConfigWrites.ts`、`commands/task.rs`、Tauri / web 入口）
- **修改**
  - `run_config_write_result` 去掉 `recommended` 参数，**始终返回对象** `{ configId, reason, config, seq, view }`。
  - 单行形态改由 IPC handler 自己取 `config` 字段返回，老 CLI 客户端行为不变。
    > 说明：原来靠"两参数都没传"判断调用方，去掉 `recommended` 后，前端没有活跃视图时传 `view: null`，会误判成老调用方。
  - `writeRunConfig` 不再收集、传递 `recommended`，也不再应用 `result.recommended`。
    `view` / `holdRunConfigEvents` / `publishLocal` 保持原样，留给 C3。
- **删除**
  - 后端：`RecommendedConfigRequest`；`run_config_write_result` 中计算导入态的整段；
    Tauri 命令与 web dispatch 里的 `recommended` 参数。
  - 前端：`RecommendedConfigRequest`、`RecommendedImportState`、`PresetTarget`、`presets`、`registerRecommendedImportStates`、
    `WriteResult.recommended / recommendedSeq`。
    `recommendedConfigKey` 如果还被 `entries` 的 key 使用就保留；没有调用方就删掉。

### 点 3.4 — `/plugin_file` 恢复为纯静态文件（`plugin_file_server.rs`、`package_file.rs`）
- **删除**
  - `t=recommendedConfig` 分支、`annotate_recommended_config`、`annotate_with_configs`（单测已在 2.3 迁走）。
  - `t` 只剩下其它取值；如果 `t` 不再有任何取值，就把这个参数一并删掉，并同步 `pluginFileUrl` 的 `t` 参数。

### 点 3.5 — 测试、文档、回归
- **修改**
  - `recommendedPresets.test.ts` 改测以下几点：
    - key 按来源生成。
    - 只对本插件的 `version` / `recommendedConfigs` 事件刷新，别的插件、不相关的 changes 不刷新。
    - 新 key 加入时请求一次。
    - 失败时保留上一份。
    - `enabled=false` 时没有 key。
  - 文档：
    - `cocs/plugins/PLUGIN_FILE_ENDPOINT.md`：删掉推荐配置导入态那一节，指向 `plugin://…/recommended`。
    - `cocs/downloader-tasks/TASK_DRAWER_LOAD.md`：推荐导入态改为 `plugin-changed` 驱动。
    - `AGENTS.md`「运行配置写操作」：删掉"活跃推荐文件引用""推荐导入态"的表述。
    - `.cursor/rules/` 中提到推荐导入态的地方。
    - `cocs/README.md` 的对应条目。
  - `versions/latest/regression.md` 新增一节，`changelog.md` 加一行。

**步骤 3 验收**（真机 + debug ingest 统计 `pathql_fetch plugin://…/recommended`）：
- 自动配置页的推荐 tab 打开时，每个有推荐配置的插件读一次，不再出现 `/plugin_file?t=recommendedConfig` 请求。
- 导入一项：只有该插件的 key 重读一次，并显示"已导入"。其它插件 0 次。
- 只改某配置的计划时间：0 次。
- 插件详情弹窗：
  - 已安装插件的推荐配置正常显示。
  - 商店未安装插件的推荐配置正常显示（`byStore` 路径）。
  - 本地 `.kgpg` 预览正常显示（`byPreview` 路径）。
- 升级插件后，推荐列表换成新版本的内容，旧 key 退订。

---

### 已知边界
- `store_plugin_cache` 只包含已下载到本地的包，所以商店来源能读到的，都是缓存过的插件。没缓存的商店插件在 `plugin://byStore` 下不存在，
  前端仍按现有流程先缓存，再打开详情。
- `byPreview` 的 token 是凭据，因此不可列举。MCP 用户拿不到 token，等于预览来源只供前端使用。
- 插件 store 的初始加载仍是 `get_plugins` / `refresh_plugins` 命令，不在本计划内迁到 pathql。

### 已确认（2026-10-22）
1. 预览来源用 `byPreview/<token>`，不可列举。
2. `provider` 子资源对商店来源也开放，但只读已缓存的包，不主动发请求。
3. 推荐行沿用 `isImported`，事件 patch 用 `imported`。
4. 分三次交给 codex 执行，每次一步。

---

### 步骤 1 实施记录（2026-10-22）

本次只实施步骤 1（点 1.1、1.2、1.3）。插件资源按来源和版本寻址，资源 provider 只保存坐标，
读取时通过 `resolve_plugin_file` 重新解析本地包。根 fetch 的已安装插件 lite 列表语义保持，
根 list 只列出 `installed`、`byStore`；`byPreview` 不公开 token 或插件列表。
没有实施事件改名、推荐配置导入态或 `recommended` 子资源，也没有修改回归文档、changelog、third 源码或提交 git。

#### 点 1 — 来源树与现场解析
- **新增**
  - `src-tauri/kabegame-core/src/providers/programmatic/plugin_resource.rs`：`PluginCoord`、来源过滤层、插件 id 层与版本层。
  - `src-tauri/kabegame-core/src/plugin/package_file.rs`：只读缓存源、插件 id、当前版本的内部查询方法；预览查询只接受已知 token。
  - 同文件新增 `plugin_resource_origins_subresources_and_live_coordinates` 测试，复用现有 kgpg 夹具，验证：
    三种来源的六种子资源、根与来源的列表/lite 行、版本不符 `Terminal(None)`、预览不可列举、
    商店 provider 来自缓存包、未缓存插件/源解析为空且下载状态不变、同版本重装后读取新 Plugin、升级和卸载后旧资源为空。
- **修改**
  - 所有插件条目和子资源 provider 使用 `coord`，list / resolve / fetch 重新解析，避免 runtime 缓存旧 Plugin。
  - 所有资源只读本地包，不引入 `ensure_plugin_cached` 或网络调用。
- **删除**
  - 根按插件 id 直接 resolve 的旧路径，无兼容别名。

#### 点 2 — 调用方、协议与文档
- **新增**
  - `apps/kabegame/src/components/plugin/PluginProviderPanel.test.ts`：来源选择、各段编码、摘要和源文路径、切换后丢弃旧响应，5 个用例。
  - `.cursor/rules/plugin-resources.mdc`：固定来源、版本、现场解析、预览不可列举和禁止资源读取触发下载的约束。
- **修改**
  - `apps/kabegame/src/components/plugin/PluginProviderPanel.vue`：接收完整 Plugin，按 `fileOrigin` 构造三种来源路径；移除安装后才能查询的提示，防止旧异步响应覆盖新来源。
  - `apps/kabegame/src/components/plugin/PluginDetailContent.vue`：传递完整 Plugin，移除远程包禁止查询的限制。
  - `src-tauri/kabegame/src/mcp_server.rs`：资源说明、ResourceTemplate、资源内容解包与路径拆分测试。
  - `src-tauri/kabegame/src/mcp_capabilities.rs`：按来源坐标判定子资源权限；增加三种来源的权限测试。
  - `mcpb/kabegame-gallery-node/server/index.js`：`read_plugin` 提供 id 时必须提供 version，并构造 installed 新路径。
  - 文档：`cocs/README.md`、`cocs/mcp/MCP_SERVER.md`、`cocs/plugins/PLUGIN_ASSETS.md`、
    `apps/docs/src/content/docs/reference/mcp.md`、`mcpb/kabegame-gallery-node/README.md`、`AGENTS.md`。
  - 执行 `deno task pathql:generate`，重新生成 `packages/kabegame-pathql-client/index.ts`（80420 字节；该文件按仓库约定不入库）。

#### 与计划的出入及原因

- 面板传入完整 Plugin 并支持商店和预览，而非仅补已安装版本，遵循本次任务明确要求；来源与版本切换同时隔离在途响应。
- MCP 除说明、模板外，实际响应解包和 capability 判定也依赖旧路径段位置，必须同步迁移，否则新子资源会被误判或拒绝。
- 全仓检索发现 MCP Bundle 仍在构造旧路径，因此同步修改 Bundle 和对应说明；没有新增来源参数，Bundle 继续只查询已安装插件。
- provider 集成测试放在 `package_file.rs` 的现有测试模块，以复用 kgpg 夹具并直接设置 PluginManager 的私有缓存，
  避免为测试扩大生产 API。测试实际调用注册后的 ProviderRuntime，覆盖路径前缀缓存后的同版本重装、升级、卸载。
- `.cursor/rules/` 和 `AGENTS.md` 同步新增资源约定。`cocs/provider-dsl/RULES.md` 没有旧的仅 id 路径示例，无须改写。
- 旧路径只在本计划的现状锚点、拒绝旧路径的负例测试、历史版本说明和历史回归记录中保留；未改写历史事实或步骤 2、3。

#### 验证结果

以下两个裸 Cargo 命令均带：
`FFMPEG_PKG_CONFIG_PATH=/Users/didi/Code/kabegame/bin/macos/arm64/FFmpeg-build/install/lib/pkgconfig FFMPEG_LINK_MODE=static`。

| 实际命令 | 结果 |
| --- | --- |
| `cargo test -p kabegame-core plugin_resource` | 退出码 0；`1 passed; 0 failed`；其它集成测试被过滤。日志 `/tmp/kabegame-plugin-resource-test.log` |
| `cargo check -p kabegame` | 退出码 101；包默认 features 为空，Tauri 等可选依赖未启用，产生 390 个编译错误。日志 `/tmp/kabegame-plugin-check.log` |
| `.claude/skills/check-kabegame/driver.sh --skip vue` | 退出码 0；实际执行 `cargo check -p kabegame --features standard`，自动注入 FFmpeg / CEF 环境；cargo 0 error。日志 `/tmp/kabegame-plugin-standard-check.log` |
| 在 `apps/kabegame` 下 `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` | 最终退出码 0，无错误。首次发现模板残留 `canQuery`，删除旧提示后重跑通过。日志 `/tmp/kabegame-plugin-vue-tsc.log` |
| 在 `apps/kabegame` 下 `node ../../node_modules/vitest/vitest.mjs run` | 退出码 0；`Test Files 44 passed (44)`，`Tests 388 passed (388)`。日志 `/tmp/kabegame-plugin-vitest.log` |
| `deno task pathql:generate` | 退出码 0；CLI 增量构建和生成成功，80420 字节。日志 `/tmp/kabegame-plugin-generate.log` |
| `.claude/skills/test-kabegame/driver.sh kabegame --lib plugin_resource` | 编译成功，初次启动因测试二进制位于 `target/debug/deps`，相对 framework 目录缺失而退出 101；随后通过环境变量执行同一测试二进制，见下行。日志 `/tmp/kabegame-plugin-mcp-test.log` |
| `DYLD_FRAMEWORK_PATH=/Users/didi/Code/kabegame/bin/macos/arm64/cef-build target/debug/deps/kabegame-f5da4861d2c364ad plugin_resource` | 退出码 0；MCP 三种来源权限测试 `1 passed; 0 failed`。日志 `/tmp/kabegame-plugin-mcp-test-runtime.log` |
| 同一测试二进制、同一 framework 环境，过滤 `resource_segments` | 退出码 0；新路径拆分和转义测试 `2 passed; 0 failed`。日志 `/tmp/kabegame-plugin-mcp-segments-test.log` |
| 修改的 Vue/TS 文件 Prettier check、Bundle `node --check` 与 `check-manifest.js`、`git diff --check` | 全部通过。Rust 仅对改过的四个 `.rs` 文件执行 `rustfmt --edition 2021`，没有运行 cargo fmt |
| `.claude/skills/kabegame-chromium/driver.sh status` | Vite 无应答、CDP 未发现；当前没有可连接实例，插件详情 PathQL tab 与在线 MCP 逐层展开的真机验收未执行 |

### 步骤 1 复核与真机验收（2026-10-22，macOS CEF dev）
- 复核修正：
  - `asset` / `provider` 根节点各自重复解析了一次插件，已合并为一次。
  - 删除已经没有引用的 i18n key `plugins.detail.providerInstallFirst`（5 种语言）。
- 自动化：
  - core `plugin_resource` 1 passed。
  - kabegame MCP 相关 4 + 10 passed（需要 `DYLD_FRAMEWORK_PATH=bin/macos/arm64/cef-build`）。
  - vue-tsc 0 error，Vitest 44 个文件 / 388 项通过，check-kabegame 0 error。
- 真机（经 CDP 直接调用 `pathql_list` / `pathql_fetch`）：
  - `plugin://` 列出 `installed`、`byStore`。
  - `installed` 列出 33 个已安装插件；`byStore/official_github_release` 只列出 4 个已缓存的包。
  - `installed/pixiv` 只有 1.5.2 一个版本，`byStore/…/pixiv` 只有 1.2.11 一个版本，两者的 provider 集合不同，说明确实按版本读取。
  - 旧路径 `plugin://konachan`、错误版本、未缓存的商店插件 `byStore/…/konachan` 都返回 path not found。
- 真机界面：
  - 已安装 pixiv 1.5.2 的详情 PathQL tab 列出 3 个 provider，详情正常。
  - 商店远程详情 anime-pictures 0.7.0（`mode=remote`）的 PathQL tab 改走 `byStore/official_github_release/anime-pictures/0.7.0`，列出 5 个 provider；改动前这里显示的是"安装后可查看"。
  - 同版本的 provider 定义，在已安装与商店缓存两处逐字段一致。
- 未测：`byPreview`（本地 `.kgpg` 导入预览）的界面，MCP 客户端实际连接。


### 步骤 2 实施记录（2026-10-22）

本次只实施步骤 2（点 2.1–2.5）。覆盖安装与推荐导入态统一通过 `plugin-changed { pluginId, changes }` 推送；
推荐导入态由 core 共享运行配置写命令比较写前、写后快照，按插件合并实际变化的路径。
每个来源独立匹配，读取只涉及已安装包和本地存在包文件的商店缓存；优先采用已安装来源的新状态，
若已安装来源没有该路径可用状态则回落到变化项的新状态。事件进入既有 hold 队列，与配置事件同批放行。
步骤 1 的来源资源树和未提交成果保留，步骤 3 尚未实施。

#### 点 1 — 事件与覆盖安装
- **修改**
  - `src-tauri/kabegame-core/src/ipc/events.rs`：`PluginChanged` kind、事件名双向映射、`pluginId` / `changes` 序列化与路由；新增 patch 序列化及往返单测。
  - `src-tauri/kabegame-core/src/emitter.rs`：`emit_plugin_changed(plugin_id, changes)` 及无 ipc-server 的空实现；真实实现走 `dispatch_view_event`，受现有 hold 约束。
    Web 没有独立的插件 emitter，复用该实现；startup 按 `AppEventKind::ALL` 监听并将 kind 名转发到 SSE / Tauri，无额外事件表需要改。
  - `src-tauri/kabegame-core/src/plugin/mod.rs`：覆盖安装使用新事件，changes 直接取完整 Plugin JSON（必含 version）；首次安装保持新增事件。
- **删除**
  - 旧覆盖安装事件名、旧 kind 和旧 emitter，不保留兼容别名。
- **协议确认**
  - `kabegame-cli/src/backend.rs::subscribe_task_events` 只订阅 `TaskLog` / `TasksChange`。
    core IPC 客户端提供按 kind 订阅的通用 API，没有插件专用订阅调用方；CLI 其它调用不订阅插件事件。
    因此 `IPC_PROTOCOL_VERSION` 保持 3。

#### 点 2 — 推荐计算与写后差异
- **新增**
  - `src-tauri/kabegame-core/src/plugin/package_file.rs`：`recommended_import_states`、`recommended_rows`、共用的文件读取与匹配函数、只枚举本地来源的 `recommended_diff_plugins`。
    读取/解析失败或缺失的文件打 WARN 并跳过，行保持声明顺序，宿主覆盖身份、path 和导入态。
  - `src-tauri/kabegame-core/src/commands/task.rs`：写前来源快照、写后快照、纯函数 `recommended_import_changes` 与发送函数；
    pluginId 去重、多来源变化路径合并，每个插件最多一条事件。
  - 测试：推荐文件两个投影、可信身份覆盖与空配置状态、坏文件/缺文件跳过、本地缓存范围；
    纯差异函数覆盖 add 的新增匹配/重复或不匹配、update 换插件双侧变化/名称与定时字段不变、
    delete 最后匹配删除/仍有重复配置不变、多来源合并/已安装状态优先/仅商店来源。
- **修改**
  - 四个共享写命令在 Storage 成功提交后计算并发送差异；add 取新插件，update 先读旧配置并取新旧插件，delete 先读旧插件，copy 先读源配置确定新配置的插件。
  - 旧 `annotate_recommended_config` / `annotate_with_configs` 保留，通过新增的 `recommended_is_imported` 共用匹配逻辑，旧 HTTP 字段形态不变。

#### 写入口逐项审计

全仓检索 `.add_run_config(` / `.update_run_config(` / `.delete_run_config(` / `.copy_run_config(` 及同名函数调用：

| 入口 | 实际通路 | 确认 |
| --- | --- | --- |
| Tauri `src-tauri/kabegame/src/commands/task.rs` | add / update / delete / copy → core 同名命令 | 四项均经过前后快照与差异发送，包装无需修改 |
| Web JSON-RPC `src-tauri/kabegame/src/web/dispatch.rs` | 四个注册分支 → core 同名命令 | 四项均覆盖，推荐参数保持 |
| app IPC `src-tauri/kabegame/src/ipc/handlers/storage/mod.rs` | StorageAdd/Update/DeleteRunConfig → 同目录 `run_configs.rs` → core 同名命令（None, None） | 三项均覆盖，仍返回旧单行/null；IPC 无 copy 请求 |
| core `commands/task.rs::add_run_config` | 唯一生产 `Storage::global().add_run_config` 调用 | 已接入 |
| core `commands/task.rs::update_run_config` | 唯一生产 `Storage::global().update_run_config` 调用 | 已接入 |
| core `commands/task.rs::delete_run_config` | 唯一生产 `Storage::global().delete_run_config` 调用 | 已接入 |
| core `commands/task.rs::copy_run_config` | 唯一生产 `Storage::global().copy_run_config` 调用 | 已接入 |
| `storage/run_configs.rs` 与 `storage/albums.rs` 的其余同名调用 | 单测夹具与存储测试 | 非生产入口，不加事件 |

另外检查了直接 SQL 与专用 setter：scheduler 只写 schedule 时间，画册删除只清 output_album_id，
迁移只迁移字段；这些字段不参与推荐匹配，无需导入态事件。没有发现其它增删或修改推荐匹配字段的运行配置生产写入口。

#### 点 3 — 前端、规则与文档
- **新增**
  - `apps/kabegame/src/services/kbEvents/events.ts`：三个插件事件及导出类型 `PluginChangedPayload`。
  - `apps/kabegame/src/stores/plugins.test.ts`：3 项测试，覆盖含 version 的合并、无 version 忽略、未知插件补入及同版本重装。
- **修改**
  - `apps/kabegame/src/stores/plugins.ts`：监听变更 patch，仅在 version 存在时合并并 applyPlugin。
  - `PluginImportDialog.vue`、`PluginDetail.vue`、`PluginBrowser.vue` 的事件注释；另将 `stores/pluginMarket.ts`、
    `composables/usePluginActionState.ts` 中简写的旧事件名同步为三个完整事件名。
  - `cocs/plugins/PLUGIN_FILE_ENDPOINT.md`、`cocs/plugins/PLUGIN_STORE_CACHE.md`、`cocs/downloader-tasks/TASK_DRAWER_LOAD.md`、
    `cocs/README.md`、`.cursor/rules/plugin-resources.mdc`、`AGENTS.md`：记录新事件、范围、差异与 hold 行为，并明确旧推荐通路仍保留。
  - `.claude/plans/tree-panel-refactor.md` 的旧事件文字；本计划历史锚点改用描述保留旧 payload 事实，清除已退役标识符字面量，避免全仓检索残留。
- **事件源确认**
  - `kbEvents/eventSource.ts::kbEvent$` 按传入事件名注册 `listen`，无需静态登记名单。
    `api/web.ts` 同样动态注册 SSE 事件；Tauri / SSE 都可接收这三个事件。

#### 与计划的出入及原因

- 写命令依赖全局 Storage / PluginManager / Scheduler 与视图查询运行时，因此按任务允许的替代方案对前后快照求差做纯函数单测，
  并单独验证真实 ZIP 读取与来源选择；不把这些测试标成真实写命令端到端或真机验收。
- `annotate_*` 未删除，也未改为重新读取全清单后再挑单项：继续使用 HTTP 已读出的 JSON，并委托给新共用匹配函数，保持旧响应形态且避免重复读取。
- 写后读取配置失败时 WARN 并跳过附带事件，避免将已经提交的写操作报告为失败；写前快照失败仍返回错误，不执行写库。
- 商店存在已安装版本未声明或无法读取的路径时，无法取得已安装状态，采用实际变化来源的新状态，避免丢失商店独有路径。
- 新事件必须受 hold 约束，因此 emitter 改走现有 `dispatch_view_event`；hold 的机制、边界和生命周期本身未改。
- 未修改 `useRecommendedPresets`、`recommended` / `recommendedSeq` 参数与返回值、`/plugin_file?t=recommendedConfig`、
  `view` 或写命令的 hold 生命周期；未加 `recommended` 子资源，未写回归/changelog，未改 third，未提交 git。

#### 验证结果

裸 Cargo 命令均带：
`FFMPEG_PKG_CONFIG_PATH=/Users/didi/Code/kabegame/bin/macos/arm64/FFmpeg-build/install/lib/pkgconfig FFMPEG_LINK_MODE=static`。

| 实际命令 | 结果 |
| --- | --- |
| `cargo test -p kabegame-core recommended` | 退出码 0；6 passed / 0 failed；日志 `/tmp/kabegame-step2-core-recommended.log` |
| `.claude/skills/test-kabegame/driver.sh kabegame-core --lib package_file` | 退出码 0；实际 `cargo test -p kabegame-core --lib package_file`，9 passed / 0 failed，含旧 annotate 与步骤 1 来源回归；日志 `/tmp/kabegame-step2-test-package-file.log` |
| `cargo test -p kabegame-core plugin_changed` | 退出码 0；1 passed / 0 failed；日志 `/tmp/kabegame-step2-test-event.log` |
| `cargo check -p kabegame` | 退出码 101；默认 features 为空，Tauri 可选依赖未启用，390 个错误，与步骤 1 记录相同；日志 `/tmp/kabegame-step2-check-default.log` |
| `.claude/skills/check-kabegame/driver.sh --skip vue` | 退出码 0；实际 `cargo check -p kabegame --features standard`，0 error；日志 `/tmp/kabegame-step2-check-standard.log` |
| `cargo check -p kabegame --no-default-features --features web` | 退出码 0；日志 `/tmp/kabegame-step2-check-web.log` |
| 在 `apps/kabegame` 下 `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` | 退出码 0；0 error；日志 `/tmp/kabegame-step2-vue-tsc.log` |
| 在 `apps/kabegame` 下 `node ../../node_modules/vitest/vitest.mjs run` | 退出码 0；45 文件 / 391 测试全部通过（新增 store 3 项）；日志 `/tmp/kabegame-step2-vitest.log` |
| 修改的前端文件 Prettier、`git diff --check`、旧事件名全仓检索 | 全部通过；旧事件名、旧 Rust kind/emitter 与旧简写均 0 匹配 |
| `.claude/skills/kabegame-chromium/driver.sh status` | Vite 无应答、CDP 未发现；没有可连接的真机实例，导入/只改计划时间/删除/覆盖安装的 debug ingest 真机验收未执行 |

本次无需运行 kabegame crate 测试二进制；所有新增 Rust 测试在 core。Rust 仅对改动的 `.rs` 文件执行 `rustfmt --edition 2021`，
未执行 `cargo fmt -p`；已撤销 rustfmt 递归引入的 `plugin/v8/ops.rs` 无关换行。

#### 工作评价

共用读取、匹配与差异合并减少了重复语义，写入口集中保证各协议行为一致；前端对完整插件与导入态 patch 的职责明确。
每次相关写入新增两次本地导入态计算及 ZIP 读取，没有网络开销；尚未测量耗时。步骤 2 保留的旧推荐通路会在步骤 3 统一迁移，
当前推荐 UI 行为维持原通路；真机事件次数和最终 UI 效果尚待运行实例验收。

### 步骤 2 复核与真机验收（2026-10-22，macOS CEF dev）

复核：diff 与计划一致；`emit_plugin_changed` 走 `dispatch_view_event`，覆盖安装不在 hold 内，照常立即广播。
写入口审计、`IPC_PROTOCOL_VERSION` 保持 3 的结论核对无误。子模块
（`kabegame-plugin-sdk` / `kabegame-types` / `src-crawler-plugins`）的脏改动是 10-19、10-20 已存在的，与本步无关。

真机（前端 `plugin-changed` 监听处临时 debug ingest 插桩，session `step2-plugin`，验完已删）：

| case | 操作 | 观测 | 结论 |
| --- | --- | --- | --- |
| 导入推荐 | 自动配置页「插件推荐」点 anihonet「每日手机排行」导入 | 1 条：`anihonet-wallpaper` / `configs/every-day-mob.json` → `imported: true` | ✅ |
| 改计划时间 | `update_run_config` 改 `scheduleSpec` 20:00→21:30 并改名 | 0 条 | ✅ |
| 改匹配字段 | `userConfig.end_page` 5→6，再改回 5 | 2 条：先 `false`，后 `true` | ✅ |
| 删除 | `delete_run_config` | 1 条：`imported: false` | ✅ |
| 覆盖安装 | 拷贝 `e-shuushuu.kgpg` 到临时目录后 `import_plugin_from_zip` | 1 条：`changes` 为完整插件 JSON（含 `version: 0.3.3`），插件 store 中版本一致 | ✅ |

测试配置已删除，运行配置总数回到 5，无残留数据。直接调命令不带 `recommended` 参数，推荐卡片的导入态仍走旧通路，
不随事件刷新；这是步骤 3 要替换的部分，本步不验。


### 步骤 3 实施记录（2026-10-22）

推荐配置已收敛到按来源、插件和版本区分的 `plugin://…/recommended` rows 数据源。
后端读取时现场解析 `PluginCoord`，一次读取运行配置后调用步骤 2 的 `recommended_rows`；
前端由 `usePathqlLookMany` 观察结果，新 key 和手动刷新经 `pathqlRequest$` 发请求，
导入态只由相关插件的 `plugin-changed` 触发核心刷新。旧 HTTP 标注、写响应导入态及专用序号协调均已删除。
步骤 1、2 的未提交成果保留；`view`、`holdRunConfigEvents`、`publishLocal` 和后端 `hold()` 的机制与生命周期未改。

#### 点 1 — 推荐子资源与 MCP（3.1）
- **新增**
  - `src-tauri/kabegame-core/src/providers/programmatic/plugin_resource.rs`：版本层 recommended 子项与坐标型 provider。
    目录 fetch 返回清单顺序的行，list 列出声明 path，单项 fetch 按完整 path 筛选单行；路径与 asset 共用单段转义规则。
  - `src-tauri/kabegame/src/mcp_capabilities.rs`：`plugin.read.recommended` 能力及三种来源、目录/单项的能力判定测试。
  - `src-tauri/kabegame/src/mcp_server.rs`：目录与单项模板、资源解包、三种来源含斜杠路径的传输层转义测试。
  - `packages/kabegame-i18n/src/locales/{zh,zhtw,en,ja,ko}/mcp.json`：新能力的设置文案。
- **修改**
  - `src-tauri/kabegame-core/src/plugin/package_file.rs`：扩展步骤 1 的真实 runtime 测试，子项断言加入 recommended，
    三种来源均验证 fetch / list / 单项；升级后缓存中的目录与单项均为空，目录列表为空。
    推荐行的身份与匹配测试沿用步骤 2 的 `recommended_rows_and_import_states_share_content_and_skip_broken_files`。
  - `mcpb/kabegame-gallery-node/server/index.js`：资源清单、工具 schema 和分发加入 recommended；可选 key 读单文件，
    先做 PathQL 引擎转义，再 URI 编码。Bundle 保持仅访问 installed 的原有范围。
  - 商店所有子资源继续只读本地缓存，不引入下载或网络调用。

#### 点 2 — 前端观察方与调用方（3.2）
- **新增**
  - `apps/kabegame/src/services/pluginFiles.ts`：共享 `pluginResourceBase`，各坐标段独立 encodeURIComponent。
- **修改**
  - `apps/kabegame/src/components/plugin/PluginProviderPanel.vue`：resourceBase 复用共享函数，删除面板内的重复寻址计算。
  - `apps/kabegame/src/services/recommendedPresets.ts`：保留 `{ entries, presets, refresh }`，内部改为 rows 观察方。
    按 key 保留已落地行，按声明 path 排序和占位，首次失败移除骨架，已有内容失败时保留；enabled=false 无 key。
    过滤器仅接受同 pluginId 且 changes 含 version 或 recommendedConfigs 的事件；新 key 请求一次，已有 key 不重复请求。
  - `apps/kabegame/src/services/recommendedPresets.test.ts`：使用真实 kbEvents 核心和 usePathqlLookMany，mock 查询/事件边界，
    覆盖三来源编码、声明顺序、增量 key 请求、禁用、事件相关性、失败保留/恢复、旧版本退订与晚到响应、筛选/facet。
  - `apps/kabegame/src/services/pluginFiles.test.ts`：删除旧动态推荐 HTTP 测试，保留文本缓存与语言/生命周期测试。
- **删除**
  - 推荐专用 generation / timer / 导入态序号、注册回调、运行配置事件订阅与动态 HTTP 读取函数。
  - 旧的推荐项 key 工具已无调用方，随写通路删除；entry key 直接使用来源版本路径加编码后的完整推荐 path。
- **调用方审计**
  - `AutoConfigs.vue` 直接使用 useRecommendedPresets，保持推荐 tab 启用条件。
  - 插件详情和收集对话框均经 `PluginConfigPanel.vue` 使用同一 composable，并传递原 Plugin（含 fileOrigin）。
    已安装、商店缓存、kgpg 预览都由共享函数选取来源；不再存在其它推荐文件读取通路。
  - `stores/crawler.ts::parsePluginRecommendedPreset` 保持原样，继续解析宿主覆盖的 filename / pluginId / isImported，
    并使用当前来源插件的 baseUrl 回落。上述调用方无需修改。

#### 点 3 — 写结果与静态 HTTP（3.3–3.4）
- **修改**
  - `src-tauri/kabegame-core/src/commands/task.rs`：四个写命令及 run_config_write_result 删除推荐参数，
    始终返回 `{ configId, reason, config, seq, view }`；新增无 view 时对象形态的单行/null 测试。
  - `src-tauri/kabegame/src/commands/task.rs`、`src-tauri/kabegame/src/web/dispatch.rs`：薄包装删除推荐参数。
  - `src-tauri/kabegame/src/ipc/handlers/storage/run_configs.rs`：add/update 从共享结果取 config，delete 保持旧 null；
    新增 IPC 包装函数测试，验证单行/null 不泄漏外层对象。测试针对响应适配层，不声称是真实写库端到端测试。
  - `apps/kabegame/src/services/runConfigWrites.ts` 及其测试：去除推荐目标收集与导入态回填；
    行视图应用、holdRunConfigEvents / publishLocal / finally release 原样保留；补无活跃 view 时对象响应测试。
  - `src-tauri/kabegame/src/plugin_file_server.rs`、`src-tauri/kabegame-core/src/plugin/package_file.rs`：HTTP 恢复纯静态，
    recommended_rows 内直接构造可信行；匹配逻辑继续共用。旧标注测试已由步骤 2 的推荐行测试覆盖。
  - `apps/kabegame/src/utils/fileUrl.ts` 及 `.test.ts`：移除不再有取值的 t 参数。
- **删除**
  - 前后端旧推荐请求/状态类型、写结果推荐字段、注册与专用序号处理，HTTP 动态分支与 annotate 函数。
- **CLI / IPC 审计**
  - core IpcClient 的 storage_add/update_run_config 继续以 request_data 接收单行 JSON，delete 仍用 request_ok；
    CLI 没有直接调用共享运行配置写命令的新对象返回。IPC 适配层保持旧数据形态，因此客户端解析不受影响。

#### 点 4 — 文档、规则与统一回归（3.5）
- **修改**
  - `cocs/plugins/PLUGIN_FILE_ENDPOINT.md`、`cocs/plugins/PLUGIN_STORE_CACHE.md`、
    `cocs/downloader-tasks/TASK_DRAWER_LOAD.md`：静态 HTTP、来源推荐行、事件观察刷新和写响应边界。
  - `AGENTS.md`、`.cursor/rules/plugin-resources.mdc`、`.cursor/rules/view-mutation.mdc`：同步最终契约，去除步骤 2 过渡表述。
  - `cocs/README.md`、`cocs/mcp/MCP_SERVER.md`、`apps/docs/src/content/docs/reference/mcp.md`、
    `mcpb/kabegame-gallery-node/README.md`：索引、MCP 推荐资源与 Bundle 清单。
  - `versions/latest/regression.md`：步骤 1–3 统一一节，新增 case 均为 [ ]，留给用户真机验收；未改写既有验收事实。
  - `versions/latest/changelog.md`：更新推荐读取/刷新描述，补三来源资源路径、插件事件与 MCP 变化。
  - 本计划仅追加本记录；历史锚点、步骤 1/2 记录与真机验收保留。

#### 与计划的出入及原因

- 采用 usePathqlLookMany 的实际 `onResult(key, { rows })` / `onError` 签名，观察方先同步注册，再同步 watch 新 key 请求。
  没有复制伪代码中的不存在的接口，也没有加入推荐专用等待或序号系统。
- 新增独立 MCP 读能力，同时补主仓库 i18n 设置文案，确保权限设置可以识别和命名新资源。
- MCP Bundle 新推荐文件路径使用引擎转义加 URI 编码，原因是 MCP 入口只剥 URI 传输层，单纯编码 `/` 无法表达段内斜杠。
- 额外同步 `PLUGIN_STORE_CACHE.md`、公开 MCP 文档及 Bundle README，避免保留过渡契约与遗漏资源清单。
- IPC 使用小型响应适配函数并测其数据形态；没有为依赖全局调度/存储运行时的真实写命令新增端到端夹具。

#### 验证结果

以下裸 Cargo 命令均带：
`FFMPEG_PKG_CONFIG_PATH=/Users/didi/Code/kabegame/bin/macos/arm64/FFmpeg-build/install/lib/pkgconfig FFMPEG_LINK_MODE=static`。
主应用测试二进制直接运行时带：
`DYLD_FRAMEWORK_PATH=/Users/didi/Code/kabegame/bin/macos/arm64/cef-build`。
各过滤集存在重复覆盖，下面逐命令统计，不累加为唯一测试总数。

| 实际命令 | 结果 |
| --- | --- |
| `cargo test -p kabegame-core plugin_resource` | 退出码 0；1 passed / 0 failed；`/tmp/kabegame-step3-core-plugin_resource.log` |
| `cargo test -p kabegame-core package_file` | 退出码 0；8 passed / 0 failed；`/tmp/kabegame-step3-core-package_file.log` |
| `cargo test -p kabegame-core recommended` | 退出码 0；6 passed / 0 failed；`/tmp/kabegame-step3-core-recommended.log` |
| `cargo test -p kabegame-core run_config` | 退出码 0；lib 7 + dsl_e2e 2 passed / 0 failed；含始终返回对象测试；`/tmp/kabegame-step3-core-run_config.log` |
| `cargo test -p kabegame-core plugin_changed` | 退出码 0；1 passed / 0 failed；`/tmp/kabegame-step3-core-plugin_changed.log` |
| `.claude/skills/test-kabegame/driver.sh kabegame --lib plugin_resource` | 编译成功；启动时 framework 相对目录缺失，退出码 101；外层设置的 DYLD 环境在驱动进程链中被剥掉。改为直接带环境运行测试二进制，见下四行；`/tmp/kabegame-step3-app-plugin-resource.log` |
| `target/debug/deps/kabegame-f5da4861d2c364ad plugin_resource` | 退出码 0；2 passed / 0 failed；三来源权限与推荐路径编码；`/tmp/kabegame-step3-app-plugin_resource.log` |
| 同一二进制 `resource_segments` | 退出码 0；2 passed / 0 failed；`/tmp/kabegame-step3-app-resource_segments.log` |
| 同一二进制 `normalize_mcp_uri_path` | 退出码 0；4 passed / 0 failed；`/tmp/kabegame-step3-app-normalize_mcp_uri_path.log` |
| 同一二进制 `ipc_run_config` | 退出码 0；1 passed / 0 failed；旧单行/null 返回；`/tmp/kabegame-step3-app-ipc_run_config.log` |
| `.claude/skills/check-kabegame/driver.sh` | 退出码 0；standard，vue-tsc 0 error / cargo 0 error；`/tmp/kabegame-step3-check-standard.log` |
| `cargo check -p kabegame --no-default-features --features web` | 退出码 0；`/tmp/kabegame-step3-web.log` |
| `cargo check -p kabegame-cli` | 退出码 0；`/tmp/kabegame-step3-cli.log` |
| 在 apps/kabegame 下 `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit` | 最终退出码 0；0 error；首轮发现 Map key 模板类型推断和旧 URL 测试第三参数，修正后通过；`/tmp/kabegame-step3-vue-tsc.log` |
| 在 apps/kabegame 下 `node ../../node_modules/vitest/vitest.mjs run` | 退出码 0；45 文件 / 393 测试全部通过，含推荐观察方 6 项、provider 面板 5 项；`/tmp/kabegame-step3-vitest.log` |
| `deno task pathql:generate` | 退出码 0；80420 字节，生成物按约定不入库；`/tmp/kabegame-step3-pathql-generate.log` |
| 修改的前端文件与 MCP 文案 Prettier check、Bundle node --check / check-manifest.js、git diff --check | 全部通过 |

收尾检索：旧推荐序号/类型/注册函数/动态读取/标注函数、旧 t 值在非历史代码、规则和文档中均 0 匹配；
合法的 recommendedConfigs 事件字段、清单字段和 recommendedConfigPaths 不属于旧 t 值。
仅保留本计划与既有历史记录里的旧机制说明，便于理解迁移过程。
Rust 仅对本步修改的 9 个 .rs 文件逐文件 rustfmt --edition 2021；未用 cargo fmt，
`plugin/v8/ops.rs` 与开工快照逐字一致；复核步骤 1/2 原始 diff，没有引入无关格式变更。
未改 third 或独立子模块源码，未提交 git；依用户要求未做真机操作，新增回归 case 均未勾选。

#### 工作评价

- **优点**：推荐读通路和事件刷新统一到现有核心，来源与版本隔离由 key 表达，移除两套导入态通路的序号协调。
- **性能**：事件只刷新相关插件，一次插件推荐行读取只查一次运行配置；没有新增网络读取。未做真机耗时量化。
- **可维护性与体验**：共享来源基址避免面板与推荐寻址分叉；失败和在途刷新保留内容，升级退订旧 key。自动化已验证，界面由用户验收。
- **保留范围**：运行配置行仍沿用 view / hold / 本地发布机制，留待 C3；本次没有引入新的并行推荐缓存或专用序号系统。

### 步骤 3 复核与真机验收（2026-10-22，macOS CEF dev）

复核：`useRecommendedPresets` 先注册 `usePathqlLookMany` 观察方，再用同步 watch 对新 key 发一次 `pathqlRequest$`；
`refreshOn` 只认本插件含 `version` / `recommendedConfigs` 的 `plugin-changed`；IPC handler 用 `run_config_response` 取 `config`，
保持旧单行；`/plugin_file` 已无 `t` 参数。`PluginProviderPanel` 复用 `pluginResourceBase`。

真机（`pathqlFetch` 处临时插桩，只记含 `/recommended` 的路径，session `step3-rec`，验完已删）：

| case | 观测 | 结论 |
| --- | --- | --- |
| 自动配置页停在「我的配置」 | 0 次 | ✅ |
| 切到「插件推荐」 | 12 个插件各 1 次，全部 `plugin://installed/<id>/<v>/recommended` | ✅ |
| 导入 anihonet「每日手机排行」 | 仅 anihonet 1 次；「导入」按钮 42→41 | ✅ |
| 只改计划时间 | 0 次 | ✅ |
| 删除该配置 | 仅 anihonet 1 次；按钮回到 42，配置数回到 5 | ✅ |
| 已安装 pixiv 详情配置 tab | `installed/pixiv/1.5.2/recommended` 1 次，显示 9 项 | ✅ |
| 商店 anime-pictures 0.7.0 详情 | `byStore/official_github_release/anime-pictures/0.7.0/recommended` 1 次，显示 5 项 | ✅ |
| 本地 konachan.kgpg 预览（`app-import-plugin` 事件打开导入对话框） | `byPreview/<token>/konachan/1.7.4/recommended` 1 次，显示 2 项 | ✅ |
| 推荐 tab 打开时覆盖安装 konachan | 仅 konachan 1 次 | ✅ |

未测：真实升级换 key / 退订旧 key、卸载、读取失败与竞态、Android / Web、MCP 客户端、CLI 实际调用。
`/plugins/pixiv?mode=remote&source=official_github_release&version=1.2.11` 停在骨架屏：加载器 `usePluginDetailLoader` 三步均未改动，
URL 版本与商店当前版本不符，属原有行为，不在本计划内。回归文档已按上表勾选完全验证的 case，部分验证的在备注写明。
