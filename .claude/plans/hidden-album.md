# 隐藏画册 (Hidden Album) — Phases 大纲

`HIDDEN_ALBUM_ID = "00000000-0000-0000-0000-000000000000"`

## Phase 1 — 后端基础设施（provider + 常量 + seed）

- `HIDDEN_ALBUM_ID` 常量与新建库 seed
- `HideGateProvider`（注入 NOT EXISTS 过滤，SQL 片段带 `/*HIDE*/` tag）
- 在 Gallery/VD root 注册 `hide` 子节点
- AlbumProvider / VdAlbumEntryProvider 在 `album_id == HIDDEN_ALBUM_ID` 时剥除 HIDE 片段
- Migration v009：INSERT OR IGNORE 隐藏画册 + 打平现存子节点（重名去重）

[文件链接](C:\Users\Lenovo\.claude\plans\unified-purring-balloon.md)

## Phase 2 — 后端系统约束

- `move_album`：禁止自身/目标为 HIDDEN
- `delete_album` / `rename_album`：禁止 HIDDEN
- Album tauri commands（add/remove/add_task_images）：当 album_id=HIDDEN 跳过 VD bump
- `ImageInfo.hidden` 字段 + SELECT decorate（对称 favorite）

[详细计划](hidden-album-phase2-3.md)

## Phase 3 — VD FS 隐藏属性

- Windows：`find_files` + `get_file_information` 叠加 `FILE_ATTRIBUTE_HIDDEN`
- macOS FUSE：`opened_to_attr` 设 `flags |= UF_HIDDEN (0x8000)`
- Linux FUSE：`readdir` 跳过 hidden 条目
- 语义层：`VfsEntry::Directory` 和 `VfsOpenedItem::Directory` 加 `hidden: bool` 字段

[详细计划](hidden-album-phase2-3.md)

## Phase 4 — 前端核心：开关与路径

- Settings 加 `showHiddenImages`（持久化）
- 前端 `HIDDEN_ALBUM_ID` 常量 & album store 暴露
- 所有 provider 路径构造点：`!showHiddenImages` 时前置 `hide/`（galleryPath、albumPath、Surf 路径）

## Phase 5 — 前端 Header toggle

- `HeaderFeatureId.ToggleShowHidden` + 自定义可勾选组件（类 TaskDrawerButton）
- 在 Gallery / AlbumDetail / SurfImages header fold 里注册

## Phase 6 — 前端 Albums 页 UI

- albumRoots 渲染过滤掉 HIDDEN
- 右下角固定垃圾桶按钮（fixed，桌面 & 安卓），点击进入隐藏画册详情
- 右键拦截（防御）

## Phase 7 — 前端 AlbumDetail 特化 & 移动树

- `isHiddenAlbum` prop 传入 header（隐藏 +、删除、轮播等按钮）
- moveAlbumTree exclude 加入 HIDDEN（对称 FAVORITE）

## Phase 8 — 前端事件刷新

- Gallery / AlbumDetail / SurfImages 的 `useAlbumImagesChangeRefresh` filter 增加命中 HIDDEN 时的 refresh 行为（语义与 `images-change` 等价）

## Phase 9 — 前端图片动作

- `imageActions.ts` 加 `addToHidden` / `removeFromHidden`（直接调 `add/remove_images_to_album(HIDDEN_ALBUM_ID)`，无需 `image.hidden` 字段）

## Verification

- `bun check -c main --skip cargo`
- 手动：默认画廊不含隐藏图；header 勾选显示；加入/移出隐藏生效；Albums 页仅有垃圾桶入口；VD 里隐藏画册文件夹带 hidden 属性
