# Phase 3c — CLI：v3 打包器 + `.kabegameignore` + `plugin new` 模板（逐点实施方案）

> Phase 3 子阶段；总览与决策见 [phase3-overview.md](./phase3-overview.md)。
> 依赖 [3b](./phase3b-core-loader.md) 导出的共用纯函数（`package_json_is_v3` /
> `normalize_engines_kabegame` / `validate_kb_rel_path` / `extract_doc_local_refs`）与 [3a](./phase3a-plugin-sdk.md)
> 的包名（模板 devDependency）。目标：`kabegame-cli plugin pack/new` 支持 v3，v2 路径原样保留。
> 验证：`cargo check -p kabegame-cli` + CLI 单测，不跑全量 build。

---

## 现状锚点

**a. `pack_plugin`：manifest.json 必需、整份写头部、icon.png 固定名、自动跑 build**（`src-tauri/kabegame-cli/src/main.rs:556`）

```rust
fn pack_plugin(args: PackPluginArgs) -> Result<(), String> {
    let manifest_path = plugin_dir.join("manifest.json");
    if !manifest_path.is_file() { return Err(/* 缺少必需文件 */); }   // 现状：manifest 唯一清单
    // ... 整份 manifest_val 序列化为头部槽 header_manifest_bytes
    maybe_run_webview_build(&plugin_dir)?;                             // 现状：有 scripts.build 就自动跑
    let backend = detect_plugin_backend(&plugin_dir)?;
    let icon_path = plugin_dir.join("icon.png");                       // 现状：图标固定名
    let header = kgpg::build_kgpg2_header(icon_rgb.as_deref(), &header_manifest_bytes)?;
    let zip_bytes = build_plugin_zip_bytes(&plugin_dir, backend)?;
    kgpg::write_kgpg2_from_zip_bytes(&args.output, &header, &zip_bytes)?;
}
```

**b. backend 检测 + zip 收集：文件名约定 + 硬编码目录 allowlist**（`main.rs:658` / `main.rs:672`）

```rust
fn detect_plugin_backend(plugin_dir) -> Result<PluginBackend, _> {
    // 现状：靠 crawl.js / crawl.rhai 文件名判定（webview 优先）；无 v8
}
fn build_plugin_zip_bytes(plugin_dir, backend) -> Result<Vec<u8>, _> {
    // 现状：固定收 manifest.json + 唯一后端脚本 + config.json(可选)
    //   + configs/*.json、providers/(is_provider_file_path)、metadata_migrations/v{N}.rhai、
    //     doc_root/(doc.md/doc.<lang>.md + 2MB 内常见图片)、templates/*.ejs
    // 全硬编码；无 .kabegameignore；zip 内无 package.json
}
```

**c. `plugin new`：所有后端都吐 manifest.json**（`main.rs:182`；模板 `template/`）

```rust
write_template_text_to("manifest.json", &plugin_dir.join("manifest.json"), &args.name)?;
match args.backend {                     // 现状：枚举仅 Rhai / Webview
    PluginBackend::Rhai => /* rhai/crawl.rhai */,
    PluginBackend::Webview => /* webview/crawl.js + webview/package.json（仅 name/version） + .gitignore */,
}
```

**d. `PluginBackend` 枚举 + 结构校验**（`main.rs:93` / `main.rs:535`）

```rust
enum PluginBackend { Rhai, Webview }     // 现状：无 V8
fn script_file_name(self) -> &'static str { Rhai => "crawl.rhai", Webview => "crawl.js" }

async fn validate_kgpg_structure(pm, zip_path) -> Result<(), _> {
    let _ = pm.read_plugin_manifest(zip_path).await?;
    let has_webview = has_non_empty_zip_entry(zip_path, "crawl.js")?;
    if !has_rhai && !has_webview { return Err("插件包缺少 crawl.rhai / crawl.js ..."); }
    let _ = pm.read_plugin_config_public(zip_path)?;                   // config.json 若存在须可解析
}
```

**e. 模板机制现状**：`TEMPLATE_DIR = include_dir!("$CARGO_MANIFEST_DIR/template")`（`main.rs:23`）
把 `template/` 嵌入二进制；`new_plugin` 用 `write_template_text_to`（`{{plugin_name}}` 字符串替换）/
`write_template_binary_to` 逐文件手动写出，并按 `match args.backend` 分别落 `template/rhai/` 或
`template/webview/` 的子文件夹产物（`main.rs:250`–`282`）。
现有子文件夹：`template/manifest.json`、`template/rhai/crawl.rhai`、
`template/webview/{crawl.js, package.json(仅 name/version/author/description), .gitignore}`、
`template/doc_root/doc.md`、`template/icon.png`。**这套手动分文件夹 + 逐文件拷贝将整体替换为 cargo-generate（点 5）。**

