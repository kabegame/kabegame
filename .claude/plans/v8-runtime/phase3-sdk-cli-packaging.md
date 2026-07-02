# Phase 3 — SDK + CLI 打包器 + 插件清单 v3（package.json 自描述单清单）（逐点实施方案）

> 对应总 plan [`v8-runtime-master-plan.md`](./v8-runtime-master-plan.md) 的 **Phase 3**；
> 前置：[`phase2-prelude-entry.md`](./phase2-prelude-entry.md)（prelude 15 op ABI +
> `crawl(common, custom)` 契约 + `execute_crawler_script_v8` 调度入口）。
>
> 验证遵循 CLAUDE.md：`cargo check`（core + cli）+ CLI 侧单测，不跑全量 build。

---

## 本 Phase 已拍板的决策（在总 plan D1–D8 之上）

| # | 决策 | 说明 |
|---|------|------|
| P3-1 | **O1 拍板：不做 `kabegame:prepublish` 钩子**（暂缓） | CLI 仍是纯打包器，不 shell 作者构建脚本。 |
| P3-2 | **灭掉 `manifest.json` / `config.json`，package.json 单清单** | `name`/`version`/`author`/`description`/`main` 复用 npm 原生字段；kabegame 语义走 `kb*` 扩展字段。 |
| P3-3 | **包格式版本升到 3**（`kbPackageVersion: 3`） | 声明在插件 `package.json` 顶层；store index 的 `packageVersion` 同步取该值；core 侧最高支持版本 2→3。KGPG **二进制头部版本仍为 2**（meta + icon + manifest 槽布局不变，槽内 JSON 改为派生清单）。 |
| P3-4 | **minAppVersion → `engines.kabegame`** | 单一事实源（对齐 D5）。接受 `"4.3.0"` 或 `">=4.3.0"`，归一化为裸三段版本号。 |
| P3-5 | **本次重构随 App 4.3.0 发布** | v3 格式包只有 4.3.0+ 能完整解析 ⇒ pack v3 时强制 `engines.kabegame` 归一化后 `>= 4.3.0`，缺失即报错。 |
| P3-6 | **i18n 保留：顶层扁平键** | `"name.zh"` / `"description.en"` 等直接放 package.json 顶层；`extract_manifest_text_from_flat` / `copyFlatI18nKeys` / 前端解析全部原样复用。 |
| P3-7 | **npm `name` 即默认显示名，同时必须 == 插件 id（目录名）** | 人类可读名靠 `name.zh` 等覆盖；pack 校验不一致即报错。 |
| P3-8 | **运行时保留 v2 兼容读取** | zip 内 `package.json`（`kbPackageVersion>=3`）优先，缺失回退 `manifest.json`/`config.json`。 |
| P3-9 | **CLI 双轨，按 `kbPackageVersion` 检测** | 目录 `package.json` 存在且 `kbPackageVersion>=3` → v3 打包路径；否则按 v2 旧路径打包。 |
| P3-10 | **内置 12 插件本 Phase 迁移到 v3** | manifest.json + config.json 合并进各自 package.json 后删除；脚本本体不动（迁 v8 属 Phase 6）。 |
| P3-11 | **v3 单后端单脚本，`kbBackend` 显式声明** | 入口用 npm 兼容的 `main` 字段（路径任意）；`kbBackend ∈ { "rhai", "v8", "webview" }` 必填，**不靠扩展名/文件名判定**。一个 v3 包只提供一个脚本；rhai+v8 双跑 = 发两个包（Phase 6 处理）。 |
| P3-12 | **自描述路径，不强制结构和名称** | zip **保留插件原始目录布局**；所有资源经 package.json 的 `kb*` 路径字段定位（无 `doc_root/`、`configs/`、`providers/`、`metadata_migrations/`、`templates/`、`icon.png` 目录/文件名约定）。路径一律插件根相对、禁 `..`/绝对 OS 路径。 |
| P3-13 | **doc 走 `kbDoc.[locale]`** | 值为 md 文件路径；md 内资源引用**相对 doc 文件所在目录解析**，`/` 开头**从插件根解析**。 |
| P3-14 | **迁移版本 = `kbMetadataMigrations` 数组下标 + 1** | 追加式、天然无断档，文件名完全自由；禁止中途删除/重排。 |
| P3-15 | **字段名规范化 camelCase + 正确拼写** | `kbRecommendedConfigs`（修正 Recommanded）、`kbIcon`、`kbPathQLProviders`、`kbDescriptionTemplate`、`kbMetadataMigrations`、`kbDoc`、`kbBackend`、`kbBaseUrl`、`kbConfig`、`kbPackageVersion`。 |

---

## 插件清单 v3 契约（package.json）

