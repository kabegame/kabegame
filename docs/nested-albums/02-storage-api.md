# Storage 层 API 与业务规则

## 现状

`Storage` 在 `albums.rs` 中提供 `get_albums`、`add_album`、`rename_album`、`delete_album`、图片增删与顺序等。

## 嵌套后需扩展或新增

### `get_albums`（已定语义）

- **必须携带 `parent_id` 参数**（Rust 中可用 `Option<String>`：`None` / 空 表示「无父」）。
- **只返回某一父节点下的直接子画册**，不返回更深层的子孙；也**不**在一次调用里返回整棵树或全表扁平列表。
- **`parent_id` 为空（`None`）**：返回**根级画册**集合（`albums.parent_id IS NULL`），与旧版「列出所有画册」在扁平模型下等价。
- **`parent_id` 为某 id**：返回 `parent_id` 等于该 id 的子画册行（一层）。

若其它场景需要整棵树（例如设置页、调试），应另增专用 API（如 `get_albums_tree`），避免与列表页的「只列一层」混淆。

### 其它

- **`add_album`**：携带目标 `parent_id`（空 = 在根下创建）；校验父节点存在、同父下不重名、不成环（父链检查）。
- **`move_album`（或 `set_parent`）**：修改 `parent_id`，校验不成环、同父下不重名。
- **按名称解析**：若仍支持「按名称找画册」（如 CLI），需定义重名时规则（全路径 vs 仅叶子名）或禁止重名。
- **`get_album_preview` / 封面缩略图**：算法见 [00-product-decisions.md](./00-product-decisions.md) §3（浅层优先，不足 3 张时向子画册预览均匀借图）。
- **`get_album_counts`（或拆分）**：若 UI 需要「仅本层张数」与「含子树张数」两种，应分字段或分 API，与打开画册列表（仅本层图）区分。

## 事件与一致性

- 画册增删改名若带 `parent_id`，Emitter / 前端刷新时，监听方可能需要按**当前打开的父级**局部刷新 `get_albums(parent_id)`，而不必假定全量重载整树。
