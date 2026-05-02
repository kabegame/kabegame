# 插件 Providers 打包、解析与显式注册计划

## Summary

`.kgpg` 解析只负责发现和解析插件内的 provider，不产生全局副作用。实际注册抽象成独立函数，由明确需要启用 provider 的调用方执行，例如初始化本地插件、安装商店插件、从文件创建/导入插件等路径。这样 `parse_kgpg` 保持纯解析，注册时机由业务流程控制。

本阶段只处理 provider 资产进入 `.kgpg`、从 `.kgpg` 解析为 `ProviderDef`、显式注册到 provider registry 构建流程。`extend` 路由和 Gallery/VD 路由拆分放在 phase2。

## Key Changes

- CLI 打包 `.kgpg` 时递归包含 `providers/**/*.{json,json5}`；支持后缀列表集中维护，初始为 `json` / `json5`。
- `Plugin` 结构体增加后端字段保存解析出的 provider 定义，不暴露给前端序列化。
- `parse_kgpg` 只做：
  - 扫描 zip 内 `providers/` 目录下支持后缀文件。
  - 按 zip 路径排序读取并解析 provider DSL。
  - 按 `plugins.{plugin_id}` 自动规范化 namespace。
  - 如果缺失 `plugins.{plugin_id}.entry_provider`，生成空入口 provider。
  - 把结果放入 `Plugin.providers` 或等价内部字段。
- 新增显式注册函数，例如 `register_plugin_providers(&Plugin)` / `register_plugin_providers(plugin_id, providers)`：
  - 校验 provider namespace 不逃逸 `plugins.{plugin_id}`。
  - 原子替换该 plugin id 已注册的 provider 列表。
  - provider runtime 初始化时合并内置 providers 和已注册插件 providers。
- 调用方负责注册：
  - 本地已安装插件初始化：parse 后立即调用注册函数。
  - 安装商店插件：安装成功并 parse 后调用注册函数。
  - 从文件创建/导入插件：只有确认成为本地插件后调用注册函数。
  - 商店缓存、预览、临时读取：只 parse，不注册。
- 放宽 provider namespace 校验，允许 `plugins.anime-pictures.xxx` 这类带 hyphen 的插件 id 前缀；provider simple name 继续沿用现有规则。

## Implementation Details

### 1. Provider 文件后缀与打包

- 在 core 侧增加共享常量，建议位置：`src-tauri/kabegame-core/src/providers/dsl_loader.rs` 或新的 `providers/plugin_dsl.rs`。

```rust
pub const PROVIDER_FILE_EXTENSIONS: &[&str] = &["json", "json5"];

pub fn is_provider_file_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with("providers/")
        && PROVIDER_FILE_EXTENSIONS.iter().any(|ext| {
            normalized
                .rsplit_once('.')
                .map(|(_, got)| got.eq_ignore_ascii_case(ext))
                .unwrap_or(false)
        })
}
```

- 在 `src-tauri/kabegame-cli/src/main.rs::build_plugin_zip_bytes` 中，沿用现有 `doc_root/` / `configs/` 递归写 zip 的方式，新增 `providers/` 递归写入。
- 保持 zip 内路径为正斜杠相对路径，例如 `providers/gallery/root.json5`。
- 不要把目录项写成 provider；只写普通文件。

### 2. Plugin 数据结构

- 在 `src-tauri/kabegame-core/src/plugin/mod.rs::Plugin` 增加后端字段：

```rust
#[serde(skip)]
pub providers: Vec<PluginProviderDef>,

#[derive(Debug, Clone)]
pub struct PluginProviderDef {
    pub source_path: String,
    pub def: pathql_rs::ProviderDef,
}
```

- `source_path` 用 zip 内相对路径，方便错误信息和调试。
- 字段必须 `#[serde(skip)]`，避免前端插件列表携带 provider AST。

### 3. parse_kgpg 解析 providers

- 修改 `PluginManager::parse_kgpg` 的 spawn_blocking 返回值，增加 `provider_entries: Vec<(String, String)>`。
- 在 zip 单次遍历中加入：

```rust
} else if crate::providers::is_provider_file_path(&name) {
    let mut s = String::new();
    f.read_to_string(&mut s)
        .map_err(|e| format!("读取 provider `{}` 失败: {}", name, e))?;
    if !s.trim().is_empty() {
        provider_entries.push((name, s));
    }
}
```

- 遍历结束后按 `name` 排序，再用 `pathql_rs::Json5Loader` 解析。
- 解析错误必须带上插件 id 和 zip 内路径：

```rust
format!("解析插件 `{}` provider `{}` 失败: {}", plugin_id, path, err)
```

### 4. Namespace 规范化

- 插件 provider 对外 namespace 固定在 `plugins.{plugin_id}`。
- 建议实现一个纯函数，供 parse 和测试共用：

```rust
fn normalize_plugin_provider_def(plugin_id: &str, mut def: ProviderDef) -> Result<ProviderDef, String> {
    let base = format!("plugins.{}", plugin_id);
    match def.namespace.as_ref().map(|ns| ns.0.as_str()) {
        None | Some("") => def.namespace = Some(Namespace(base)),
        Some(ns) if ns == base || ns.starts_with(&(base.clone() + ".")) => {}
        Some(ns) if !ns.starts_with("plugins.") => {
            def.namespace = Some(Namespace(format!("{}.{}", base, ns)));
        }
        Some(ns) => return Err(format!("插件 provider namespace `{}` 不能逃逸 `{}`", ns, base)),
    }
    Ok(def)
}
```

