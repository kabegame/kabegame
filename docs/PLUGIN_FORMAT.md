# 插件文件格式设计

## 推荐格式：KGPG（ZIP 兼容）

只支持 **KGPG v3（固定头部 + ZIP）**：`.kgpg` 文件前面是只含 meta 与 icon 的固定大小头部，用于无需解压或通过 HTTP Range 读取 icon；后面是标准 ZIP body（SFX 兼容），插件清单由 ZIP 内 `package.json` 提供。容器版本字段不是 `3` 的包一律拒绝加载。

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

只支持 v3 `package.json` 格式；缺少有效 v3 清单的包与 Rhai 后端均不支持，加载/打包时报可读错误。

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
| `kbPackageVersion` | 是 | 必须为 `3`。缺失或小于 3 会在加载/打包时报可读错误。 |
| `engines.kabegame` | 是 | 最低 Kabegame 版本，只支持 `>= X.Y.Z`，商店索引会派生为 `minAppVersion`。 |
| `main` | 是 | 插件根相对脚本路径。v8 插件用打包产物（如 `dist/main.js`），webview 插件用 `crawl.js`。 |
| `kbBackend` | 是 | 脚本后端：`v8`、`webview`。JS 插件默认应显式写 `v8`；只有确实需要浏览器窗口/DOM/Cookie 容器时才使用 `webview`。（`rhai` 已停止支持。） |
| `kbBaseUrl` | 否 | 旧 `config.json.baseUrl`。 |
| `kbLabels` | 否 | 插件声明的标签数组；应用按内置支持列表渲染标签文案和颜色。 |
| `kbConfig` | 否 | 旧 `config.json.var` 数组。 |
| `kbIcon` | 否 | 插件图标路径，通常为 `icon.png`。打包时会写入 KGPG v3 固定头部。 |
| `kbDoc` | 否 | 文档映射；`default` 对应默认文档，其他键为语言码。值为插件根相对路径，如 `doc_root/doc.ja.md`。 |
| `kbRecommendedConfigs` | 否 | 推荐运行配置文件路径数组。 |
| `kbPathQLProviders` | 否 | Provider DSL 文件路径数组。 |
| `kbMetadataMigration` | 否 | 单一 metadata 迁移脚本路径（`.js`，ES module，`export function migrate(input)`，需幂等一步到位；详见 cocs/crawler/METADATA_MIGRATION.md）。旧 `kbMetadataMigrations` 数组已停止支持：打包报可读错误，加载不解析。 |
| `kbDescriptionTemplate` | 否 | 图片详情 EJS 模板路径。 |

### 插件标签（`kbLabels`）

`kbLabels` 的格式为 `[{ id, name?, desc? }, ...]`。预定义标签只需声明 `id`；命中应用内置支持列表后，标签文案与颜色由应用 i18n 和内置配置提供，`name` / `desc` 可以省略。应用不认识的未知标签才需要用可选的 `name` / `desc` 提供回落文案，回落标签使用灰色。

当前内置标签 id 为：`auth.needCookie`、`auth.needProxy`、`content.res.mobile`、`content.res.desktop`、`content.nsfw`、`content.type.video`。应用还会按 `minAppVersion` 自动判定并合成 `app.versionIncompatible` 标签；该标签不由插件声明。

```json
"kbLabels": [
  { "id": "auth.needCookie" },
  { "id": "content.nsfw" }
]
```

所有 `kb*` 路径字段都按插件根相对解析，禁止绝对路径、盘符和 `..`。`kbDoc` 中 Markdown 引用的本地图片会按文档所在目录解析；仅打包引用到且存在的图片资源，并受单文件 2 MB、总量 10 MB 的加载限制。

### `.kabegameignore`

v3 打包会先按 `package.json` 显式字段收集文件，再应用插件根目录下的 `.kabegameignore`。语法是简单 glob，每行一条，空行、`#` 和 `//` 注释会被忽略；以 `!` 开头的规则会强制重新包含匹配文件。`package.json`、`main` 和 `kbDoc` 明确引用的文档属于关键文件，不能被 ignore 排除。

### 头部与插件清单

KGPG v3 固定头部只存 meta 与 icon，不存插件清单。完整安装、导入和运行均以 ZIP 内 `package.json` 为准；商店快捷显示所需的清单信息来自 `index.json`。

### 固定头部优势
1. **无需解压即可取 icon**：客户端只需读取固定偏移的数据块
2. **支持 HTTP Range**：商店列表可只拉取头部，不再依赖额外的 `<id>.icon.png` 资产
3. **保持 ZIP 兼容**：插件清单继续从 ZIP 内 `package.json` 读取，通用 ZIP 工具也能直接打开

## KGPG v3 固定头部规范（用于 Range 读取）

固定头部总大小：**49216 bytes**

