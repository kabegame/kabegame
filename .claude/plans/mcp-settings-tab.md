# MCP 设置 Tab 实施计划

在 `Settings.vue` 新增 MCP tab：开关 + 端口 + 连接命令复制 + 资源/工具勾选；后端把 MCP 服务从「无条件启动」改为「读设置的可控服务」，并以宏作为资源/工具单一定义源（SSOT）供两端对齐与过滤。

## 决策回填（用户已定）

- **资源粒度**：宏定义 SSOT，展开为「大类 → 读/写子目录 → 逐个资源/工具」，每项可单独勾选；后端定义与前端勾选树同源。
- **默认状态**：`mcpEnabled` 默认 **关闭**。
- **命令展示**：Claude Code CLI + Codex + Claude Desktop(.mcpb) 三段，端口跟随设置。
- **端口占用语义**（用户原话）：
  - 启动时若开启但端口被占用 → **不启动 + 把设置改为关闭**。
  - 运行时用户手动开启但端口被占用 → **该次设置失败**（开关回弹 + 提示）。

## 平台边界

- 仅 **桌面 standalone MCP**（Windows/macOS/Linux 非 web）。
- **Android**：本就 `cfg(not(target_os = "android"))` 不编译 MCP，tab 用 `!IS_ANDROID` 隐藏。
- **web**：MCP 是 merge 进主 web router、与文件服务共用 `0.0.0.0:7490`，无法独立开关；tab 用 `!IS_WEB` 隐藏，web 端 `mcp_nest()` 合并行为**不变**，新增设置不进 `WEB_READABLE_SETTING_KEYS`。

---

## 现状锚点

### A. 端口常量 / 启动 / router（`src-tauri/kabegame/src/mcp_server.rs`）

```rust
pub const MCP_PORT: u16 = 7490;            // :19  现状：编译期常量，无运行时配置

pub fn mcp_nest() -> axum::Router {         // :717 现状：构造 /mcp router，local 与 web 共用
    let service = StreamableHttpService::new(
        || Ok(KabegameMcpServer),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new().nest_service("/mcp", service)
}

pub async fn start_mcp_server() -> Result<(), Box<dyn std::error::Error + Send + Sync>> { // :732
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", MCP_PORT)).await?; // 现状：绑固定端口，占用则 Err 上抛
    println!("  ✓ MCP server listening on 127.0.0.1:{MCP_PORT}");
    axum::serve(listener, mcp_nest()).await?;   // 现状：无 graceful shutdown，无法停止
    Ok(())
}
```

### B. 桌面启动接线（`src-tauri/kabegame/src/lib.rs:164-171`）

```rust
#[cfg(not(target_os = "android"))]
{
    #[cfg(not(feature = "web"))]
    tauri::async_runtime::spawn(async {
        if let Err(e) = mcp_server::start_mcp_server().await {
            eprintln!("Failed to start MCP server: {}", e);  // 现状：占用只打印，不降级设置、无开关判断
        }
    });
    startup::start_ipc_server(/* ... */);
}
```

### C. handler 无过滤（`mcp_server.rs`）

- `list_resources`（:207-235）硬编码 6 个 `RawResource`。
- `list_resource_templates`（:406-473）硬编码 10 个模板。
- `list_tools`（:480-560）硬编码 4 个 `Tool`。
- `read_resource`（:244+）先 `resource_scheme(&uri)?` + `resource_segments(&uri)`，再按 scheme 分支。
- `call_tool`（:568+）`match request.name.as_ref()`。
  > 现状：以上 5 处全量暴露，无任何启用/禁用判断。

### D. 设置值联合体无 Vec 变体（`src-tauri/kabegame-core/src/settings/mod.rs:144-155`）

```rust
#[serde(untagged)]
pub enum SettingValue {
    Bool(bool), U32(u32), F64(f64), String(String),
    OptionString(Option<String>),
    WindowState(WindowState), OptionWindowState(Option<WindowState>),
    HashMapStringString(HashMap<String, String>),   // 现状：集合类型只有这一个，无 Vec<String>
}
```

