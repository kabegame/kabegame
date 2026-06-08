# Layer 4 · 文档同步层

> 总览见 [plugin-metadata-migration.md](plugin-metadata-migration.md)。在 L1–L3 代码落定后统一同步所有
> 文档，**包括 `apps/docs/`（Starlight）**、仓库 `docs/`、`cocs/` 索引体系与 CHANGELOG，保持一致。

## 范围
覆盖三处文档体系 + 变更日志：
1. `apps/docs/`（面向用户/插件作者的 Starlight 站点，MDX/MD）
2. `docs/`（仓库内插件开发参考）
3. `cocs/`（架构/流程内部索引）
4. `CHANGELOG.md`

## 步骤

### 4.1 apps/docs（Starlight）
- `apps/docs/src/content/docs/dev/rhai-api.md`：
  - `download_image(url, opts)` 的 opts 增 `metadata_version`（纯自然数/缺省 0）。
  - `create_image_metadata` 增 `(m, #{ version: N })` opts 重载说明。
  - 新增 **metadata_migrations** 章节：`metadata_migrations/v{N}.rhai` 脚本契约、`fn migrate(metadata)`
    字符串进出、连续性/失败重试语义、`parse_json`/`to_json` 辅助、复合去重键
    `(plugin_id, version, content_hash)`、执行时机（安装/更新 + 启动）。
- `apps/docs/src/content/docs/reference/rhai-dictionary.md`：补 `download_image` opt、`create_image_metadata`
  重载、`parse_json`/`to_json` 字典条目。
- `apps/docs/src/content/docs/reference/plugin-schema.md`：`.kgpg` 目录结构补
  `metadata_migrations/v{N}.rhai`。
- `apps/docs/src/content/docs/guide/plugins-usage.md`：可补一句「插件更新后会自动迁移历史图片元数据」。
- 若站点有侧栏/索引配置（`astro.config` sidebar 或 autogenerate），无需手动加项；如为手列则补新章节锚点。

### 4.2 仓库 docs/
- `docs/RHAI_API.md`：与 4.1 rhai-api 同步（opts、重载、metadata_migrations 章节）。
- `docs/PLUGIN_FORMAT.md`：`.kgpg` 目录补 `metadata_migrations/v{N}.rhai`。

### 4.3 cocs/
- 新增 `cocs/crawler/METADATA_MIGRATION.md`：流程 + 涉及文件（L1/L2/L3 关键路径）+ 设计理由
  （version/plugin_id 落在 image_metadata、复合去重/合并语义、`metadata_full` 路径/命令、历史迁移冻结约定、
  `metadata-migrate` 事件作用域）。
- `cocs/README.md`：在「爬虫（crawler/）」分区补该条目（链接 + 主题 + 适用场景）。

### 4.4 CHANGELOG
- `CHANGELOG.md` 记录：插件 metadata 迁移支持、`download_image` 新 opt、`create_image_metadata` 重载。

## 一致性校验
- 三处对「脚本契约 / opts / 去重键 / 执行时机」表述一致，无相互矛盾（CLAUDE.md 要求 `.cursor/rules` 与
  `cocs` 同步；本功能不改 cursor 规则则无需动）。
- `apps/docs` 构建/类型检查（若有 `bun check`/`astro check` 对应脚本）通过、无坏链。
