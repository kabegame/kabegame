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
        └── doc.md           # 插件文档，给用户查看，文档中的根目录为 doc_root。文档中的路径解析只允许在 doc_root 之下
```

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
- `doc_root/doc.md` - 可选，用户文档

### 快速展开策略
1. **读取阶段**：只读取 `manifest.json` 获取基本信息（用于列表展示）
2. **安装阶段**：解压到临时目录，验证后移动到正式目录
3. **使用阶段**：直接读取解压后的文件，无需再次解压