### E. 前端 tab 数组（`apps/kabegame/src/views/Settings.vue:337`）

```ts
const SETTINGS_TAB_NAMES = ["app", "wallpaper", "download", "plugins"] as const; // 现状：4 个 tab
```

### F. Settings migration 框架（`src-tauri/kabegame-core/src/settings/migrations/`）

```rust
// migrations/mod.rs — 现状：版本化迁移框架
type MigrationFn = fn(&mut Value) -> Result<(), String>;
const MIGRATIONS: &[Migration] = &[Migration { version: 1, name: "wallpaper_drop_system", up: v001_..::up }];
pub const LATEST_VERSION: u32 = 1;         // 现状：最新 schema 版本 = 1
pub const VERSION_KEY: &str = "schemaVersion";
pub fn run_pending(json) -> Result<bool, String> { /* 从 current 逐版本跑到 LATEST，末尾 mark_as_latest */ }
```

- 调用点 `load_settings_map`（`mod.rs:466-467`）：读 JSON 后、构建 cells 前 `migrations::run_pending(json)`；`migrated == true` 触发重新落盘（`mod.rs:482`）。
- `all_keys` 循环（`mod.rs:473-480`）对每个 key `get_value_from_json(...).unwrap_or_else(default_value)`——缺失字段自动回退默认值。
- `v001_wallpaper_drop_system.rs` 是「改值」型迁移示例（`up(json)` 直接改 JSON map）。
  > 结论：纯新增 key 机制上靠 `default_value` 即可初始化；但按「改设置走 migration」规范，仍要 bump 版本 + 追加 migration（见点 3）。**append-only：不改 v001**。

---

## 点 1 — MCP 能力宏（SSOT，两端对齐的核心）

新增文件 `src-tauri/kabegame/src/mcp/capabilities.rs`（或 `mcp_server` 拆成 `mcp/` 模块）。

- **新增**
  - 声明式宏 `mcp_capabilities! { ... }`，一次性声明所有 MCP 能力。DSL 形态草案：

    ```rust
    mcp_capabilities! {
        // 大类 Images，scheme "images://"
        Images("images") {
            read {
                Gallery  { static_uri: "images://gallery/all" },   // list_resources 里的静态资源
                Raw      { static_uri: "images://x100x/1" },
                ById     { template: "images://id_{imageId}" },    // list_resource_templates 里的模板
                Metadata { template: "images://id_{imageId}/metadata" },
            }
            write {
                RenameImage { tool: "rename_image" },
            }
        }
        Albums("albums") {
            read  { List { static_uri: "albums://all" }, ById { template: "albums://id_{albumId}" } }
            write {
                CreateAlbum        { tool: "create_album" },
                AddImagesToAlbum   { tool: "add_images_to_album" },
                SetAlbumImagesOrder{ tool: "set_album_images_order" },
            }
        }
        Tasks("tasks")               { read { List {..}, ById {..} } }
        SurfRecords("surf_records")  { read { List {..}, ById {..} } }
        Plugin("plugin") {
            read {
                List {..}, Info {..}, Icon {..}, DescriptionTemplate {..}, Doc {..}, DocResource {..}
            }
        }
    }
    ```

  - 宏展开产出：
    1. `pub struct McpCapability { pub id: &'static str, pub category: &'static str, pub kind: McpKind /*Read|Write*/, pub tool: Option<&'static str>, pub name_key: &'static str, pub desc_key: &'static str }`。
    2. 稳定字符串 id = `"{category}.{read|write}.{local}"`，如 `"images.read.gallery"`、`"albums.write.create_album"`。**id 是跨端契约，一经发布不改**。
    3. `pub fn all_mcp_capabilities() -> &'static [McpCapability]`（供导出与 list_* 过滤枚举）。
    4. `pub fn capability_for_tool(name: &str) -> Option<&'static str>`（write 过滤：tool → id）。
    5. i18n key 约定：`name_key = "mcp.cap.{id}"`、`desc_key = "mcp.cap.{id}.desc"`，由宏按 id 拼出，前端 `t(name_key)` 取文案。
  - `read_resource` 的运行时映射函数 `pub fn read_capability_id(scheme: &str, segments: &[&str]) -> Option<&'static str>`：手写映射（引用宏生成的 id 常量，保证一致），覆盖各读形态：
    - `images` + `[id_*]` → `images.read.by_id`；`[id_*, "metadata"]` → `images.read.metadata`；`gallery/...` → `images.read.gallery`；`[x{N}x, page]` → `images.read.raw`。
    - `albums/tasks/surf_records` + `all`→`*.read.list`，`[id_*]`→`*.read.by_id`。
    - `plugin` + `[]`→`plugin.read.list`，`[id]`→`plugin.read.info`，`[id,"icon"]`→`plugin.read.icon`，等。
  - `is_capability_enabled(id, &disabled_set) -> bool`：`!disabled_set.contains(id)`（默认启用，见点 3 存储选型）。