```jsonc
{
  // ── npm 原生字段（复用） ──
  "name": "anime-pictures",              // 必需：kebab-case，== 插件 id == 目录名 == kgpg 文件名 stem；默认显示名
  "version": "0.5.0",                    // 必需：插件版本
  "description": "anime-pictures动漫图库收集源插件", // 默认语言描述
  "author": "Kabegame",                  // 字符串或 npm 对象 { "name": ... }（取 .name）
  "main": "dist/main.js",                // 必需：入口脚本路径（任意路径/文件名）
  "engines": { "kabegame": ">=4.3.0" },  // 必需：最低 App 版本 → minAppVersion
  "private": true,

  // ── i18n：顶层扁平键（与旧 manifest.json 同形） ──
  "name.zh": "anime-pictures动漫图库",
  "name.en": "anime-pictures anime gallery",
  "description.en": "anime-pictures anime gallery crawler (tag search)",

  // ── kabegame 扩展字段 ──
  "kbPackageVersion": 3,                 // 必需：包内容格式版本（CLI/core 双轨检测依据）
  "kbBackend": "v8",                     // 必需："rhai" | "v8" | "webview"（不靠扩展名判定，P3-11）
  "kbBaseUrl": "https://anime-pictures.net",  // 可选：原 config.json 的 baseUrl
  "kbConfig": [                          // 可选：原 config.json 的 var 数组，逐字段原样
    { "key": "startPage", "type": "int", "name": "起始页面", "name.en": "Start page", "default": 0, "min": 0 }
  ],
  "kbIcon": "assets/icon.png",           // 可选：图标路径（pack 时烘进 KGPG 头部；无约定回退）
  "kbDoc": {                             // 可选：多语言文档路径；键 = "default" / "zh" / "en" / ...
    "default": "docs/doc.md",
    "zh": "docs/doc.zh.md"
  },
  "kbRecommendedConfigs": [ "presets/daily.json" ],        // 可选：推荐运行配置路径数组（原 configs/）
  "kbPathQLProviders": [ "providers/pixiv.provider.json5" ], // 可选：Provider DSL 路径数组（原 providers/）
  "kbMetadataMigrations": [              // 可选：迁移脚本路径数组；下标 i → 版本 i+1（P3-14）
    "migrations/add-tags.rhai",          // v1
    "migrations/fix-author.rhai"         // v2
  ],
  "kbDescriptionTemplate": "templates/description.ejs",    // 可选：EJS 详情模板路径（原 templates/description.ejs）

  // ── v8 工程字段（作者自用，打包器/运行时不读） ──
  "scripts": { "build": "rspack build" },
  "devDependencies": { "@kabegame/plugin-sdk": "^0.1.0", "@rspack/cli": "..." }
}
```

- **zip 内容**：`package.json`（zip 根，原样）+ `main` 脚本 + 全部 `kb*` 字段引用的文件 +
  kbDoc md 引用的本地图片（见点 4 的引用闭包收集），**全部保留原始相对路径**（P3-12）。
  不再有 `manifest.json` / `config.json`，不再有任何目录名约定。
- **KGPG 头部 manifest 槽**（4096B 上限不变）：pack 时从 package.json **派生**精简清单——
  `{ name, name.*, version, description, description.*, author, minAppVersion }`。
  与旧头部 JSON 同形，`PluginManifest` 反序列化器与所有头部读取方零改动。
- **kbDoc 资源解析规则**（P3-13）：md 内 `![](img/a.png)` 相对该 md 所在目录解析；
  `![](/assets/a.png)` 从插件根解析。CLI 收集与 core 加载用同一套解析（点 2 / 点 4）。

---

## 现状锚点

**a. CLI `pack_plugin`：manifest.json 必需、整份写头部、icon.png 固定名**（`src-tauri/kabegame-cli/src/main.rs:556`）

```rust
fn pack_plugin(args: PackPluginArgs) -> Result<(), String> {
    // 现状：manifest.json 是唯一清单，缺失即报错；整份 JSON 写入 KGPG 头部槽
    let manifest_path = plugin_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Err(format!("缺少必需文件: {}", manifest_path.display()));
    }
    // ...
    maybe_run_webview_build(&plugin_dir)?;          // 现状：检测到 package.json scripts.build 会自动跑构建
    let backend = detect_plugin_backend(&plugin_dir)?;
    let icon_path = plugin_dir.join("icon.png");    // 现状：图标固定名 icon.png
    // ...
    let header = kgpg::build_kgpg2_header(icon_rgb.as_deref(), &header_manifest_bytes)?;
    let zip_bytes = build_plugin_zip_bytes(&plugin_dir, backend)?;
    kgpg::write_kgpg2_from_zip_bytes(&args.output, &header, &zip_bytes)?;
    Ok(())
}
```

**b. CLI 后端检测与 zip 收集：文件名约定 + 硬编码目录 allowlist**（`main.rs:658` / `main.rs:672`）