- meta：64 bytes，偏移 `0..64`
- icon：`128 * 128 * 3 = 49152 bytes`，偏移 `64..49216`（RGB24，无 alpha，行优先，从上到下、从左到右）
- ZIP body：从偏移 `49216` 开始

### meta（64 bytes，小端）
- `magic`：偏移 `0..4`，4B，固定 `"KGPG"`
- `version`：偏移 `4..6`，u16，固定 `3`
- `meta_size`：偏移 `6..8`，u16，固定 `64`
- `icon_w`：偏移 `8..10`，u16，固定 `128`
- `icon_h`：偏移 `10..12`，u16，固定 `128`
- `pixel_format`：偏移 `12`，u8，固定 `1`（表示 RGB24）
- `flags`：偏移 `13`，u8
  - bit0：icon_present
- 保留：偏移 `14..16`，u16（填 0）
- `zip_offset`：偏移 `16..24`，u64，固定等于 `49216`
- 其余：偏移 `24..64`，保留填 0

### HTTP Range 示例
- 拉取 meta + icon（一次请求拿完整头部）：`Range: bytes=0-49215`
- 仅拉取 icon：`Range: bytes=64-49215`

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

- **V8 宿主 Cookie**：`Kabegame.requireCookie(host?): boolean` 从用户已访问并登录的畅游站点持久化记录中取 Cookie，注入当前任务请求头；省略 `host` 时使用插件 `baseUrl` 的 host，且 Cookie 明文不会返回脚本。

### 插件私有文件系统：`Kabegame.fs`

插件不能看到宿主物理目录。每次任务用 `Kabegame.fs.getRoot()` 取得形如 `/{handle}` 的虚拟根，再拼接以下挂载点：

| 虚拟路径 | 用途与生命周期 |
|---|---|
| `${root}/data/...` | 持久数据；应用重启、插件升级或覆盖安装后保留，卸载插件时清理。 |
| `${root}/cache/...` | 可重建缓存；可能被应用或系统清理，卸载插件时也会清理。 |
| `${root}/tmp/...` | 临时工作文件；**当前不会自动清理**，插件应自行管理和删除，卸载插件时清理。 |

权限也按路径层级固定：`/` 拒绝访问，`/{handle}` 只读，三个挂载点内部可读写。路径会先做词法规范化并拒绝越界和软链接；不要依赖 `..`、软链接或宿主绝对路径。任务 handle 每次随机生成，任务结束后旧路径即失效，因此不要持久化 `root` 或任何 `/{handle}/...` 路径；下一任务应重新调用 `getRoot()`。

V8 后端暴露完整 `deno_fs` API，包括 `open`、`create`、同步方法和 `FsFile` 句柄；`umask` 因会修改进程级状态而始终被拒绝。WebView 后端不是同一套完整 API，只提供无句柄异步子集：`readFile`、`writeFile`、`mkdir`、`readDir`、`remove`、`stat`、`getRoot`。V8 的 `getRoot()` 同步返回字符串，WebView 的 `getRoot()` 返回 Promise。

典型场景是下载压缩包，在插件自带的纯 JS 解压器中展开，再把文件交给下载器入库：

```js
// unzip 是插件自行打包的纯 JS helper，不是 Kabegame 内建 API。
export async function crawl() {
  const root = Kabegame.fs.getRoot();
  const response = await fetch("https://example.test/wallpapers.zip");
  const archive = new Uint8Array(await response.arrayBuffer());
  const files = unzip(archive);

  const imagePath = `${root}/data/x.jpg`;
  await Kabegame.fs.writeFile(imagePath, files["x.jpg"]);
  await Kabegame.downloadImage(imagePath, { name: "x" });
}
```

批量解压时应逐项校验 ZIP entry 名称，并为每个文件重复 `writeFile` / `downloadImage`。`downloadImage` 接受当前任务的虚拟路径；不要自行构造内部 `task-vfs://` URL。

- **JS 脚本（crawl.js，WebView 后端）**：仅用于需要浏览器窗口/DOM/Cookie 容器的插件；变量通过运行时注入的 `ctx.vars` 访问。

### 加载与运行策略
- **一次性加载**：已安装插件在首次列出时（或通过 `refresh_plugins`）被 `parse_kgpg` 一次性解析：`package.json`、`doc_root/*.md`、`doc_root/*` 图片资源、`main` 脚本内容、`templates/description.ejs`、`configs/*.json` 均被读入内存并挂在 `Plugin` 结构体上。
- **运行阶段**：爬取任务、文档图片、变量定义等均直接从内存读取，不再重新打开 `.kgpg` ZIP（临时预览/导入时例外）。
- **磁盘保留**：`.kgpg` 文件仍保留在插件目录（`Plugin.file_path`），用于插件升级、导出等操作。
