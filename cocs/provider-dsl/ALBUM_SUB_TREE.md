# Album 子树 Provider

`albums://by_sub_tree` 用画册名逐段遍历树，并在 fetch 时返回当前节点的直接子画册。

## 查询语义

- `albums://by_sub_tree`：返回所有根画册。
- `albums://by_sub_tree/星穹铁道`：返回“星穹铁道”的直接子画册。
- `albums://by_sub_tree/星穹铁道/萤`：返回“萤”的直接子画册。

`albums_by_sub_tree_provider` 通过动态 list 把子画册名称映射为下一层 provider，使用画册 id 继续递归。每进入一层，`where_clear` 会移除上一层的 `albums.parent_id` 条件，再写入当前层的 parent 条件，避免多层条件相互冲突。

## CLI album 路径解析

`kabegame-cli data import-image --album /星穹铁道/萤 <file>` 会：

1. 规范化为 `albums://by_sub_tree/星穹铁道/萤`。
2. 查询父路径 `albums://by_sub_tree/星穹铁道`，取得其所有直接子画册。
3. 在结果中查找 `name == "萤"` 的行并使用其 `id`。
4. 找不到目标子画册时终止导入并返回错误，不自动创建画册。

单层路径同理：查询 `albums://by_sub_tree` 的根画册结果，再按目标名称取 id。

## 涉及文件

- `src-tauri/kabegame-core/src/providers/dsl/albums/albums_by_sub_tree_provider.json5`
- `src-tauri/kabegame-core/src/providers/dsl/albums/albums_root_provider.json5`
- `src-tauri/kabegame-cli/src/main.rs`