```rust
fn detect_plugin_backend(plugin_dir: &Path) -> Result<PluginBackend, String> {
    // 现状：靠固定文件名 crawl.js / crawl.rhai 判定（webview 优先）；无 v8 分支
    let has_webview_script = plugin_dir.join("crawl.js").is_file();
    let has_rhai_script = plugin_dir.join("crawl.rhai").is_file();
    // ...
}

fn build_plugin_zip_bytes(plugin_dir: &PathBuf, backend: PluginBackend) -> Result<Vec<u8>, String> {
    // 现状：固定收集 manifest.json + 唯一后端脚本 + config.json(可选)，外加目录约定扫描：
    //   configs/*.json、providers/(is_provider_file_path)、metadata_migrations/v{N}.rhai、
    //   doc_root/(doc.md/doc.<lang>.md + 2MB 内常见图片)、templates/*.ejs
    // 全部硬编码；无 .kabegameignore；zip 内不含 package.json
    entries.push(("manifest.json".to_string(), plugin_dir.join("manifest.json")));
    entries.push((backend.script_file_name().to_string(), /* ... */));
    // ...
}
```

**c. CLI `plugin new`：所有后端都吐 manifest.json**（`main.rs:182`；模板 `template/`）

```rust
// 现状：公共模板固定写 manifest.json；backend 枚举只有 Rhai / Webview
write_template_text_to("manifest.json", &plugin_dir.join("manifest.json"), &args.name)?;
match args.backend {
    PluginBackend::Rhai => /* rhai/crawl.rhai */,
    PluginBackend::Webview => /* webview/crawl.js + webview/package.json(仅 name/version) + .gitignore */,
}
```

**d. core 清单/配置结构**（`src-tauri/kabegame-core/src/plugin/mod.rs:2387` / `mod.rs:2791`）

```rust
// 现状：PluginManifest 自定义反序列化，从扁平键提取 name/name.zh、description/...；
//       minAppVersion 是顶层字段
pub struct PluginManifest {
    pub name: ManifestI18nText,
    pub version: String,
    pub description: ManifestI18nText,
    pub author: String,
    pub min_app_version: Option<String>,   // 现状：读 "minAppVersion" 键
}

// 现状：config.json = { baseUrl?, var? }
pub struct PluginConfig {
    #[serde(rename = "baseUrl", default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub var: Option<Vec<VarDefinition>>,
}
```

**e. core .kgpg 加载：单遍扫 zip、全靠条目名约定分发**（`mod.rs:1887`–`mod.rs:2135`）

```rust
// 现状：遍历 zip 条目，按固定名/固定前缀分发：
if name == "manifest.json" { /* manifest_json = Some(s) */ }
else if name == "config.json" { /* config_json */ }
else if name == "icon.png" { /* icon_png_bytes（另有头部 icon 优先） */ }
else if name == "templates/description.ejs" { /* description_template */ }
else if name == "crawl.rhai" { /* rhai_script_content */ }
else if name == "crawl.js" { script_type = "js"; /* js_script_content */ }
else if name.starts_with("configs/") && name.ends_with(".json") { /* config_presets，filename 为键 */ }
else if name.starts_with("doc_root/doc") && name.ends_with(".md") { /* doc_entries：doc.zh.md → "zh" */ }
else if name.starts_with("doc_root/") { /* doc_resource_entries：键 = doc_root 相对路径，2MB/总量限制 */ }
else if let Some(version) = metadata_migration_version_from_path(&normalized_name) { /* v{N}.rhai → (N, s) */ }
else if crate::providers::is_provider_file_path(&name) { /* provider_entries */ }
// ...
let manifest_str = manifest_json
    .ok_or_else(|| "manifest.json not found in plugin archive".to_string())?; // 现状：缺失即错
```

同样的"固定名读取"还出现在：`read_plugin_manifest_from_kgpg_file`（`mod.rs:2262`，头部槽优先、zip 回退）、
`read_plugin_manifest_from_kgpg_file_sync`（`mod.rs:2299`）、`read_plugin_config`（`mod.rs:471`）。

**f. doc 资源键与前端引用同构**（`mod.rs:1973`、`mod.rs:2094`）

```rust
// 现状：doc_resources 键 = doc_root/ 相对路径（如 "img/a.png"）；
// md 内引用也是 doc_root 相对路径 → 前端按引用字符串直接查表，无解析逻辑
let rel_path = name.strip_prefix("doc_root/").unwrap().to_string();
doc_resource_entries.push((rel_path, bytes));
```

**g. store index 包版本上限 = 2**（`mod.rs:1134`）

```rust
// 现状：index.json 的 packageVersion 缺省 1，过高按最高支持版本 2 clamp
const MAX: u64 = 2;   // 现状：最高支持 2
```

**h. `generate-index.ts`：读 manifest.json、`packageVersion` 写死 2**（`src-crawler-plugins/generate-index.ts:175`）

