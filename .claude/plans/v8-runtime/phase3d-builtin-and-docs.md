# Phase 3d — 内置 12 插件迁移 v3 + generate-index + 文档收口（逐点实施方案）

> Phase 3 子阶段；总览与决策见 [phase3-overview.md](./phase3-overview.md)。
> 依赖 [3b](./phase3b-core-loader.md)（装载）+ [3c](./phase3c-cli-packer.md)（打包）就绪。
> 目标：把 `src-crawler-plugins/` 12 个内置插件迁到 v3（脚本本体不动）、`generate-index.ts`
> 跟进、补文档与总 plan 收口。验证：`bun package` + `bun generate-index` 全绿。

---

## 现状锚点

**a. 内置插件目录布局**（`src-crawler-plugins/plugins/anime-pictures/`；12 个同构）

```jsonc
// manifest.json：name/name.zh/.../version/minAppVersion/description.*/author
// config.json：{ "baseUrl": ..., "var": [ {key,type,name,name.en,...,default,min,max} ] }
// package.json：现状仅 { "name": "kgpg-anime-pictures", "version": "0.1.0", "private": true }
// 目录约定：icon.png / doc_root/ / configs/ / providers/ / metadata_migrations/v{N}.rhai / templates/
// 注意：部分插件同时有 crawl.js + crawl.rhai（现状打包器 webview 优先、只装一个）
```

12 个：anihonet-wallpaper、anime-pictures、bilibili、heybox、konachan、miyoushe、
pixai、pixiv、twodwallpapers、wallpapers-craft、wallspic、ziworld。

**b. `generate-index.ts`：读 manifest.json、`packageVersion` 写死 2、无 minAppVersion**
（`src-crawler-plugins/generate-index.ts:175`）

```ts
const manifestPath = path.join(pluginDir, "manifest.json");
const pluginInfo: PluginInfo = {
  id: pluginName, version: manifest.version || "1.0.0",
  author: (manifest.author as string) || "", packageVersion: 2, /* ... */
};
copyFlatI18nKeys(manifestRaw, pluginInfo, "name");
copyFlatI18nKeys(manifestRaw, pluginInfo, "description");
```

**c. `package-plugin.ts`**：仅 shell `kabegame-cli plugin pack`（双轨对它透明，不改）。

**d. store 解析已读 minAppVersion**（`kabegame-core` `mod.rs:1165`）：index 补 `minAppVersion`
键即被消费，无需 core 改动（3b 已提）。

---

## 点 1 — 一次性迁移脚本（`src-crawler-plugins/scripts/migrate-v3.ts`，**新增**，跑完可删）

- **新增**：对每个 `plugins/*/`，从 `manifest.json` + `config.json` + 目录约定生成 v3 `package.json`：
  - `name` ← 目录名（由 `kgpg-<id>` 改为 `<id>`，P3-7）；`version` ← manifest.version；
    `author`/`description` + 顶层扁平 i18n 键（manifest 原样搬，P3-6）；
  - `kbPackageVersion: 3`；`engines: { "kabegame": ">=4.3.0" }`（原 minAppVersion 一律升 4.3.0，P3-5）；
  - `kbBaseUrl` ← config.json `baseUrl`；`kbConfig` ← config.json `var`；
  - **`main` + `kbBackend`**（单后端，P3-11）：有 `crawl.js` 者取 `main:"crawl.js"`/`kbBackend:"webview"`
    （对齐现状 webview 优先），否则 `main:"crawl.rhai"`/`kbBackend:"rhai"`；被舍弃侧脚本文件留在仓库但不入包；
  - `kbIcon: "icon.png"`；
  - `kbDoc` ← `doc_root/doc.md`/`doc.<lang>.md` 逐语言列出（`doc.md`→`default`）；
  - `kbRecommendedConfigs` ← `configs/*.json` 枚举；
  - `kbPathQLProviders` ← `providers/` 下 provider 文件枚举；
  - `kbMetadataMigrations` ← `metadata_migrations/v{N}.rhai` **按 N 升序**列出，
    **断言 N 从 1 连续**（断档则中止、人工处理，P3-14）；
  - `kbDescriptionTemplate` ← `templates/description.ejs`（存在时）。
- **删除**（脚本执行后）：每个插件的 `manifest.json`、`config.json`
  （其余文件布局不动——路径已被字段显式引用）。

---

## 点 2 — `generate-index.ts` 跟进（锚点 b）

- **修改**：清单来源 `manifest.json` → `package.json`（`copyFlatI18nKeys` 原样复用，顶层扁平键同形）；
- **修改**：`packageVersion` 不再写死——读 `kbPackageVersion`（缺失回退 2）；
- **新增**：index 条目 `minAppVersion` ← `engines.kabegame` 归一化（core 侧已消费，锚点 d）。
- **不改**：`package-plugin.ts`（锚点 c）。

---

## 点 3 — 文档与总 plan 收口

- **修改**：`docs/PLUGIN_FORMAT.md`——增"清单 v3（package.json 自描述）"章节：字段表（P3-15 定名）、
  v2/v3 判定（`kbPackageVersion`）、kbDoc 资源解析规则（相对/根相对）、`.kabegameignore` 语义、
  头部派生清单说明；v2 标注 legacy。
  > `docs/JS_API.md`、`README_PLUGIN_DEV.md` 全面改写仍留 Phase 6（总 plan 分工不变）。
- **不改（本子阶段）**：`v8-runtime-master-plan.md` 的 Decision Log 与 Phase 3 节
  （已在拆分时更新指向 [phase3-overview.md](./phase3-overview.md)）。
- `cocs/README.md` 暂不动（cocs 收实现后流程文档，Phase 3 全部落地后按维护规则补索引）。

---

## 退出标准

- 12 个插件目录只剩 v3 `package.json`（无 manifest.json/config.json），字段完整；
- `bun package`（→ `kabegame-cli plugin pack`）对 12 插件全绿，产出 v3 `.kgpg`；
- `bun generate-index` 生成的 `packed/index.json` 每条 `packageVersion: 3` 且带 `minAppVersion: "4.3.0"`；
- 安装任一内置 v3 `.kgpg`：name/i18n/vars/base_url/doc/推荐配置/providers/迁移脚本与迁移前等价
  （对照迁移前 v2 安装结果做一次抽查）。

---

## 交付物清单

| 类型 | 路径 | 内容 |
|------|------|------|
| 新增 | `src-crawler-plugins/scripts/migrate-v3.ts` | 一次性迁移器（manifest+config+目录约定 → v3 package.json），跑完可删 |
| 修改/删除 | `src-crawler-plugins/plugins/*/`（12 个） | 生成 v3 package.json；删 manifest.json + config.json |
| 修改 | `src-crawler-plugins/generate-index.ts` | 读 package.json；`packageVersion` ← `kbPackageVersion`；新增 `minAppVersion` |
| 修改 | `docs/PLUGIN_FORMAT.md` | v3 清单章节（字段表 / v2-v3 判定 / kbDoc 解析 / `.kabegameignore` / 头部派生） |
