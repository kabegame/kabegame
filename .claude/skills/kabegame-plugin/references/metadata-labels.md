# metadata、labels 与 description.ejs

完整范例：`src-crawler-plugins/plugins/e-shuushuu/`（`src/index.ts` 的 `buildMetadata` /
`labelsFromTags`，以及 `templates/description.ejs`）。更复杂的参考：danbooru、pixiv。
权威来源：`packages/kabegame-types/lib.kabegame.d.ts`（`KabegameDownloadImageOptions` /
`KabegameLabelInput`）、`cocs/gallery/LABEL_ALBUMS.md`、`cocs/plugins/PLUGIN_DESCRIPTION_TEMPLATE_BRIDGE.md`。

## 传给 downloadImage 的三样东西

```ts
await Kabegame.downloadImage(originalUrl, {
  name: "角色名 #123",          // 展示名
  url: "https://site/post/123", // 作品页，app 里「源」链接
  metadata: { schema: 1, … },   // 或者 metadata_id: createImageMetadata(...)（一个作品多张图时共用）
  labels: [{ key, category, name }, …],
});
```

## metadata：足以还原详情页

- 顶层带 `schema: 1`。以后结构要变时，配合 `kbMetadataMigration` 迁移脚本按 schema 升级
  （见 `cocs/crawler/METADATA_MIGRATION.md`）。
- 以**源站详情页**为准，逐块对照：作者/上传者（id、名字、头像 URL、头衔、用户组）、标签
  （保留 id、原名、分类，并保持站点顺序）、尺寸/大小/格式、评分（分数**和**票数）、收藏数、出处、
  简介、发布时间、评论（作者、时间、正文、回复关系）。模板只能读到 metadata，这里缺的字段模板就画不出来。
- 存原始值，格式化交给模板：存字节数而不是 "2.77 MB"、存 ISO 时间而不是 "3 days ago"。
- 不存只和当前访客有关的字段（是否已收藏、我的评分、举报状态），也不存会话 token。
- 额外请求（如评论接口）只在源数据表明有内容时才发（例如 `posts > 0`），失败就 `warn` 并留空，
  不要让下载本身失败。
- 一个作品多张图时，用 `createImageMetadata(obj)` 建一次、各图传 `metadata_id`，不要每张重复存。

## labels：站点标签 → 标签画册

```ts
{ key: "long hair", category: "e-shuushuu/theme", name: "long hair" }
```

- `category`：`<插件id>/<分类>`，`/` 分层，每段都是合法 key。分类用站点自己的标签类型
  （artist / character / source / copyright / theme / general…），固定成一个小集合；
  未知类型并入其中一个，免得目录越长越多。
- `key`：只允许 `[a-zA-Z0-9_-]`、英文括号和空格（空格不在首尾、不连续），≤ 64 字节；同级不区分大小写唯一。
  宿主**只拒绝、不修正**，所以插件自己派生：转小写、去掉字符集之外的字符、折叠空白；派生为空或超长就跳过这个标签。
  非 ASCII 为主的站点（中日文标签）不能简单丢字符，要用确定性编码或稳定 id 作 key（参考 pixiv：假名转罗马字、
  其余编码成 `u-...`；作者用 UID 作 key）。
- `name`：原始显示名（可以是任意语言），只在创建标签时生效。
- 去重命中时，labels 只在「去重时更新元数据」开启的情况下才补挂。

## description.ejs：还原源站详情样式

- 在 `package.json` 里登记 `"kbDescriptionTemplate": "templates/description.ejs"`，打包时会收进 `.kgpg`。
- 渲染方式：`ejs.render(tpl, { metadata })`，结果写进 iframe 的 `srcdoc`，显示在预览的「插件详情」面板
  （宽度较窄，卡片要竖排、标签要能换行）。
- 应用没有主题切换，直接使用源站的**亮色**配色。配色变量从源站 CSS 里抠（标签分类色、卡片底色、
  边框、用户组颜色），版式照源站详情页的分块来：例如右侧卡片 + 下方评论区。
- 用 `<%= %>` 输出所有站点文本（自动转义）；评论这类富文本优先存纯文本版、用 `white-space:pre-wrap` 显示，
  不要把站点 HTML 用 `<%- %>` 原样插进 iframe。
- 外链图片（头像等）可以直接用 `<img>`（iframe CSP 是 `img-src *`），加 `referrerpolicy="no-referrer"`；
  需要 Referer 或 Cookie 的图要经 `window.__bridge.fetch` 拉成 blob（参考 pixiv 模板）。
- 链接用 `target="_blank"`，应用会接管 iframe 里的 `<a>` 点击并用外部浏览器打开。
- 模板里的 `<script>` 会被注入 nonce，可以用，但能在 EJS 里算出来的（日期格式化、相对时间）就别放到脚本里。

## 查库验证

release CLI 的库在系统数据目录：macOS 是 `~/Library/Application Support/Kabegame/images.db`，
Linux 是 `~/.local/share/Kabegame/images.db`。`run-cli.sh` 的测试 id 默认是 `<id>-test`。

```bash
DB="$HOME/Library/Application Support/Kabegame/images.db"
T=$(sqlite3 -readonly "$DB" "select id from tasks where plugin_id='<id>-test' order by start_time desc limit 1")
# 每张图都有 metadata
sqlite3 -readonly "$DB" "select count(*), count(metadata_id) from images where task_id='$T'"
# 抽一条看字段
sqlite3 -readonly "$DB" "select m.data from images i join metadata m on m.id=i.metadata_id where i.task_id='$T' limit 1"
# labels：本次图片挂上的标签，按路径计数
sqlite3 -readonly "$DB" "select a.label_path, count(*) from album_images ai join albums a on a.id=ai.album_id
  join images i on i.id=ai.image_id where i.task_id='$T' and a.type='label' group by 1 order by 2 desc limit 10"
```