```ts
// 现状：清单来源是 manifest.json；index 条目 packageVersion 硬编码 2，无 minAppVersion
const manifestPath = path.join(pluginDir, "manifest.json");
const pluginInfo: PluginInfo = {
  id: pluginName, version: manifest.version || "1.0.0",
  author: (manifest.author as string) || "", packageVersion: 2, /* ... */
};
copyFlatI18nKeys(manifestRaw, pluginInfo, "name");
```

**i. 内置插件目录现状**（`src-crawler-plugins/plugins/anime-pictures/`）

```jsonc
// manifest.json：name/name.zh/.../version/minAppVersion/description.*/author
// config.json：{ "baseUrl": ..., "var": [ {key,type,name,name.en,...,default,min,max} ] }
// package.json：现状仅 { "name": "kgpg-anime-pictures", "version": "0.1.0", "private": true }
// 目录约定：icon.png / doc_root/ / configs/ / providers/ / metadata_migrations/v{N}.rhai / templates/
// 注意：部分插件同时有 crawl.js + crawl.rhai（现状打包器 webview 优先、只装一个）
```

**j. SDK 落点现状**：`packages/` 下无 `plugin-sdk`；`.gitmodules` 无对应条目；
根 `package.json` workspaces 已含 `"packages/*"`（新 submodule 自动纳入，无需改）。

**k. CLI 结构校验**（`main.rs:535`）

```rust
// 现状：manifest 可读 + crawl.rhai/crawl.js 至少其一 + config.json 可解析
let has_webview = has_non_empty_zip_entry(zip_path, "crawl.js")?;
if !has_rhai && !has_webview {
    return Err("插件包缺少 crawl.rhai / crawl.js（或内容为空）".to_string());
}
```

---

## 点 1 — 填充 `@kabegame/plugin-sdk`（`packages/plugin-sdk`，git submodule，**新增**）

- **新增**：`.gitmodules` 条目 + submodule `packages/plugin-sdk` →
  `https://github.com/kabegame/kabegame-plugin-sdk`（空仓已建）。
  > 说明：根 workspaces 已含 `packages/*`，bun 自动纳入，根 `package.json` 无需改。
- **新增**（SDK 仓库内）：`package.json`
  - `name: "@kabegame/plugin-sdk"`、`version: "0.1.0"`、`type: "module"`；
  - **`engines.kabegame: ">=4.3.0"`** —— 即 Phase 2 prelude 15-op ABI 对应的 App 版本（D5 单一事实源）；
  - `exports` / `types` 指向构建产物（`dist/index.js` + `dist/index.d.ts`；作者 bundler 内联进最终 bundle）。
- **新增**（SDK `src/`）：三层内容
  1. **op 薄封装**（与 Phase 2 prelude 的 15 个 `__kabegame_*` 一一对应）：
     `to / back / fetchJson / currentUrl / currentHtml / currentHeaders / pluginData / setPluginData / setHeader / delHeader / warn / addProgress / downloadImage / createImageMetadata`
     （`log` 走 prelude 的 `console.*`）+ `sleep(ms)`（`setTimeout` shim 封装）。
  2. **JS 侧工具**（Phase 1 从 Rust op 面裁掉的能力，纯 JS 依赖随 SDK 打包）：
     - DOM 解析：`query / queryByText / findByText / getAttr`（基于 `htmlparser2` + `css-select`；
       裸 deno_core **无 DOMParser**，必须捆纯 JS 解析器）；
     - URL 工具：`urlEncode / resolveUrl / is*Url`（裸 deno_core 无 `URL`，捆纯 JS polyfill）；
     - `md5`（纯 JS）、`unixTimeMs / randF64`、`xhh_*` 签名工具；正则直接用原生 `RegExp`。
  3. **类型**（对齐 Phase 2 点 2 契约）：
     `KbCommonCfg`（`{ base_url: string | null }`）；配置声明类型函数
     `kbCustomCfg<Fields> / kbCfgField<K, T> / kbCfgInt / kbCfgStr / kbCfgBool / kbCfgOption<...>`，
     与 `kbConfig` var 字段类型集一一对应。
- **退出口径**：SDK 可 `bun run build` 产出 dist；
  `export async function crawl(common: KbCommonCfg, custom: X)` 类型可编译。

---

## 点 2 — core 支持清单 v3：package.json 自描述加载 + v2 兼容回退（`kabegame-core/src/plugin/mod.rs`）

- **新增**：v3 解析辅助（v2/v3 共用既有类型）：