> 「两端对齐」= 宏是唯一定义源；前端**不硬编码**能力列表，通过点 4 的 `get_mcp_capabilities` 命令取宏导出的清单渲染勾选树。

---

## 点 2 — MCP 服务生命周期管理器（可启停）

新增 `src-tauri/kabegame/src/mcp/service.rs`，参照 `UpdaterService`/`OrganizeService` 单例（后端权威 + 事件驱动）。

- **新增**
  - `pub struct McpService`，全局单例 `McpService::global()`；内部状态 `Mutex`/`ArcSwap`：
    - `running: Option<RunningHandle { port: u16, shutdown: CancellationToken, join: JoinHandle<()> }>`。
  - `pub async fn start(port) -> Result<u16, McpStartError>`：
    - `TcpListener::bind(("127.0.0.1", port)).await` → 占用返回 `Err(PortInUse)`；
    - 成功后 `axum::serve(listener, mcp_nest()).with_graceful_shutdown(token.clone().cancelled_owned()).await` 放进 `spawn`，保存 handle。
  - `pub async fn stop()`：`token.cancel()` + `join.await`，清空 `running`。
  - `pub async fn restart(port)`：`stop()` 后 `start(port)`。
  - `pub fn snapshot() -> McpState { enabled, running, port }`（供命令 hydrate）。
- **修改**
  - `mcp_server.rs`：把 `mcp_nest()` 保留；`start_mcp_server()` 内联进 `McpService::start`（或保留薄封装）。`MCP_PORT` 从「唯一端口」降级为「默认端口常量」（默认值来源，见点 3）。

---

## 点 3 — 新增 3 个设置项（后端 `settings/`）

- **新增（`SettingValue` 变体，`mod.rs:144-155` + 访问器 :157-216）**
  - `SettingValue::VecString(Vec<String>)` + `fn as_vec_string(&self) -> Option<&Vec<String>>`。
- **新增（`SettingKey`，`mod.rs:74-141`）**
  - `McpEnabled`（bool）、`McpPort`（u32）、`McpDisabledCapabilities`（Vec<String>）。
    > 存**禁用集**而非启用集：能力随版本新增时默认启用，老配置不漏项；UI 呈现仍是「勾选=启用」，未勾项写入禁用集。
- **修改（同 `mod.rs` 的 6 处 exhaustive/初始化点）**
  1. `default_value()`（:296-340）：`McpEnabled→Bool(false)`、`McpPort→U32(7490)`、`McpDisabledCapabilities→VecString(vec![])`。
  2. `load_settings_map()` 的 `all_keys`（:396-430）：加 3 个 key（漏则 cell 不初始化）。
  3. `json_value_to_setting_value()`（:502-601）：bool/u32 复用现有分支；新增 array→`VecString` 解析分支。
  4. `key_to_json_string()`（:684-726，exhaustive）：`mcpEnabled` / `mcpPort` / `mcpDisabledCapabilities`。
  5. `setting_value_to_json()`（:728-758）：新增 `VecString` → `Value::Array` 分支。
  6. get/set 方法（getters :849+，setters :1091+）：`get/set_mcp_enabled`、`get/set_mcp_port`、`get/set_mcp_disabled_capabilities`；setter 写 cell + `emit_setting_change`。
     > **注意**：`set_mcp_enabled` / `set_mcp_port` 的**服务副作用不放在 core setter 里**（core 不依赖 `kabegame` crate 的 `McpService`），而放在点 4 的 tauri 命令层，先操作服务成功再落设置（见点 4、点 5 的失败语义）。
