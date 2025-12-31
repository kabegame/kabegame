# 插件文件格式设计

## 推荐格式：ZIP 归档

### 文件结构
```
plugin-name.kgpg
    - manifest.json          # 插件元数据（必需）
    - icon.png               # 插件图标（可选）
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

### 优势
1. **快速读取**：使用 `zip::ZipArchive` 可以只读取目录，无需解压
2. **按需加载**：可以只读取 `manifest.json` 获取基本信息
3. **多文件支持**：可以包含图标、脚本等资源
4. **压缩存储**：自动压缩，节省空间

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

