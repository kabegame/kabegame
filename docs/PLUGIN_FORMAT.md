# 插件文件格式设计

## 推荐格式：KGPG（ZIP 兼容）

目前支持两种形态：

1. **KGPG v1（纯 ZIP）**：文件扩展名 `.kgpg`，内容就是标准 ZIP。
2. **KGPG v2（固定头部 + ZIP）**：`.kgpg` 文件前面加一个**固定大小头部**（用于无需解压/可 Range 读取 icon + manifest），后面仍然是标准 ZIP（SFX 兼容）。

### 文件结构（ZIP 内部）
```
plugin-name.kgpg
    - package.json             # v3 自描述清单（唯一支持的格式）
    - dist/main.js / crawl.js  # package.json main 指向的脚本（v8 打包产物 / webview 脚本）
    - doc_root/                # 文档目录（可选）
        └── doc.md             # 插件文档，给用户查看。使用标准 Markdown 渲染（GFM），文档中的根目录为 doc_root，路径解析只允许在 doc_root 之下
    - configs/                 # 推荐配置
    - metadata_migrations/     # 图片 metadata 迁移脚本（可选）
        └── migrate.js         # kbMetadataMigration 指向的单一脚本（ES module，export migrate）
    - templates/               # 插件提供模板
```

只支持 v3 `package.json` 格式；旧版 manifest.json (v2) 与 Rhai 后端均已停止支持，加载/打包时报可读错误。

### templates/description.ejs（图片详情 HTML）

- 由 `ImageDetailContent.vue` 用 EJS 将 `metadata` 渲染为 HTML 后写入 iframe `srcdoc`。
- 框架在模板内容**之前**自动注入脚本，提供 **`window.__bridge.fetch(url, options)`**（如 `headers`、`json: true` 解析 JSON）：通过 `postMessage` 由主窗口调用 Tauri 命令 **`proxy_fetch`** 发起 HTTP GET，绕过浏览器 CORS；插件模板内可直接调用，无需手写 postMessage。
- 约定：`metadata` 由爬取脚本在 `download_image` 时传入（如 PixAI 存完整 `listArtworks` 的 `node`）。

## 清单 v3：package.json 自描述

v3 插件以 `package.json` 为唯一清单。判定规则是 `kbPackageVersion >= 3`；当前打包器要求 `kbPackageVersion` 精确为 `3`。插件目录名、`.kgpg` 输出文件名 stem 和 `package.json.name` 必须一致。