- **新增（Settings migration，落实「改设置走 migration」规范，见锚点 F）**
  - 新增 `settings/migrations/v002_mcp_settings.rs`，`up(json)` 对老用户既有 JSON **幂等补齐**三个 MCP 字段（缺失才插入，不覆盖已有值）：
    ```rust
    use serde_json::Value;
    pub fn up(json: &mut Value) -> Result<(), String> {
        let Value::Object(map) = json else { return Ok(()); };
        map.entry("mcpEnabled").or_insert(Value::Bool(false));
        map.entry("mcpPort").or_insert(Value::from(7490));
        map.entry("mcpDisabledCapabilities").or_insert(Value::Array(vec![]));
        Ok(())
    }
    ```
  - 修改 `settings/migrations/mod.rs`：加 `mod v002_mcp_settings;`；`MIGRATIONS` 追加 `Migration { version: 2, name: "mcp_settings", up: v002_mcp_settings::up }`；`LATEST_VERSION` 1 → 2。**append-only：不改 v001**。
  - 分工：`default_value()`/`all_keys`（全新用户/无文件、运行时回退）**仍必须加**；migration 负责老用户 JSON 显式补字段 + 版本推进，且作为未来值迁移的正规通道。

---

## 点 4 — Tauri 命令 + 注册 + 权限

- **新增（`src-tauri/kabegame/src/commands/settings.rs` 或新 `commands/mcp.rs`）**
  - `get_mcp_state() -> McpState`：`{ enabled, running, port }`，前端 hydrate。
  - `set_mcp_enabled(enabled: bool) -> Result<McpState, String>`：
    - `true` → `McpService::start(get_mcp_port())`：`Ok`→`Settings.set_mcp_enabled(true)` 落盘、返回 state；`Err(PortInUse)`→**不写设置**、返回 `Err`（前端回弹 + 提示端口占用）。
    - `false` → `McpService::stop()` + `set_mcp_enabled(false)`。
  - `set_mcp_port(port: u16) -> Result<McpState, String>`：
    - 若 running → `McpService::restart(port)`：`Ok`→落盘；`Err`→不写、返回 `Err`（端口回弹）。
    - 若 stopped → 仅 `Settings.set_mcp_port(port)`。
  - `set_mcp_disabled_capabilities(disabled: Vec<String>)`：仅落盘（handler 每次读最新，无需重启）。
  - `get_mcp_capabilities() -> Vec<McpCapabilityDto>`：`all_mcp_capabilities()` 导出（含 id/category/kind/name_key/desc_key），供前端渲染。
- **修改**
  - `lib.rs` 的 `generate_handler!`（Settings 段 :536-566）：登记以上 5 个命令。
  - `src-tauri/kabegame/permissions/main.toml`：为 5 个命令加 ACL 条目（漏则前端 invoke 被拒），必要时同步 `capabilities/main.json`。

---

## 点 5 — 启动接线改造（`lib.rs:164-171`）

- **修改**
  - 删除无条件 `spawn(start_mcp_server())`；替换为读设置的降级启动：

    ```rust
    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    tauri::async_runtime::spawn(async {
        if Settings::global().get_mcp_enabled() {
            let port = Settings::global().get_mcp_port();
            match McpService::global().start(port).await {
                Ok(_) => {}
                Err(_) => {
                    // 端口占用：不启动 + 落盘关闭 + 发事件让前端提示
                    Settings::global().set_mcp_enabled(false);
                    emit_mcp_state_change(/* enabled:false, running:false, reason:port_in_use */);
                }
            }
        }
    });
    ```