---

## 点 1 — pack 双轨入口（`main.rs` 锚点 a）

- **修改**（`pack_plugin`）：先读目录 package.json 判定格式：

```rust
let pkg = read_optional_package_json(&plugin_dir)?;                 // 新增
match pkg.as_ref().filter(|v| kabegame_core::plugin::package_json_is_v3(v)) {
    Some(pkg) => pack_plugin_v3(&plugin_dir, &args.output, pkg),     // 新增：v3 路径
    None => pack_plugin_v2(&plugin_dir, &args.output),               // 现有逻辑原样搬入（P3-9 双轨）
}
```

- **修改**：把现有 `pack_plugin` 主体重命名为 `pack_plugin_v2`（`maybe_run_webview_build` /
  `detect_plugin_backend` / `build_plugin_zip_bytes` 全部维持现状，v2 冻结）。

---

## 点 2 — `pack_plugin_v3`：校验 + 派生头部清单（`main.rs`，**新增**）

- **新增**（校验，缺一即报错，复用 3b 纯函数）：
  - `name` 存在、kebab-case、**== 插件目录名 == `--output` 文件名 stem**（P3-7）；
  - `version` 可解析；`kbPackageVersion == 3`（更高值报"CLI 版本过旧"）；
  - `engines.kabegame` 存在且 `normalize_engines_kabegame` 归一后 **`>= 4.3.0`**
    （P3-5，反向复用 `check_min_app_version`）；
  - `main` 存在、文件存在且非空；`kbBackend` 经 core `PluginBackend::from_str` 解析成功
    （`rhai`/`v8`/`webview`，P3-11，无扩展名推断）；
  - 全部 kb* 路径字段过 `validate_kb_rel_path` 且文件存在；
  - `kbConfig` 若存在必须能反序列化为 `Vec<VarDefinition>`（复用 core 类型，防安装后才炸）。
- **新增**（派生头部清单，替代 v2 整份 manifest.json）：

```rust
// 仅保留展示字段，确保 <= 4096B；键名与 v2 头部同形（PluginManifest 反序列化零改动）
fn derive_header_manifest(pkg: &serde_json::Value) -> Result<Vec<u8>, String> {
    // { name, name.*, version, description, description.*, author, minAppVersion }
    // author 对象取 .name；minAppVersion = normalize_engines_kabegame(engines.kabegame)
}
```

- **新增**（头部 icon）：改读 `kbIcon` 路径（`kgpg::icon_png_to_rgb24_fixed` 复用）；
  未声明则无图标，**不回退 `icon.png` 约定名**（P3-12）。
- zip 收集走点 3；`build_kgpg2_header` / `write_kgpg2_from_zip_bytes` 复用不动。
- **删除**（相对 v2）：v3 路径**不调用** `maybe_run_webview_build`（O1/P3-1：CLI 不驱动构建）、
  **不调用** `detect_plugin_backend`（后端由 `kbBackend` 声明）。

---

## 点 3 — v3 zip 收集器：引用闭包 + `.kabegameignore`（`main.rs`，**新增** `collect_v3_entries`）

- **新增**（默认收集 = **package.json 引用闭包**，保留原始相对路径，P3-12）：
  - `package.json`（zip 根，原样）；
  - `main` 脚本；
  - `kbDoc` 各 locale md + **md 引用的本地图片**（用 3b 的 `extract_doc_local_refs` 保证与 core 解析一致；
    仅收 `jpg/jpeg/png/gif/webp/bmp`，单文件 2MB 上限沿用，超限 WARN 跳过）；
  - `kbRecommendedConfigs` / `kbPathQLProviders` / `kbMetadataMigrations` / `kbDescriptionTemplate`
    引用的每个文件；
  - **不收**：`kbIcon`（只进头部）、`node_modules/`、锁文件、`manifest.json`/`config.json`
    （v3 目录若残留则 WARN 忽略）以及一切未被引用的文件。
- **新增**（`.kabegameignore`，学 `.vscodeignore`，作用于引用闭包**之上**）：
  - 普通行 = glob 排除：从收集集剔除匹配项（排到 `main`/清单级文件时报错而非静默）；
  - `!pattern` 行 = 强制追加：从插件目录（恒排 `node_modules/`、`.git/`）额外收入匹配文件——
    覆盖"脚本运行期按路径读包内额外资源"等闭包解析不到的场景；
  - 实现用 `globset` crate（`kabegame-cli` **新依赖**）；文件不存在 = 无操作；v2 路径不启用。
- **新增**（CLI 单测，表驱动）：引用闭包 / doc 图片相对+根相对解析 / 排除 / `!` 追加 /
  引用缺失报错 / 残留 manifest.json 被忽略 / 排掉 `main` 报错。

