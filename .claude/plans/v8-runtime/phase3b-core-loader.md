# Phase 3b — core：package.json v3 装载 + v2 兼容双轨（逐点实施方案）

> Phase 3 子阶段；总览与决策见 [phase3-overview.md](./phase3-overview.md)。
> 目标：让 `kabegame-core` 认识 v3 清单（package.json 自描述），并**导出 [3c](./phase3c-cli-packer.md)
> 依赖的共用纯函数**；v2 读取路径原样保留（决策 D10/P3-8）。
> 验证：`cargo check -p kabegame-core --lib`，不跑全量 build。

---

## 现状锚点

**a. core 清单/配置结构**（`src-tauri/kabegame-core/src/plugin/mod.rs:2387` / `mod.rs:2791`）

```rust
// 现状：PluginManifest 自定义反序列化，从扁平键提取 name/name.zh、description/...；minAppVersion 顶层
pub struct PluginManifest {
    pub name: ManifestI18nText, pub version: String, pub description: ManifestI18nText,
    pub author: String, pub min_app_version: Option<String>,   // 读 "minAppVersion"
}
// 现状：config.json = { baseUrl?, var? }
pub struct PluginConfig {
    #[serde(rename = "baseUrl", default)] pub base_url: Option<String>,
    #[serde(default)] pub var: Option<Vec<VarDefinition>>,
}
```

**b. `Plugin` 脚本存储：两个松散 Option 字段 + 前端 `script_type` 字符串**（`mod.rs:87`、`mod.rs:47`）

```rust
#[serde(rename = "scriptType")] pub script_type: String,  // 前端字段："rhai" / "js"
// ...
#[serde(skip)] pub rhai_script: Option<String>,   // crawl.rhai（仅后端）
#[serde(skip)] pub js_script: Option<String>,     // crawl.js（webview，仅后端）
// 现状：v2/v3 无区分；rhai/webview 双脚本靠两个 Option 并存；无 backend 枚举
```

**b2. 消费脚本字段的调用点**：`task_scheduler.rs` 取 `plugin.rhai_script` 执行（`~:661` 一带）；
webview 走 `js_script`。这些点在本 Phase 改为 match 新的 `PluginScript`（见点 1）。

**c. .kgpg 加载主路径：单遍扫 zip、全靠条目名约定分发**（`mod.rs:1887`–`mod.rs:2135`）

```rust
if name == "manifest.json" { /* manifest_json */ }
else if name == "config.json" { /* config_json */ }
else if name == "icon.png" { /* icon_png_bytes（头部 icon 优先） */ }
else if name == "templates/description.ejs" { /* description_template */ }
else if name == "crawl.rhai" { /* rhai_script_content */ }
else if name == "crawl.js" { script_type = "js"; /* js_script_content */ }
else if name.starts_with("configs/") && name.ends_with(".json") { /* config_presets，filename 为键 */ }
else if name.starts_with("doc_root/doc") && name.ends_with(".md") { /* doc_entries：doc.zh.md → "zh" */ }
else if name.starts_with("doc_root/") { /* doc_resource_entries：键 = doc_root 相对路径，2MB/总量限制 */ }
else if let Some(v) = metadata_migration_version_from_path(&normalized_name) { /* v{N}.rhai → (N, s) */ }
else if crate::providers::is_provider_file_path(&name) { /* provider_entries */ }
// ...
let manifest_str = manifest_json.ok_or_else(|| "manifest.json not found ...")?;  // 现状：缺失即错
```

**d. doc 资源键与前端引用同构**（`mod.rs:1973`、`mod.rs:2094`）

```rust
// 现状：doc_resources 键 = doc_root/ 相对路径；md 内引用也是同一字符串 → 前端按引用直接查表，无解析
let rel_path = name.strip_prefix("doc_root/").unwrap().to_string();
doc_resource_entries.push((rel_path, bytes));
```

**e. 头部/回退固定名读取三处**：`read_plugin_manifest_from_kgpg_file`（`mod.rs:2262`，头部槽优先、zip 回退）、
`read_plugin_manifest_from_kgpg_file_sync`（`mod.rs:2299`）、`read_plugin_config`（`mod.rs:471`）。

**f. store 包版本上限 = 2**（`mod.rs:1141`）

```rust
const MAX: u64 = 2;   // 现状：index.json packageVersion 过高按 2 clamp
```

**g. minAppVersion 已被 store 解析读取**（`mod.rs:1165`）——`resolve_store_plugin` 读 `minAppVersion` 键；
index 侧只需 3d 补写该键即可，无需 core 改动。

---

## 点 1 — v3 共用纯函数（`mod.rs`，**新增**；供 core 与 CLI 共用）

- **新增**（放 `kabegame-core::plugin`，`pub` 导出，3c 依赖）：