- **不改**：web 分支（`lib.rs:279-294`）`mcp_nest()` 合并与 `0.0.0.0:7490` 绑定保持现状。

---

## 点 6 — handler 按能力过滤（`mcp_server.rs`）

- **修改**
  - 进入过滤前读一次禁用集：`let disabled = Settings::global().get_mcp_disabled_capabilities();`
  - `list_resources`（:207-235）：为每个静态资源标注其 capability id，`is_capability_enabled` 过滤后再返回。
  - `list_resource_templates`（:406-473）：同上按模板 id 过滤。
  - `list_tools`（:480-560）：`capability_for_tool(name)` → 过滤禁用工具。
  - `read_resource`（:244+）：算出 `read_capability_id(scheme, &segments)`，若禁用返回 `McpError`（`resource_not_found` 或自定义 forbidden，附 uri）。
  - `call_tool`（:568+）：`capability_for_tool(&request.name)` 若禁用则拒绝返回错误。
    > 全部引用点 1 宏生成的 id 常量，保证与前端勾选项一致。

---

## 点 7 — 前端类型 / descriptor / store（`packages/kabegame-core/src/stores/`）

- **修改**
  - `settings.ts`：`AppSettings` 加 `mcpEnabled: boolean`、`mcpPort: number`、`mcpDisabledCapabilities: string[]`（`AppSettingKey` 自动派生）。
  - `settingsDescriptors.ts` 的 `entries`（:157-180）加：
    ```ts
    tauri("mcpEnabled", "get_mcp_enabled", "set_mcp_enabled", "enabled"),
    tauri("mcpPort", "get_mcp_port", "set_mcp_port", "port"),
    tauri("mcpDisabledCapabilities", "get_mcp_disabled_capabilities", "set_mcp_disabled_capabilities", "disabled"),
    ```
    > `mcpEnabled`/`mcpPort` 的 getter/setter 是命令层的 `set_mcp_*`（返回 Result）；开关/端口失败经由 store `save` 抛错，前端组件捕获回弹（见点 8）。若命令签名与 descriptor tauri 适配不完全吻合，则 `mcpEnabled`/`mcpPort` 改用自定义组件直接 `invoke`（更可控），descriptor 只登记 `mcpDisabledCapabilities`。**执行时二选一，倾向自定义组件直连 invoke**。

---

## 点 8 — 前端 Settings.vue tab + 组件

- **修改（`apps/kabegame/src/views/Settings.vue`）**
  - `SETTINGS_TAB_NAMES`（:337）→ `["app","wallpaper","download","plugins","mcp"]`。
  - `</StyledTabs>` 前新增 `<el-tab-pane v-if="!IS_WEB && !IS_ANDROID" :label="$t('settings.tabMcp')" :name="SETTINGS_TAB_NAMES[4]">`，内套 `el-card` + `settings-list`。
- **新增组件（`apps/kabegame/src/components/settings/items/`）**
  - `McpEnabledSetting.vue`：`el-switch` 直连 `invoke("set_mcp_enabled",{enabled})`；成功刷新状态，失败 `ElMessage.error(端口占用)` + 回弹。监听 `mcp-state-change` 事件同步（覆盖启动时降级关闭的情形）。
  - `McpPortSetting.vue`：`el-input-number`（1024–65535）；`invoke("set_mcp_port",{port})`，运行中改端口触发重启，失败回弹 + 提示。运行中给出「改端口将重启服务」说明。
  - `McpCapabilitiesSetting.vue`：`onMounted` 调 `get_mcp_capabilities` 得清单 → 组装「大类 → 读/写 → 项」三层 `el-tree`（`show-checkbox`，叶子=能力项）；勾选态 = 全集 − `mcpDisabledCapabilities`；`@check` 计算新禁用集 → `set(disabled)`。文案 `t(cap.name_key)`。
  - `McpConnectCommands.vue`（或内联）：`el-collapse` 三段命令，每段用 `CodeBlock.vue` 复制（复用 `handleCopy`）：
    - Claude Code：`claude mcp add --transport http kabegame http://127.0.0.1:{port}/mcp`
    - Codex：`~/.codex/config.toml` 片段 `[mcp_servers.kabegame]\nurl = "http://127.0.0.1:{port}/mcp"`（或对应 `codex mcp add` 命令，执行时核实 codex 当前 CLI 语法）。
    - Claude Desktop(.mcpb)：说明装 `kabegame-gallery-node.mcpb`，endpoint 环境变量 `KABEGAME_MCP_ENDPOINT=http://127.0.0.1:{port}/mcp`（桥接已支持覆盖，代码不改）。
    - `{port}` 用 `mcpPort` 的 computed 插值。