---

## 点 4 — `--backend` 枚举加 V8 + 结构校验接 v3（`main.rs` 锚点 d）

- **修改**（CLI clap `PluginBackend` `ValueEnum`）：增加 `V8`。此枚举**仅用于 `plugin new --backend`**，
  映射为 cargo-generate 的 `backend` 占位符字符串（点 5）；v3 打包不做后端检测，`script_file_name` 删除。
  - **kbBackend 解析用 core 的 `PluginBackend::from_str`**（3b 已定义，权威后端枚举）；
    pack v3 校验（点 2）与后续调度共用它，CLI clap 枚举 ↔ core 枚举用 `From` 互转，避免两套语义漂移。
- **修改**（`validate_kgpg_structure`）：v3 包——清单走 `read_plugin_manifest`（3b 已覆盖）；
  入口脚本按 zip 内 package.json 的 `main` 路径查非空条目；config 走 `read_plugin_config_public`
  （3b 已覆盖）。v2 包沿用旧判定（`crawl.rhai`/`crawl.js`）。

---

## 点 5 — `plugin new` 用 `cargo-generate` 驱动单一模板 + 条件文件（`main.rs` 锚点 c、e）

> 决策：**放弃手动分子文件夹 + 逐文件拷贝**（锚点 e），改用 `cargo-generate` crate 作为库，
> 单一模板目录 + Liquid 模板 + `cargo-generate.toml` 的 **conditional 文件**按 `backend` 取舍。
> `--backend` 不再对应"选哪个子文件夹"，而是传给模板的 `backend` 占位符值。

- **修改**（`new_plugin`，锚点 c、e）：删除 `write_template_text_to` / `write_template_binary_to` /
  `{{plugin_name}}` 手动替换 / `match args.backend` 分文件夹逻辑；改为把嵌入的 `template/`
  （`include_dir!`）展开到临时目录后调用 `cargo_generate::generate`：

```rust
// backend 来自 clap --backend（默认 v8）→ 作为 cargo-generate 占位符值传入（非交互）
let tmp = tempdir()?;                      // 把 TEMPLATE_DIR 落盘到 tmp（cargo-generate 需要路径）
TEMPLATE_DIR.extract(tmp.path())?;
cargo_generate::generate(GenerateArgs {
    template_path: TemplatePath { path: Some(tmp.path().into()), ..Default::default() },
    name: Some(args.name.clone()),                 // → Liquid {{ project-name }}（== 插件 id）
    destination: Some(cwd),                         // 生成到当前目录/<name>
    define: vec![format!("backend={}", backend_kb_str(args.backend))], // rhai|v8|webview
    vcs: Some(Vcs::None), silent: true, overwrite: false, ..Default::default()
})?;
```

  > `cargo-generate` 是 `kabegame-cli` **新依赖**；注意其依赖树较重（git2 等），
  > CI 三平台构建需回归（对照 `cocs/build/PLATFORM_SHARED_LIBS.md`）。若体积/链接成本过高，
  > 回退方案 = 自研极简 Liquid 子集渲染 + 同一份 `cargo-generate.toml` 语义，但**默认按用户决策上 cargo-generate**。

- **删除**：`template/manifest.json`、`template/rhai/`、`template/webview/`、`template/doc_root/`
  等**所有后端子文件夹**（锚点 e）。
- **新增**：**单一模板目录** `template/`（cargo-generate 工程；文件用 Liquid，二进制原样）：

```
template/
├── cargo-generate.toml   # placeholders(backend 三选一) + conditional 文件取舍规则（下）
├── package.json          # Liquid：按 {% if backend == "v8" %} 决定 main/kbBackend/scripts/devDependencies
├── tsconfig.json         # Liquid：v8 → types:["@kabegame/types"]+lib:["ES2022"]；webview → lib:[...DOM]（rhai 不生成）
├── src/index.ts          # 仅 v8：import { to,... } from "@kabegame/plugin-sdk"; export async function crawl(...)
├── rspack.config.mjs     # 仅 v8：entry src/index.ts → dist/main.js（自包含，target es2022，无 external）
├── crawl.rhai            # 仅 rhai
├── crawl.js              # 仅 webview
├── docs/doc.md           # Liquid：标题带 {{ project-name }}
├── icon.png              # 二进制，原样拷贝
├── .gitignore            # node_modules/ dist/ *.log
└── .kabegameignore       # 示例注释（引用闭包通常够用）
```