```rust
/// 判定 package.json 是否 v3 清单（kbPackageVersion >= 3）。
fn package_json_is_v3(v: &serde_json::Value) -> bool {
    v.get("kbPackageVersion").and_then(|x| x.as_u64()).unwrap_or(0) >= 3
}

/// engines.kabegame（"4.3.0" 或 ">=4.3.0"）归一化为裸 semver 三段；其余写法报错。
pub fn normalize_engines_kabegame(raw: &str) -> Result<String, String>;

/// package.json（v3）→ PluginManifest：name = npm name（默认显示名，P3-7）；
/// author 兼容字符串与 { "name": ... }；minAppVersion ← engines.kabegame；
/// i18n 仍走 extract_manifest_text_from_flat（顶层扁平键，P3-6）。
pub fn plugin_manifest_from_package_json(v: &serde_json::Value) -> Result<PluginManifest, String>;

/// package.json（v3）→ PluginConfig：base_url ← kbBaseUrl；var ← kbConfig。
pub fn plugin_config_from_package_json(v: &serde_json::Value) -> Result<Option<PluginConfig>, String>;

/// kb* 路径字段安全校验：插件根相对、组件级规范化、禁 ".."/绝对路径/盘符。
fn validate_kb_rel_path(p: &str) -> Result<(), String>;
```

- **修改**（.kgpg 加载主路径，锚点 e）：入口先探测 zip 内 `package.json`，分流两套装载：
  - **v3 路径（新增 `load_plugin_v3_from_zip`）**——按字段拉取条目，**不再有任何条目名约定**：
    - `main` + `kbBackend` → 脚本：`"rhai"` → `rhai_script` / `script_type="rhai"`；
      `"webview"` → `js_script` / `script_type="js"`；
      `"v8"` → **新增字段 `Plugin.v8_script: Option<String>`** / `script_type="v8"`
      （仅存储与安装展示；调度分发是 Phase 4，`task_scheduler` 遇 `"v8"` 前不触达）。
    - `kbDoc` → `doc`：键（`default`/`zh`/...）原样过；值为 zip 内 md 路径。
    - **doc 资源（P3-13，引用闭包）**：解析每个 kbDoc md 中的本地图片引用
      （`![](...)` 与 `<img src>`；跳过 `http(s):`/`data:`）——相对引用按该 md 所在目录解析、
      `/` 开头按插件根解析——归一化为根相对 zip 路径后：
      1. 从 zip 取字节装入 `doc_resources`，**键 = 归一化根相对路径**；
      2. **改写 md 内该引用字符串为同一归一化路径**。
      > 说明：改写后"md 内引用字符串 == doc_resources 键"这一 v2 不变量得以保持（锚点 f），
      > **前端零改动**。2MB 单文件 / 总量上限沿用现状常量。
    - `kbRecommendedConfigs` → `recommended_configs`（`filename` = 路径 basename，前端键语义不变）。
    - `kbPathQLProviders` → `provider_entries`（`source_path` = 声明路径；不再要求
      `is_provider_file_path` 命名，schema 校验仍在 `parse_plugin_provider_entries`）。
    - `kbMetadataMigrations` → `metadata_migrations`：**版本 = 下标 + 1**（P3-14），
      替代 `metadata_migration_version_from_path` 的 v{N} 文件名解析（v2 路径保留旧函数）。
    - `kbDescriptionTemplate` → `description_template`。
    - icon：头部 icon 优先（不变）；zip 回退改按 `kbIcon` 路径取（v3 无 `icon.png` 约定名）。
    - manifest/config：`plugin_manifest_from_package_json` / `plugin_config_from_package_json`。
    - 引用缺失（字段指向 zip 内不存在的条目）→ 装载错误，报"package.json 引用的 `<path>` 不在包内"。
  - **v2 路径**：现有单遍扫描逻辑**原样保留**（P3-8；zip 无 v3 package.json 时走它）。
- **修改**（其余固定名读取，锚点 e 尾注）：
  - `read_plugin_manifest_from_kgpg_file` / `_sync`：头部槽路径**不变**（v3 头部是派生清单，同形）；
    zip 回退分支加 package.json(v3) 优先、manifest.json 兜底。
  - `read_plugin_config`（`mod.rs:471`）：先找 `package.json`（v3 → `plugin_config_from_package_json`），
    否则按现状读 `config.json`。`read_plugin_config_public` / `get_plugin_vars_from_file` 自动受益。
- **修改**（锚点 g，`mod.rs:1141`）：store 包版本上限 `const MAX: u64 = 2` → `3`。
- **不改**：`PluginManifest`/`PluginConfig`/`VarDefinition` 结构、头部读取、前端
  （`PluginBrowser.vue` 的 `pv >= 2` 判断对 v3 仍成立——二进制头部还是 v2；doc 资源经引用改写对齐）。

---

## 点 3 — CLI pack 双轨：v3 校验 + 派生头部清单（`kabegame-cli/src/main.rs`）

- **修改**（`pack_plugin`，锚点 a）：入口读 `plugin_dir/package.json` 判定格式：

```rust
let pkg = read_optional_package_json(&plugin_dir)?;               // 新增
match pkg.as_ref().filter(|v| package_json_is_v3(v)) {
    Some(pkg) => pack_plugin_v3(&plugin_dir, &args.output, pkg),   // 新增：v3 路径
    None => pack_plugin_v2(&plugin_dir, &args.output),             // 现有逻辑原样搬入（P3-9 双轨）
}
```