```json
{
  "name": "anime-pictures",
  "version": "1.0.0",
  "private": true,
  "name.zh": "anime-pictures动漫图库",
  "name.en": "anime-pictures anime gallery",
  "description": "插件描述",
  "author": "Kabegame",
  "kbPackageVersion": 3,
  "engines": {
    "kabegame": ">=4.3.0"
  },
  "main": "crawl.js",
  "kbBackend": "v8",
  "kbBaseUrl": "https://example.com",
  "kbConfig": [],
  "kbIcon": "icon.png",
  "kbDoc": {
    "default": "doc_root/doc.md",
    "en": "doc_root/doc.en.md"
  },
  "kbRecommendedConfigs": ["configs/every-day.json"],
  "kbPathQLProviders": ["providers/entry_provider.json5"],
  "kbMetadataMigration": "metadata_migrations/migrate.js",
  "kbDescriptionTemplate": "templates/description.ejs"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 插件包名，必须等于插件目录名和输出 `.kgpg` stem。内置插件作为 `src-crawler-plugins` workspace 子包管理，因此这里也是 monorepo 包名。 |
| `version` | 是 | 插件 semver，必须是 `a.b.c` 且每段 ≤255（应用将其 packed 编码为 u32 记录到 `image_metadata.plugin_version` 并做迁移门控）。 |
| `private` | 否 | 内置插件建议为 `true`，避免作为 npm 包发布。 |
| `name.*` / `description.*` | 否 | 扁平 i18n 键。`name` 自身已被包名占用；本地化展示名使用 `name.zh`、`name.en` 等。`description` 可作为默认描述。 |
| `author` | 否 | 字符串或 `{ "name": "..." }`。 |
| `kbPackageVersion` | 是 | 必须为 `3`。缺失或小于 3（旧版 manifest.json / v2）会在加载/打包时报可读错误。 |
| `engines.kabegame` | 是 | 最低 Kabegame 版本，只支持 `>= X.Y.Z`，打包头部与商店索引会派生为 `minAppVersion`。 |
| `main` | 是 | 插件根相对脚本路径。v8 插件用打包产物（如 `dist/main.js`），webview 插件用 `crawl.js`。 |
| `kbBackend` | 是 | 脚本后端：`v8`、`webview`。JS 插件默认应显式写 `v8`；只有确实需要浏览器窗口/DOM/Cookie 容器时才使用 `webview`。（`rhai` 已停止支持。） |
| `kbBaseUrl` | 否 | 旧 `config.json.baseUrl`。 |
| `kbConfig` | 否 | 旧 `config.json.var` 数组。 |
| `kbIcon` | 否 | 插件图标路径，通常为 `icon.png`。打包时会写入 KGPG v2 固定头部。 |
| `kbDoc` | 否 | 文档映射；`default` 对应默认文档，其他键为语言码。值为插件根相对路径，如 `doc_root/doc.ja.md`。 |
| `kbRecommendedConfigs` | 否 | 推荐运行配置文件路径数组。 |
| `kbPathQLProviders` | 否 | Provider DSL 文件路径数组。 |
| `kbMetadataMigration` | 否 | 单一 metadata 迁移脚本路径（`.js`，ES module，`export function migrate(input)`，需幂等一步到位；详见 cocs/crawler/METADATA_MIGRATION.md）。旧 `kbMetadataMigrations` 数组已停止支持：打包报可读错误，加载不解析。 |
| `kbDescriptionTemplate` | 否 | 图片详情 EJS 模板路径。 |

所有 `kb*` 路径字段都按插件根相对解析，禁止绝对路径、盘符和 `..`。`kbDoc` 中 Markdown 引用的本地图片会按文档所在目录解析；仅打包引用到且存在的图片资源，并受单文件 2 MB、总量 10 MB 的加载限制。

### `.kabegameignore`

v3 打包会先按 `package.json` 显式字段收集文件，再应用插件根目录下的 `.kabegameignore`。语法是简单 glob，每行一条，空行、`#` 和 `//` 注释会被忽略；以 `!` 开头的规则会强制重新包含匹配文件。`package.json`、`main` 和 `kbDoc` 明确引用的文档属于关键文件，不能被 ignore 排除。

### 头部派生清单

KGPG v2 固定头部不直接存完整 `package.json`，而是从 v3 清单派生最小 manifest：`version`、`author`、`minAppVersion`、`name.*`、`description.*`。客户端商店列表可以通过 HTTP Range 读取该头部；完整安装和运行仍以 ZIP 内 `package.json` 为准。

### legacy v2 manifest.json 格式

v2 清单继续兼容，但仅用于旧插件。新插件不要再新增 `manifest.json` / `config.json`。

```json
{
  "name": "插件名称",
  "version": "1.0.0",
  "description": "插件描述",
  "author": "作者名"
}
```

### v2 额外优势（固定头部）
1. **无需解压即可取 icon/manifest**：客户端只需读取固定偏移的数据块
2. **支持 HTTP Range**：商店列表可只拉取头部，不再依赖额外的 `<id>.icon.png` 资产
3. **保持 ZIP 兼容**：旧逻辑仍可当作 ZIP 读取 `manifest.json/icon.png` 等条目

## KGPG v2 固定头部规范（用于 Range 读取）

固定头部总大小：**53312 bytes**