```toml
# template/cargo-generate.toml —— backend 决定生成哪些文件（条件文件，而非分文件夹）
[template]
cargo_generate_version = ">=0.20"

[placeholders]
backend = { type = "string", prompt = "backend", choices = ["rhai", "v8", "webview"], default = "v8" }

# v8 专属：非 v8 时忽略
[conditional.'backend != "v8"']
ignore = ["src", "rspack.config.mjs"]

# tsconfig 仅 v8/webview 需要（rhai 无 TS）
[conditional.'backend == "rhai"']
ignore = ["tsconfig.json"]

# 单脚本：只保留所选后端的入口脚本（P3-11）
[conditional.'backend != "rhai"']
ignore = ["crawl.rhai"]
[conditional.'backend != "webview"']
ignore = ["crawl.js"]
```

```jsonc
// template/package.json（Liquid；project-name == 插件 id；三后端共用一份，条件字段区分）
{
  "name": "{{ project-name }}", "version": "0.1.0",
  "description": "{{ project-name }} crawler plugin", "author": "You",
  "private": true,
  "engines": { "kabegame": ">=4.3.0" },
  "kbPackageVersion": 3,
  "kbBackend": "{{ backend }}",
  "kbBaseUrl": "", "kbConfig": [],
  "kbIcon": "icon.png", "kbDoc": { "default": "docs/doc.md" },
{%- if backend == "v8" %}
  "main": "dist/main.js",
  "scripts": { "build": "rspack build" },
  "devDependencies": {
    "@kabegame/plugin-sdk": "^0.1.0", "@kabegame/types": "^0.1.0",
    "@rspack/cli": "^1", "@rspack/core": "^1", "typescript": "^5"
  }
{%- elsif backend == "webview" %}
  "main": "crawl.js",
  "devDependencies": { "@types/web": "^0.0" }
{%- else %}
  "main": "crawl.rhai"
{%- endif %}
}
```

  > v8：`main` = 构建产物 `dist/main.js`（dist 进 `.gitignore`），作者流程
  > `bun install && bun run build && kabegame-cli plugin pack`；`@kabegame/types` 提供 headless v8
  > ambient 全局（3e 点 4）。webview：`main` = `crawl.js`，`tsconfig` 依赖浏览器环境
  > （`lib:["ES2022","DOM","DOM.Iterable"]` + `@types/web`），不依赖 SDK/types（跑真实 Chromium）。
  > rhai：`main` = `crawl.rhai`，无 node 依赖。三者文件名均只是模板默认值，非约定（P3-12）。
- **修改**（`PluginBackend` clap `ValueEnum`）：仅保留 `--backend` 取值（Rhai/V8/Webview）→ 映射到
  `backend` 占位符字符串；不再有 `script_file_name` / 分文件夹用途（点 4）。

---

## 退出标准

- `cargo check -p kabegame-cli` 通过；
- v3 目录 `plugin pack` 产出 `.kgpg`，`plugin import` 装载字段与 package.json 一致（配合 3b）；
- v2 目录 `plugin pack` 行为不变（兼容回归）；
- `.kabegameignore` 排除/`!` 追加、引用缺失报错、越界路径报错（单测覆盖）；
- v3 校验闸：engines `< 4.3.0` / `name` ≠ 目录名 / `kbBackend` 非法 / kb* 含 `..` 均报错；
- `plugin new <name> --backend {rhai,v8,webview}` 经 cargo-generate 各生成对应条件文件集：
  v8 出 `src/index.ts`+`rspack.config.mjs`+`tsconfig.json`（可 `bun install && bun run build`）、
  webview 出 `crawl.js`+`tsconfig(DOM)`、rhai 出 `crawl.rhai`；三者 `package.json` 的 `kbBackend`/`main` 正确；
  均不含 `manifest.json`/被忽略的他后端脚本。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 修改 | `kabegame-cli/src/main.rs` | `new_plugin` 改用 `cargo_generate::generate`（删 `write_template_*`/分文件夹逻辑）；pack 双轨入口；`pack_plugin_v3`（校验 + `derive_header_manifest` + `kbIcon`）；`collect_v3_entries`（引用闭包 + `.kabegameignore`）；`PluginBackend::V8`→backend 占位符；`validate_kgpg_structure` v3 分支；CLI 单测 |
| 修改 | `kabegame-cli/Cargo.toml` | 新增依赖 `globset`、`cargo-generate`、`tempfile` |
| 新增 | `kabegame-cli/template/cargo-generate.toml` | `backend` 占位符 + conditional 文件取舍规则 |
| 新增/修改 | `kabegame-cli/template/*`（单一目录） | Liquid `package.json`/`tsconfig.json`/`docs/doc.md` + 条件文件 `src/index.ts`、`rspack.config.mjs`、`crawl.rhai`、`crawl.js` + `icon.png`/`.gitignore`/`.kabegameignore` |
| 删除 | `kabegame-cli/template/{manifest.json, rhai/, webview/, doc_root/}` | 手动分文件夹产物全部移除 |
