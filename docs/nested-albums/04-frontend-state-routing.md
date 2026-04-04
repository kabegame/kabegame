# 前端 Pinia、路由与 URL

## Pinia：`apps/main/src/stores/albums.ts`

- `Album` 类型需增加 **`parentId`**（或树结构所需字段）。
- `loadAlbums` / `createAlbum` / 事件监听：列表可能变为树或需按父级懒加载。
- 与 Element Plus 等组件：树形表格、懒加载子节点时的数据请求方式。

## 路由与浏览状态

- `apps/main/src/stores/albumDetailRoute.ts` 与 `apps/main/src/utils/albumPath.ts` 当前以**单个 `albumId`** 为主，配合筛选/排序/分页。
- 嵌套后 URL 是否编码 **面包屑路径**、仅 **当前节点 id**，或 **根 id + 子路径**，需一次性设计，避免后期大规模改动路由。

## 详情页

- `AlbumDetail.vue` 等：`providerRootPath` 形如 `album/<albumId>` 的约定若仍适用，子画册只是换 id；若需要「聚合子树图片」，则与后端查询语义一致即可。
