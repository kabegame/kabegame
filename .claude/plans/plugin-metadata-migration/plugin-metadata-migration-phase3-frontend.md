# Layer 3 · 前端层

> 总览见 [plugin-metadata-migration.md](plugin-metadata-migration.md)。依赖 [Layer 2](plugin-metadata-migration-phase2-engine.md)
> 的命令 `get_image_metadata_full` 与事件 `images-change{ reason:"metadata-migrate", pluginIds }`。

## 范围
- 详情/EJS 改用 `get_image_metadata_full`，并把 `metadata_version` 传入 EJS。
- 按 `metadata-migrate` 事件精准刷新（仅插件过滤画廊 + 当前详情图）。

## 涉及文件
- `packages/core/src/components/common/ImageDetailContent.vue`
- `apps/kabegame/src/composables/useImagesChangeRefresh.ts`
- `apps/kabegame/src/views/Gallery.vue`
- （可选）`packages/core/src/composables/useImageMetadataCache.ts`

## 步骤

### 3.1 详情/EJS 接入 metadata_full
- `ImageDetailContent.vue` 的 metadata 加载（`:344-350` 的 `injectedResolveMetadata ??
  invoke("get_image_metadata")`）改用 `get_image_metadata_full`，得到 `{ version, data }` 后：
  `resolvedMetadata = data`、`resolvedMetadataVersion = version ?? 0`（新增 ref）。
- EJS 渲染（`:573`）改为 `ejs.render(tpl, { metadata: meta,
  metadata_version: resolvedMetadataVersion }, …)`（空默认 0）。
- `useImageMetadataCache.ts:88` 等 gallery 侧若不需要 version，可继续用旧 `get_image_metadata`；仅详情/EJS
  必须迁移。

### 3.2 按 metadata-migrate 事件精准刷新
迁移事件 `reason==="metadata-migrate"` 不带 imageIds、只带 `pluginIds`：
- **`ImagesChangePayload` 类型**（`useImagesChangeRefresh.ts`）reason 注释补 `metadata-migrate`。
- **Gallery（`views/Gallery.vue` 的 `useImagesChangeRefresh`）**：给 `filter` 增加判定——当 reason 为
  `metadata-migrate` 时，**仅当当前画廊视图处于某个 `pluginIds[]` 的插件过滤下**（当前 provider 路径形如
  `gallery/plugin/<id>` 且该 id ∈ payload.pluginIds）才刷新；其它视图返回 false 忽略。非该 reason 维持现有
  行为。
- **`ImageDetailContent.vue`**：新增对 `images-change` 的监听——当 reason 为 `metadata-migrate` 且
  `pluginIds` 含当前图片 `pluginId` 时，对当前图片**重新拉取一次 `get_image_metadata_full`**，使 EJS 随
  迁移结果即时更新（其它 reason 不处理，避免无谓刷新）。注意 Android：若新增任何 overlay/监听遵循既有规范。

## 本层验证
- `bun check -c kabegame --skip cargo`（vue-tsc）通过。
- 处于该插件过滤的画廊在收到 `metadata-migrate` 时刷新；其它画廊视图不刷新。
- 打开该插件某图详情（EJS）时按事件重新拉取 `get_image_metadata_full`、模板随之更新。
- `description.ejs` 用 `<%= metadata_version %>` 分支：未迁移成功的老图走旧兼容分支、已迁移图走新分支；
  详情区 metadata 内容仍正常显示（data 解析无误）。
- `/run` 或 `verify` 跑应用人工核对详情区渲染。