- **新增**（`pack_plugin_v3`）：
  1. **校验**（缺一即报错）：
     - `name` 存在、kebab-case、**== 插件目录名 == `--output` 文件名 stem**（P3-7）；
     - `version` 可解析；`kbPackageVersion == 3`（更高值报"CLI 版本过旧"）；
     - `engines.kabegame` 存在且归一化后 **`>= 4.3.0`**（P3-5，复用 core 的
       `normalize_engines_kabegame` + `check_min_app_version`）；
     - `main` 存在、文件存在且非空；`kbBackend ∈ { rhai, v8, webview }`（P3-11，无扩展名推断）；
     - 全部 kb* 路径字段过 `validate_kb_rel_path` 且文件存在；
     - `kbConfig` 若存在必须能反序列化为 `Vec<VarDefinition>`（复用 core 类型，防安装后才炸）。
  2. **派生头部清单**（写 KGPG 头部槽，替代 v2 的整份 manifest.json）：

```rust
// 仅保留展示字段，确保 <= 4096B；键名与 v2 头部同形（PluginManifest 反序列化零改动）
fn derive_header_manifest(pkg: &serde_json::Value) -> Result<Vec<u8>, String> {
    // { name, name.*, version, description, description.*, author, minAppVersion }
    // author 对象形态取 .name；minAppVersion = normalize_engines_kabegame(engines.kabegame)
}
```

  3. 头部 icon：改读 `kbIcon` 路径（`icon_png_to_rgb24_fixed` 复用；未声明则无图标，
     **不回退 `icon.png` 约定名**，P3-12）；zip 收集走点 4。
- **删除**：v3 路径不调用 `maybe_run_webview_build`（D6/P3-1：CLI 不驱动构建）、
  不调用 `detect_plugin_backend`（后端由 `kbBackend` 声明）。v2 路径二者保留现状。
- **修改**（`validate_kgpg_structure`，锚点 k）：v3 包改为——清单走 `read_plugin_manifest`
  （点 2 已覆盖）；入口脚本按 zip 内 package.json 的 `main` 路径查非空条目；
  config 校验走 `read_plugin_config_public`（已覆盖）。v2 包沿用旧判定。
- **说明**：core/CLI 共用的 v3 纯函数（`package_json_is_v3` / `normalize_engines_kabegame` /
  `validate_kb_rel_path` / doc 引用解析）放 `kabegame-core` 导出，CLI 只留 IO 与拼装。

---

## 点 4 — v3 zip 收集器：引用闭包 + `.kabegameignore`（`main.rs`，**新增** `collect_v3_entries`）

- **新增**（默认收集 = **package.json 引用闭包**，保留原始相对路径，P3-12）：
  - `package.json`（zip 根，原样）；
  - `main` 脚本；
  - `kbDoc` 各 locale md + **md 引用的本地图片**（解析规则与 core 一致：相对 md 目录 / `/` 根相对；
    仅收 `jpg/jpeg/png/gif/webp/bmp`，单文件 2MB 上限沿用，超限 WARN 跳过）；
  - `kbRecommendedConfigs` / `kbPathQLProviders` / `kbMetadataMigrations` /
    `kbDescriptionTemplate` 引用的每个文件；
  - **不收**：`kbIcon`（只进头部，同 v2 对 icon.png 的处理）、`node_modules/`、锁文件、
    `manifest.json`/`config.json`（v3 目录若残留则 WARN 并忽略）以及其它一切未被引用的文件。
- **新增**（`.kabegameignore`，学 `.vscodeignore`，作用于**引用闭包之上**）：
  - 普通行 = glob 排除：从收集集中剔除匹配项（排除到 `main`/清单级文件时报错而非静默）；
  - `!pattern` 行 = 强制追加：从插件目录（恒排除 `node_modules/`、`.git/`）额外收入匹配文件——
    覆盖"脚本运行期按路径读包内额外资源"之类闭包解析不到的场景；
  - 实现用 `globset` crate（`kabegame-cli` 新依赖）；文件不存在 = 无操作；v2 路径**不启用**。
- **新增**（CLI 单测）：`collect_v3_entries` 表驱动用例——引用闭包 / doc 图片相对+根相对解析 /
  排除 / `!` 追加 / 引用缺失报错 / 残留 manifest.json 被忽略。

---

## 点 5 — `plugin new` 全面 v3 化 + `--backend v8` 模板（`main.rs:93,182`；`template/`）

- **修改**（`PluginBackend` 枚举）：增加 `V8`；枚举仅用于选模板（v3 打包不再做后端检测）。
- **修改**（`new_plugin`）：**不再写 `manifest.json`**；所有后端统一写各自的 v3 `package.json`
  （含 `kbBackend` 与 `main`）。
- **删除**：`template/manifest.json`；`template/webview/package.json`（并入 v3 模板）。
- **新增**：`template/v8/`（node 工程模板；rspack 内置但 CLI 不调用，D6）：

