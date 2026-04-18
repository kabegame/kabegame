# 插件文件格式设计

## 推荐格式：KGPG（ZIP 兼容）

目前支持两种形态：

1. **KGPG v1（纯 ZIP）**：文件扩展名 `.kgpg`，内容就是标准 ZIP。
2. **KGPG v2（固定头部 + ZIP）**：`.kgpg` 文件前面加一个**固定大小头部**（用于无需解压/可 Range 读取 icon + manifest），后面仍然是标准 ZIP（SFX 兼容）。

### 文件结构（ZIP 内部）
```
plugin-name.kgpg
    - manifest.json          # 插件元数据（必需）
    - icon.png               # 插件图标（可选，v1 兼容；v2 不再写入 ZIP，图标在固定头部）
    - config.json            # 插件配置（可选）
    - crawl.rhai             # 爬取脚本（Rhai 脚本格式，必需）
    - doc_root/              # 文档目录（可选）
        └── doc.md           # 插件文档，给用户查看。使用标准 Markdown 渲染（GFM），文档中的根目录为 doc_root，路径解析只允许在 doc_root 之下
    - configs/               # 推荐配置
    - templates/             # 插件提供模板
```

### templates/description.ejs（图片详情 HTML）

- 由 `ImageDetailContent.vue` 用 EJS 将 `metadata` 渲染为 HTML 后写入 iframe `srcdoc`。
- 框架在模板内容**之前**自动注入脚本，提供 **`window.__bridge.fetch(url, options)`**（如 `headers`、`json: true` 解析 JSON）：通过 `postMessage` 由主窗口调用 Tauri 命令 **`proxy_fetch`** 发起 HTTP GET，绕过浏览器 CORS；插件模板内可直接调用，无需手写 postMessage。
- 约定：`metadata` 由爬取脚本在 `download_image` 时传入（如 PixAI 存完整 `listArtworks` 的 `node`）。

### manifest.json 格式
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
- `manifest.json` - 必需，包含插件元数据
- `crawl.rhai` - 必需，爬取脚本（Rhai 脚本格式）
- `icon.png` - 可选，插件图标（仅支持 PNG）
- `config.json` - 可选，插件配置
- `doc_root/doc.md` - 可选，用户文档（基于标准 Markdown/GFM 渲染，图片路径仅允许 doc_root 内相对路径）
- `doc_root/<image>` - 可选，文档引用的图片资源（jpg/jpeg/png/gif/webp/bmp）

  这些非 .md 文件在插件解析时会被一次性读入内存，经 base64 编码后以 `Plugin.docResources` 字段下发给前端（相对 doc_root 的路径为 key）。为避免内存膨胀，对单个文件有 **2 MB** 上限（CLI 打包阶段即会跳过超限文件并警告）、单插件所有资源合计 **10 MB** 上限（解析阶段超出后续文件不再收录）。

### config.json 与变量在脚本中的访问

- **Rhai 脚本（crawl.rhai）**：`config.json` 的 `var` 中定义的变量会直接注入为脚本内的同名变量，详见 [RHAI_API.md](./RHAI_API.md)。
- **JS 脚本（crawl.js，WebView 后端）**：变量通过全局上下文 **`ctx.vars`** 访问。`ctx` 由运行时注入（`window.__crawl_ctx__`），`ctx.vars` 是一个只读对象，键为 `config.json` 里每条 `var` 的 `key`。例如：

  ```js
  // config.json 中有 key 为 startPage、endPage、tag 的 var 时：
  const startPage = ctx.vars?.startPage ?? 0;
  const endPage   = ctx.vars?.endPage ?? 0;
  const tag       = ctx.vars?.tag ?? "";
  ```

### 加载与运行策略
- **一次性加载**：已安装插件在首次列出时（或通过 `refresh_plugins`）被 `parse_kgpg` 一次性解析：`manifest.json`、`config.json`、`doc_root/*.md`、`doc_root/*` 图片资源、`crawl.rhai` / `crawl.js` 脚本内容、`templates/description.ejs`、`configs/*.json` 均被读入内存并挂在 `Plugin` 结构体上。
- **运行阶段**：爬取任务、文档图片、变量定义等均直接从内存读取，不再重新打开 `.kgpg` ZIP（临时预览/导入时例外）。
- **磁盘保留**：`.kgpg` 文件仍保留在插件目录（`Plugin.file_path`），用于插件升级、导出等操作。

