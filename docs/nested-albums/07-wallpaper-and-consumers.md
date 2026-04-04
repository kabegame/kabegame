# 壁纸轮播与其它按画册 id 消费方

## 设置与轮播（与 00 对齐）

[00-product-decisions.md](./00-product-decisions.md) §4：

- 轮播需支持 **是否包含子画册** 的配置项；**默认包含**（递归子树）。
- 递归合并各层 `album_images` 后，**必须按图片 id 去重**，再参与随机/顺序轮播。

实现涉及：

- `Settings`：新增或扩展布尔项（例如「轮播包含子画册」），默认 `true`；与现有 `wallpaper_rotation_album_id` 组合使用。
- `src-tauri/app-main/src/wallpaper/rotator.rs`：取候选图集时，按设置决定仅本层或递归子树；递归路径上去重。

## 其它 Rust 侧引用

搜索 `get_album_images`、`album_id` 在 `src-tauri/app-main` 与 `src-tauri/core` 中的用法，例如：

- `wallpaper/engine_export.rs` 等导出/引擎路径。

每处需明确：该功能是 **仅本层**（与「打开画册」列表一致）还是 **含子树**（与轮播/导出策略一致），并与设置项同步。