```
template/v8/
├── package.json        # 下方 v3 清单 + scripts.build + devDependencies(@kabegame/plugin-sdk, @rspack/*, typescript)
├── tsconfig.json
├── rspack.config.mjs   # entry src/index.ts → 输出 dist/main.js（自包含单文件，target=es2022，无 external）
├── src/index.ts        # import { to, query, downloadImage } from "@kabegame/plugin-sdk";
│                       # export async function crawl(common: KbCommonCfg, custom: MyConfig) { ... }
├── docs/doc.md
├── icon.png
├── .gitignore          # node_modules/ dist/ *.log
└── .kabegameignore     # 示例注释（引用闭包通常够用）
```

```jsonc
// template/v8/package.json（{{plugin_name}} 替换机制与现状一致）
{
  "name": "{{plugin_name}}",
  "version": "0.1.0",
  "description": "{{plugin_name}} crawler plugin",
  "author": "You",
  "main": "dist/main.js",
  "private": true,
  "engines": { "kabegame": ">=4.3.0" },
  "kbPackageVersion": 3,
  "kbBackend": "v8",
  "kbBaseUrl": "",
  "kbConfig": [],
  "kbIcon": "icon.png",
  "kbDoc": { "default": "docs/doc.md" },
  "scripts": { "build": "rspack build" },
  "devDependencies": { "@kabegame/plugin-sdk": "^0.1.0", "@rspack/cli": "^1", "@rspack/core": "^1", "typescript": "^5" }
}
```

  > 说明：作者流程 = `bun install && bun run build && kabegame-cli plugin pack`；
  > `main` 指向构建产物 `dist/main.js`，dist 进 `.gitignore`，路径/文件名均可改（自描述）。
- **修改**：`template/rhai/`、`template/webview/` 增加各自 v3 `package.json`
  （`kbBackend: "rhai"` + `main: "crawl.rhai"` / `kbBackend: "webview"` + `main: "crawl.js"`，
  无 scripts/devDependencies；文件名仅是模板默认值，非约定）。

---

## 点 6 — 内置 12 插件迁移到 v3 + 打包链跟进（`src-crawler-plugins/`）

- **修改**（12 个 `plugins/*/`，一次性迁移，P3-10）：对每个插件——
  - `package.json`：`name` 由 `kgpg-<id>` 改为 `<id>`（目录名）；`version` 取 manifest 版本；
    合入 `author`、`description` + 顶层扁平 i18n 键（manifest 原样搬）；
    `kbPackageVersion: 3`；`engines: { "kabegame": ">=4.3.0" }`（原 minAppVersion 一律升 4.3.0，P3-5）；
    `kbBaseUrl` ← config.json `baseUrl`；`kbConfig` ← config.json `var`；
    **`main` + `kbBackend`**：有 `crawl.js` 的插件取 `main: "crawl.js"` / `"webview"`
    （对齐现状打包器 webview 优先），否则 `main: "crawl.rhai"` / `"rhai"`
    ——单后端（P3-11），被舍弃侧脚本文件保留在仓库但不再入包；
    `kbIcon: "icon.png"`；`kbDoc` ← 现有 `doc_root/doc*.md` 逐语言列出；
    `kbRecommendedConfigs` ← `configs/*.json` 枚举；`kbPathQLProviders` ← `providers/` 枚举；
    `kbMetadataMigrations` ← `metadata_migrations/v{N}.rhai` 按 N 升序列出
    （脚本**断言 N 从 1 连续**，断档则中止人工处理，P3-14）；
    `kbDescriptionTemplate` ← `templates/description.ejs`（存在时）。
  - **删除**：`manifest.json`、`config.json`（文件布局其余不动——路径已被字段显式引用）。
  - **新增**：一次性迁移脚本 `src-crawler-plugins/scripts/migrate-v3.ts`（跑完可删），保证 12 份零手误。
- **修改**（`generate-index.ts`，锚点 h）：
  - 清单来源 `manifest.json` → `package.json`（`copyFlatI18nKeys` 原样复用）；
  - `packageVersion` ← `kbPackageVersion`（缺失回退 2）；
  - **新增** index 条目 `minAppVersion`（← `engines.kabegame` 归一化；core 的
    `resolve_store_plugin` 已读该键，`mod.rs:1165`）。
- **不改**：`package-plugin.ts`（只是 shell `kabegame-cli plugin pack`，双轨对它透明）。

---

## 点 7 — 文档与总 plan 收口

- **修改**：`docs/PLUGIN_FORMAT.md` 增"清单 v3（package.json 自描述）"章节：字段表（P3-15 定名）、
  v2/v3 判定（`kbPackageVersion`）、kbDoc 资源解析规则、`.kabegameignore` 语义、
  头部派生清单说明；v2 标注 legacy。
  > 说明：`docs/JS_API.md`、`README_PLUGIN_DEV.md` 全面改写仍留 Phase 6（总 plan 分工不变）。