- meta：64 bytes
- icon：`128 * 128 * 3 = 49152 bytes`（RGB24，无 alpha，行优先，从上到下、从左到右）
- manifest：4096 bytes（UTF-8 JSON，剩余用 `0x00` 填充）

### meta（64 bytes，小端）
- `magic`：4B，固定 `"KGPG"`
- `version`：u16，固定 `2`
- `meta_size`：u16，固定 `64`
- `icon_w`：u16，固定 `128`
- `icon_h`：u16，固定 `128`
- `pixel_format`：u8，固定 `1`（表示 RGB24）
- `flags`：u8
  - bit0：icon_present
  - bit1：manifest_present
- `manifest_len`：u16（0~4096）
- `zip_offset`：u64（预留字段，当前固定等于 53312）
- 其余：保留填 0

### HTTP Range 示例
- 拉取 icon + manifest（一次请求拿完整头部）：`Range: bytes=0-53311`
- 仅拉取 icon：`Range: bytes=64-49215`
- 仅拉取 manifest 槽位：`Range: bytes=49216-53311`

## 替代方案对比

## 推荐实现

使用 **ZIP 格式**，文件扩展名 `.kgpg`，内部结构：
- `package.json` - v3 必需，包含插件元数据、配置、资源路径和后端声明
- `dist/main.js` / `crawl.js` - `main` 指向的爬取脚本（v8 打包产物 / webview 脚本）
- `metadata_migrations/migrate.js` - 可选，`kbMetadataMigration` 指向的单一图片 metadata 迁移脚本（ES module，export migrate）
- `doc_root/doc.md` - 可选，用户文档（基于标准 Markdown/GFM 渲染，图片路径仅允许 doc_root 内相对路径）
- `doc_root/<image>` - 可选，文档引用的图片资源（jpg/jpeg/png/gif/webp/bmp）

  这些非 .md 文件在插件解析时会被一次性读入内存，经 base64 编码后以 `Plugin.docResources` 字段下发给前端（相对 doc_root 的路径为 key）。为避免内存膨胀，对单个文件有 **2 MB** 上限（CLI 打包阶段即会跳过超限文件并警告）、单插件所有资源合计 **10 MB** 上限（解析阶段超出后续文件不再收录）。

### kbConfig 与变量在脚本中的访问

- **JS 脚本（V8 后端）**：脚本必须导出 `async function crawl(common, custom)`；`kbConfig` 中定义的变量通过第二个参数 `custom` 访问，键为每条变量定义的 `key`。V8 脚本是自包含 ES module，不依赖浏览器 DOM/WebView 环境。宿主 API 详见 [cocs/crawler/V8_RUNTIME.md](../cocs/crawler/V8_RUNTIME.md)。例如：

  ```js
  // kbConfig 中有 key 为 startPage、endPage、tag 的变量时：
  export async function crawl(common, custom) {
    const startPage = custom?.startPage ?? 0;
    const endPage = custom?.endPage ?? 0;
    const tag = custom?.tag ?? "";
    console.log(common.base_url, startPage, endPage, tag);
  }
  ```

- **JS 脚本（crawl.js，WebView 后端）**：仅用于需要浏览器窗口/DOM/Cookie 容器的插件；变量通过运行时注入的 `ctx.vars` 访问。

### 加载与运行策略
- **一次性加载**：已安装插件在首次列出时（或通过 `refresh_plugins`）被 `parse_kgpg` 一次性解析：`package.json`、`doc_root/*.md`、`doc_root/*` 图片资源、`main` 脚本内容、`templates/description.ejs`、`configs/*.json` 均被读入内存并挂在 `Plugin` 结构体上。
- **运行阶段**：爬取任务、文档图片、变量定义等均直接从内存读取，不再重新打开 `.kgpg` ZIP（临时预览/导入时例外）。
- **磁盘保留**：`.kgpg` 文件仍保留在插件目录（`Plugin.file_path`），用于插件升级、导出等操作。