```rust
/// 判定 package.json 是否 v3 清单（kbPackageVersion >= 3）。
pub fn package_json_is_v3(v: &serde_json::Value) -> bool {
    v.get("kbPackageVersion").and_then(|x| x.as_u64()).unwrap_or(0) >= 3
}

/// engines.kabegame：**仅支持 `>= X.Y.Z` 语法**（`>=` 后可有可无空格）。
/// 合法：`">=4.3.0"`、`">= 4.3.0"`；其他任何写法（`^`/`~`/exact/`||`/`*` 等）→ 报错。
/// 返回值：裸三段版本字符串（即 minAppVersion），用标准库 `str::strip_prefix` +
/// `semver::Version::parse` 实现，不引入 `node-semver` crate。
pub fn normalize_engines_kabegame(raw: &str) -> Result<String, String>;

/// kb* 路径字段安全校验：插件根相对、组件级规范化、禁 ".."/绝对路径/盘符/前导 "/"（除 doc 引用另有语义）。
pub fn validate_kb_rel_path(p: &str) -> Result<(), String>;

/// package.json（v3）→ PluginManifest：name = npm name（默认显示名，P3-7）；
/// author 兼容字符串与 { "name": ... }；minAppVersion ← engines.kabegame；
/// i18n 走 extract_manifest_text_from_flat（顶层扁平键，P3-6）。
pub fn plugin_manifest_from_package_json(v: &serde_json::Value) -> Result<PluginManifest, String>;

/// package.json（v3）→ PluginConfig：base_url ← kbBaseUrl；var ← kbConfig。
pub fn plugin_config_from_package_json(v: &serde_json::Value) -> Result<Option<PluginConfig>, String>;

/// 解析一段 md 中的本地图片引用（![](...) 与 <img src>；跳过 http(s)/data:），
/// 相对引用按 md 所在目录、"/" 开头按插件根，归一化为根相对 zip 路径。
/// 返回 (归一化路径, 原引用串) 列表，供 core 装载改写 + CLI 收集共用（P3-13）。
pub fn extract_doc_local_refs(md: &str, doc_dir: &str) -> Vec<(String, String)>;
```

- **修改**（`Plugin` 脚本存储改 enum，锚点 b；**不再单独加 `v8_script`**）：
  删除 `rhai_script` / `js_script` 两个松散 Option 字段，改为单一 `#[serde(skip)] pub script: PluginScript`，
  并由 core 权威定义 backend 枚举（CLI 复用，替代 CLI 侧 `PluginBackend`）：

```rust
/// 后端枚举（core 权威定义；serde 无 clap 依赖）。kbBackend 字符串解析目标。
pub enum PluginBackend { Rhai, V8, Webview }   // FromStr: "rhai"/"v8"/"webview"

pub enum PluginScript {
    /// v2 旧包：rhai / webview(js) 双脚本历史（打包器 webview 优先但字段保留双槽）
    V2 { rhai: Option<String>, js: Option<String> },
    /// v3 新包：单脚本 + 显式后端（P3-11，一个包只一个脚本）
    V3 { backend: PluginBackend, source: String },
}
```

  - `script_type: String`（前端字段，保留）由 `script` 派生：
    V2 → 有 `js` 则 `"js"` 否则 `"rhai"`；V3 → `Rhai→"rhai"` / `V8→"v8"` / `Webview→"js"`。
  - 所有 `Plugin { .. }` 构造点改填 `script`（v2 装载路径填 `PluginScript::V2 { rhai, js }`）。
- **修改**（消费者，锚点 b2）：读 `plugin.rhai_script` / `plugin.js_script` 的调用点改为 match
  `plugin.script`；Phase 4 的 v8 分支据此 match `PluginScript::V3 { backend: V8, source }`
  （本 Phase 仅存储与派生 `script_type`，不接调度）。
  > 说明：`PluginBackend`/`PluginScript` 由 core 导出后，[3c](./phase3c-cli-packer.md) 的 CLI 用
  > core 的 `PluginBackend::from_str` 解析 `kbBackend`；CLI 保留自己的 clap `--backend` `ValueEnum`
  > 仅用于 `plugin new` 选模板，二者用 `From` 互转。

---

## 点 2 — .kgpg 加载分流：v3 装载器 + v2 原样保留（`mod.rs` 锚点 c）