---

## 点 9 — i18n（5 语言 `packages/kabegame-i18n/src/locales/{en,zh,zhtw,ja,ko}/settings.json`）

- **新增 key（每语言同名）**
  - tab/区块：`tabMcp`、`mcpSectionTitle`。
  - 控件：`mcpEnabled`/`mcpEnabledDesc`、`mcpPort`/`mcpPortDesc`、`mcpCapabilities`/`mcpCapabilitiesDesc`。
  - 提示：`mcpPortInUse`（端口占用/开启失败）、`mcpPortRestartHint`（改端口将重启）、`mcpDisabledByPortConflict`（启动时因占用自动关闭）。
  - 命令区：`mcpConnectTitle`、`mcpConnectClaudeCode`、`mcpConnectCodex`、`mcpConnectClaudeDesktop` 及各自说明。
  - **能力项文案**：宏 id → `mcp.cap.{id}` / `mcp.cap.{id}.desc`（如 `mcp.cap.images.read.gallery`）。约 20 项 × 2。可放 `settings.json` 或新 `mcp.json` 命名空间（若新命名空间需在 `locales/*/index.ts` 注册）。
  - 复制成功/失败复用现成 `common.copySuccess`/`common.copyFailed`，不新增。

---

## 点 10 — 文档同步（可选，建议随 PR）

- **修改**
  - `apps/docs/src/content/docs/guide/mcp.md`：删掉「没有任何 UI 开关」的 note，补「设置 → MCP tab 可开关/改端口/勾选资源，默认关闭」。
  - `apps/docs/src/content/docs/reference/mcp.md`：端口不再固定 7490（默认值），补能力勾选说明。
  - `mcp-bundle.md`：endpoint 端口随设置变化的提示。
  - `mcpb/kabegame-gallery-node/server/index.js`：**不改**（已支持 `KABEGAME_MCP_ENDPOINT` 覆盖端口）。

---

## 验证

- `deno task check -c kabegame`（先 `--skip vue` 过 cargo，再 `--skip cargo` 过 vue 类型）；改动涉及运行时行为，最后需实跑桌面版验证：
  1. 默认关闭：全新配置启动，MCP 不监听 7490。
  2. 开启成功：设置里开→`http://127.0.0.1:{port}/mcp` 可连。
  3. 端口占用（先占 7490）：启动时开启项被自动改回关闭 + 前端提示；运行时手动开→失败回弹。
  4. 改端口：运行中改端口→旧端口断、新端口通。
  5. 勾选过滤：取消勾某工具/资源→MCP `list_tools`/`list_resources` 不含它，调用被拒。
- 遵循「调试跑真身」：端口占用/重启/过滤这类运行时行为不可只靠 lint。

## 委派执行

按项目惯例（大重构委派 codex CLI，git 写操作由 Claude 执行，独立验收不采信自报）：本计划确认后，实现分工可交 codex，Claude 负责 git 操作与独立验收。建议实现顺序：点 1 宏 → 点 3 设置 → 点 2 服务 → 点 4/5 命令与接线 → 点 6 过滤 → 点 7/8/9 前端 → 点 10 文档。