- 上面是意图代码，实际实现时注意避免重复分配和 import。
- provider `name` 不改；入口 provider 由全限定名 `plugins.{plugin_id}.entry_provider` 判断。

### 5. 缺省入口 provider

- `parse_kgpg` 解析并规范化全部 provider 后检查是否存在：

```rust
namespace == Some("plugins.{plugin_id}") && name == "entry_provider"
```

- 若不存在，追加一个空入口 provider：

```json5
{
  "namespace": "plugins.{plugin_id}",
  "name": "entry_provider",
  "query": { "where": "1 = 0" },
  "list": {}
}
```

- 空入口必须有 `where: "1 = 0"`，避免 phase2 的 `extend` 挂载后继承上游插件图片列表。

### 6. 显式注册表

- 在 core provider 模块增加插件 provider 注册表，建议 `src-tauri/kabegame-core/src/providers/plugin_registry.rs`：

```rust
static PLUGIN_PROVIDER_DEFS: OnceLock<Mutex<HashMap<String, Vec<ProviderDef>>>> = OnceLock::new();

pub fn register_plugin_providers(plugin: &Plugin) -> Result<(), String> {
    register_plugin_provider_defs(&plugin.id, plugin.providers.iter().map(|p| p.def.clone()).collect())
}

pub fn registered_plugin_provider_defs() -> Vec<ProviderDef> {
    // 按 plugin_id、provider name 稳定排序后 clone 返回
}
```

- `register_plugin_provider_defs` 必须替换同一 plugin id 的旧列表，而不是 append。
- 注册时再次校验所有 def 的 namespace 必须落在 `plugins.{plugin_id}` 或其子 namespace。
- 商店缓存、预览、临时读取不要调用这个函数。

### 7. Runtime 初始化合并

- 在 `src-tauri/kabegame-core/src/providers/init.rs::init_runtime` 中：
  - 先 `load_dsl_into(&mut registry)` 注册内置 DSL。
  - 再遍历 `registered_plugin_provider_defs()` 注册插件 DSL。
  - 然后再 `validate_dsl(&registry)`。
- 启动顺序需要保证本地插件 cache 先初始化并注册，再首次访问 `provider_runtime()`。
  - 检查 `src-tauri/kabegame/src/startup.rs` 中 `PluginManager::init_global()` / `ensure_installed_cache_initialized()` 与 provider runtime 首次访问的顺序。
  - 如果当前启动路径会先触发 provider runtime，要调整为先初始化本地插件。

### 8. parse 调用点处理

- 以下路径 parse 后需要注册：
  - `refresh_plugins()` 中加载本地插件目录。
  - `install_plugin_from_kgpg()` 安装/覆盖目标 `.kgpg` 成功后。
  - 任何“从文件创建并成为本地插件”的路径。
- 以下路径 parse 后不得注册：
  - `init_store_plugin_cache()`。
  - `preview_import_from_kgpg()`。
  - `resolve_plugin_for_cli_run()` / `resolve_plugin_for_task_request()` 这种临时解析。
- 如果一个函数既可能解析本地插件又可能解析临时文件，不要把注册放进 `parse_kgpg`，而是在确认业务语义后显式调用。

### 9. Name 校验

- 修改 `src-tauri/pathql-rs/src/validate/names.rs` 的 namespace 校验，允许 namespace segment 内出现 `-`，但 simple name 不允许。
- 修改 `src-tauri/kabegame-core/src/providers/dsl/schema.json5`：
  - `Namespace` pattern 允许 hyphen。
  - `ProviderName` 的 namespace segments 允许 hyphen，但最后 simple name 仍保持 snake_case。
- 注意 `plugins.anime-pictures.entry_provider` 应合法，`entry-provider` 不合法。

## Registration Semantics

- `parse_kgpg` 永远不改全局 provider 表。
- 注册函数是唯一全局入口，方便审计哪些业务路径会启用插件 provider。
- 同一插件重复注册时，以最新解析结果替换旧 provider，避免安装/刷新后残留。
- v1 默认不做 runtime 热更新：如果 provider runtime 已经初始化，注册结果进入插件 provider 表，但实际查询生效以重启或下一次 runtime 初始化为准；后续需要热注册时再单独处理缓存失效和并发读写。

## Test Plan

- 打包测试：插件目录下嵌套 `providers/*.json5` 会进入 `.kgpg`。
- parse 测试：`parse_kgpg` 能解析 provider 并写入 `Plugin.providers`，但不会改变全局 provider 表。
- 缺省入口测试：无 `entry_provider` 时生成 `plugins.{plugin_id}.entry_provider`，且 `where = 1 = 0`。
- 注册测试：调用 `register_plugin_providers` 后，插件 provider 表出现 `plugins.{plugin_id}` 下的定义；重复注册会替换旧定义。
- 污染防护测试：商店缓存、预览、临时 parse 不调用注册函数时，provider 表无变化。
- 启动集成测试：本地已安装插件 parse 后显式注册，runtime 初始化后能解析到插件 provider。
- namespace 测试：允许 hyphen plugin id，拒绝逃逸到非 `plugins.{plugin_id}` 的 namespace。

建议执行：

```powershell
cargo test -p pathql-rs --features "json5 validate"
cargo test -p kabegame-core --test dsl_e2e
cargo check -p kabegame
```

## Assumptions

- 插件 provider 的公共命名空间固定为 `plugins.{plugin_id}`。
- 插件入口固定为全限定名 `plugins.{plugin_id}.entry_provider`。
- `.kgpg` 解析保持无全局副作用。
- v1 不承诺安装后立即热生效，先保证重启或下一次 runtime 初始化后稳定可用。