- **修改**：`v8-runtime-master-plan.md`——
  - Decision Log：O1 拍板"暂不做"；补 D9（package.json 自描述单清单 v3 + kb* 字段）、
    D10（v2 兼容双轨）、D11（目标版本 4.3.0）、D12（v3 单后端 `kbBackend`，
    双跑靠双包——修正原 Phase 6"同包双跑"表述）；
  - Phase 3 节改指向本文件；风险表补"v3/v2 双格式共存期的一致性"。
- `cocs/README.md` 暂不动（cocs 收实现后的流程文档，Phase 3 落地后按维护规则补）。

---

## 退出标准（对齐总 plan Phase 3 并细化）

1. `plugin new <name> --backend v8` 产出可构建模板：`bun install && bun run build`
   得到自包含 `dist/main.js`（SDK 内联）。
2. v3 目录 `plugin pack` 产出 `.kgpg`：头部派生清单被既有头部读取路径解析；
   `plugin import` 安装成功且 name/i18n/vars/base_url/doc/推荐配置/providers/迁移脚本
   全部来自 package.json 字段、与声明一致；doc 图片按相对/根相对规则可显示（前端零改动）。
3. v2 目录 `plugin pack`、v2 `.kgpg` 安装/加载行为不变（兼容回归）。
4. `.kabegameignore` 排除与 `!` 追加生效；引用缺失、排除掉 `main` 等自毁配置报错（CLI 单测覆盖）。
5. v3 校验闸生效：`engines.kabegame` 缺失/非法/`< 4.3.0`、`name` ≠ 目录名、
   `kbBackend` 缺失或非法、kb* 路径越界（`..`）均在 pack 时报错。
6. 12 个内置插件迁移后 `bun package` + `bun generate-index` 全绿，index 条目
   `packageVersion: 3` 且带 `minAppVersion: "4.3.0"`。
7. `cargo check -p kabegame-core -p kabegame-cli` 通过（不跑全量 build）。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 新增 | `.gitmodules` / `packages/plugin-sdk` | SDK submodule（op 封装 + JS 工具 + 类型 + `engines.kabegame`） |
| 修改 | `kabegame-core/src/plugin/mod.rs` | `plugin_manifest_from_package_json` / `plugin_config_from_package_json` / `normalize_engines_kabegame` / `validate_kb_rel_path` / doc 引用解析改写；`load_plugin_v3_from_zip`（kb* 字段定位 + `Plugin.v8_script` 存储字段）；`read_plugin_config` 与 manifest 回退读取接 v3；store `MAX` 2→3 |
| 修改 | `kabegame-cli/src/main.rs` | pack 双轨（`kbPackageVersion` 检测）、`pack_plugin_v3`（校验 + 派生头部清单 + `kbIcon`）、`collect_v3_entries`（引用闭包 + `.kabegameignore`，globset）、`PluginBackend::V8`、`validate_kgpg_structure` v3 分支、CLI 单测 |
| 新增 | `kabegame-cli/template/v8/*` | v8 node 工程模板（v3 package.json/tsconfig/rspack.config/src/index.ts/docs/icon/.gitignore/.kabegameignore） |
| 修改/删除 | `kabegame-cli/template/` | 删 `manifest.json`；rhai/webview 模板改吐 v3 package.json（含 `kbBackend`/`main`） |
| 修改 | `src-crawler-plugins/plugins/*/`（12 个） | manifest.json + config.json + 目录约定 → package.json v3 字段（`scripts/migrate-v3.ts` 一次性生成）后删除两文件 |
| 修改 | `src-crawler-plugins/generate-index.ts` | 读 package.json；`packageVersion` ← `kbPackageVersion`；新增 `minAppVersion` |
| 修改 | `docs/PLUGIN_FORMAT.md`、`v8-runtime-master-plan.md` | v3 格式章节；O1 拍板 + D9–D12 + Phase 3 节指向本文件 |

---

## 衔接 Phase 4 预告

- Phase 3 后 `Plugin` 已带 `script_type ∈ { rhai, js, v8 }` 与 `v8_script` 内容（v3 包由
  `kbBackend`/`main` 装载）；Phase 4 在调度层接 `"v8"` 分支——
  `task_scheduler.rs:661` 的 `spawn_blocking` 处 drop-in 换 `execute_crawler_script_v8`，
  并逐项核对事件/计数语义（`task-log` / `add_progress` / `images-change` / `album-images-change`）。
- 运行前校验：`min_app_version`（已由 `engines.kabegame` 派生）沿用
  `task_scheduler.rs:590` 的既有拦截，无需新机制。
- Android 仍走 rhai：v3 单后端（P3-11）意味着 Phase 6 迁移内置插件时需决定各插件
  桌面 v8 包与 Android rhai 包的发布形态（同 id 分渠道 or 双 id），在 Phase 6 计划中拍板。