- **修改**（zip 遍历循环）：**新增**捕获 `package.json` 条目（`package_json = Some(s)`）。
- **新增**（`load_plugin_v3_from_zip`）：当 zip 内 `package.json` 且 `package_json_is_v3` →
  按字段拉取条目，**不再有任何条目名约定**（P3-12）：
  - `main` + `kbBackend`：`PluginBackend::from_str(kbBackend)` + 读 `main` 条目内容 →
    `script = PluginScript::V3 { backend, source }`；`script_type` 随之派生
    （`rhai`→`"rhai"` / `v8`→`"v8"` / `webview`→`"js"`）。**不再有三种 script 槽。**
  - `kbDoc` → `doc`：键（`default`/`zh`/...）原样；值为 zip 内 md 路径。
  - **doc 资源（P3-13 引用闭包）**：对每个 kbDoc md 调 `extract_doc_local_refs` →
    1. 从 zip 取字节装 `doc_resources`，**键 = 归一化根相对路径**；
    2. **改写 md 内该引用串为同一归一化路径**。
    > 保持 v2 不变量"md 引用串 == doc_resources 键"（锚点 d），**前端零改动**；
    > 2MB 单文件 / 总量上限沿用现状常量。
  - `kbRecommendedConfigs` → `recommended_configs`（`filename` = 路径 basename，前端键语义不变）。
  - `kbPathQLProviders` → `provider_entries`（`source_path` = 声明路径；不要求命名，schema 校验仍在
    `parse_plugin_provider_entries`）。
  - `kbMetadataMigrations` → `metadata_migrations`：**版本 = 下标 + 1**（P3-14）。
  - `kbDescriptionTemplate` → `description_template`。
  - icon：头部 icon 优先（不变）；zip 回退改按 `kbIcon` 路径取（v3 无 `icon.png` 约定名）。
  - manifest/config：点 1 的 `plugin_manifest_from_package_json` / `plugin_config_from_package_json`。
  - 引用缺失（字段指向 zip 内不存在条目）→ 报"package.json 引用的 `<path>` 不在包内"。
- **不改**（v2 路径）：无 v3 package.json 时，现有单遍扫描逻辑原样保留（P3-8）。

---

## 点 3 — 头部/回退固定名读取接 v3（`mod.rs` 锚点 e、f）

- **修改**：`read_plugin_manifest_from_kgpg_file` / `_sync`——头部槽路径**不变**
  （v3 头部是派生清单，同形）；zip 回退分支加 package.json(v3) 优先、manifest.json 兜底。
- **修改**：`read_plugin_config`（`mod.rs:471`）——先找 `package.json`（v3 →
  `plugin_config_from_package_json`），否则按现状读 `config.json`。
  `read_plugin_config_public` / `get_plugin_vars_from_file` 自动受益。
- **修改**：store 包版本上限 `const MAX: u64 = 2` → `3`（锚点 f）。
- **不改**：`PluginManifest`/`PluginConfig`/`VarDefinition` 结构、头部二进制读取、前端
  （`PluginBrowser.vue` 的 `pv >= 2` 对 v3 仍成立——二进制头部仍是 v2）。

---

## 点 4 — 测试（`mod.rs` tests，**新增**）

- **新增**（单测，构造内存 zip，不依赖网络）：
  1. `plugin_manifest_from_package_json`：name 作默认显示名、i18n 扁平键、author 字符串/对象、
     `engines.kabegame` 两种写法归一。
  2. `plugin_config_from_package_json`：`kbBaseUrl` → base_url、`kbConfig` → var。
  2b. `normalize_engines_kabegame`：`">=4.3.0"` / `">= 4.3.0"` → `"4.3.0"` 正确；
      其他写法（`^`/`~`/exact/`||`/`*`/空串）一律报错。
  3. `validate_kb_rel_path`：拒 `..` / 绝对 / 盘符。
  4. `extract_doc_local_refs` + 装载改写：相对 md 目录 / `/` 根相对两种引用，键与改写后引用串一致。
  5. v3 装载：`kbBackend="v8"` → `script = V3 { backend: V8, source }`、`script_type="v8"`；
     缺失 `main` 引用报错；`kbBackend` 非法字符串报错。
  6. v2 回退：无 v3 package.json 的旧 zip 装载 `script = V2 { rhai, js }`、`script_type` 与改动前一致（兼容回归）。

---

## 退出标准

- `cargo check -p kabegame-core --lib` 通过；
- v3 zip 可装：manifest/config/doc（含图片引用改写）/推荐配置/providers/迁移脚本/`script`（`PluginScript::V3`）均来自 package.json 字段；
- v2 zip 装载行为不变（点 4 用例 6）；
- 共用纯函数（点 1）已 `pub` 导出，供 3c 消费。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 新增 | `kabegame-core/src/plugin/mod.rs` | `PluginBackend`（+ `FromStr`）/ `PluginScript` 枚举；`package_json_is_v3` / `normalize_engines_kabegame` / `validate_kb_rel_path` / `plugin_manifest_from_package_json` / `plugin_config_from_package_json` / `extract_doc_local_refs`（pub 导出）；`load_plugin_v3_from_zip` |
| 修改 | `kabegame-core/src/plugin/mod.rs` | `Plugin`：删 `rhai_script`/`js_script`，改单一 `script: PluginScript`，`script_type` 改派生；所有 `Plugin{..}` 构造点 + `plugin.rhai_script`/`js_script` 消费点改 match；zip 循环捕获 package.json + v3/v2 分流；manifest/`read_plugin_config` 接 v3；store `MAX` 2→3 |
| 修改 | `kabegame-core/Cargo.toml` | 无新 semver 依赖（`normalize_engines_kabegame` 用已有 `semver` crate + 标准库实现 `>=` 语法解析） |
| 新增 | `kabegame-core/src/plugin/mod.rs` tests | 用例 1–6（清单/配置/路径校验/doc 引用/v3 装载/v2 回归） |
