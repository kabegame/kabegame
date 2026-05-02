# 插件 Extend 入口 DSL 路由拆分计划

## Summary

`extend` 仍然全部用 DSL 实现。Gallery 和 VD 不再共用同一个插件节点 provider：抽出一个只负责 `images.plugin_id` 过滤的公共 `plugin_provider`，Gallery/VD 各自拥有自己的 router。VD 按语言新增插件节点 router，用对应语言的 `扩展` / `Extend` / 等目录名挂到插件入口 `plugins.{plugin_id}.entry_provider`。

本阶段建立在 phase1 已完成的前提上：插件 providers 已能从 `.kgpg` 解析、显式注册，并保证缺省存在 `plugins.{plugin_id}.entry_provider`。

## Key Changes

- 把当前 `gallery_plugin_provider` 拆成两层：
  - `plugin_provider`：公共底层，只做 `plugin_id` property 和 `query.where = images.plugin_id = ...`。
  - `gallery_plugin_router`：Gallery 专用路径结构，delegate/继承 `plugin_provider` 的 query，并保留分页、排序、`extend` 等 Gallery 子节点。
- `gallery_plugins_router` 改为指向 `gallery_plugin_router`，不再直接指向过滤 provider。
- `vd_plugins_provider` 不再引用 Gallery router，改为只列出插件目录，并指向 VD 专用插件 router。
- 为每个 VD 语言新增插件 router DSL：
  - `vd_zh_CN_plugin_router`：子节点用 `"扩展"`。
  - `vd_en_US_plugin_router`：子节点用 `"Extend"`。
  - `vd_ja_plugin_router` / `vd_ko_plugin_router` / `vd_zhtw_plugin_router`：使用对应语言目录名。
  - 每个 router 都接收 `plugin_id`，delegate/继承公共 `plugin_provider` 的 query。
- 每个 VD 插件 router 的 `list` 增加扩展入口：
  - `"扩展": { "provider": "plugins.${properties.plugin_id}.entry_provider" }`
  - 英文等语言同理，只变路径段显示文本。
- DSL 引擎补齐 provider 引用名模板化能力，使 `provider: "plugins.${properties.plugin_id}.entry_provider"` 能在实例化前渲染成全限定 ProviderName。

## Implementation Details

### 1. DSL ProviderName 模板化

当前 `ProviderName` 是透明字符串，但实例化时直接传给 registry。需要在 `DslProvider` 实例化 provider 引用前渲染 provider name。

- 在 `src-tauri/pathql-rs/src/provider/dsl_provider.rs` 增加 helper：

```rust
fn render_provider_name(
    &self,
    provider: &ProviderName,
    captures: &[String],
    ctx: &ProviderContext,
) -> Result<ProviderName, EngineError> {
    if !provider.0.contains("${") {
        return Ok(provider.clone());
    }
    let tctx = self.base_template_context(ctx, captures);
    let rendered = render_template_to_string(&provider.0, &tctx)?;
    Ok(ProviderName(rendered))
}
```

- 在这些调用点先渲染 provider name，再 `ctx.registry.instantiate(...)`：
  - `instantiate_invocation` 的 `ProviderInvocation::ByName`。
  - `instantiate_call` 的 `ProviderCall.provider`，覆盖 `query.delegate`、dynamic list delegate、resolve delegate。
  - `list_dynamic_sql` 里 `DynamicSqlEntry.provider: Some(ProviderName)`。
  - `resolve_dynamic_entry` 里 SQL/dynamic provider 实例化。
  - `DynamicListEntry::Delegate` 的 `DelegateProviderField::Name` 分支。
- 保留 `${child.provider}` 透传语义，不要把它改成字符串模板渲染。

### 2. Schema 和校验

- 修改 `src-tauri/kabegame-core/src/providers/dsl/schema.json5`：
  - `ProviderName` 允许普通全限定名或包含 `${...}` 的模板字符串。
  - `Namespace` 允许 hyphen segment，配合 phase1 的插件 id。
  - 最后一段 provider simple name 仍保持 snake_case；模板 provider name 的最终合法性在运行期渲染后检查。
- `validate::cross_ref` / cycle 检查遇到 provider name 含 `${` 时跳过静态 cross-ref，和现有 resolve pattern 模板处理思路一致。
- 运行期渲染后的 provider name 如果无法解析，应按现有 `ProviderNotRegistered` / `None` 行为处理，不 panic。

### 3. 公共 plugin_provider

- 新增或重命名 DSL 文件，建议：
  - `src-tauri/kabegame-core/src/providers/dsl/shared/plugin_provider.json5`

```json5
{
  "$schema": "../schema.json5",
  "namespace": "kabegame",
  "name": "plugin_provider",
  "properties": {
    "plugin_id": { "type": "string", "default": "", "optional": false }
  },
  "query": {
    "where": "images.plugin_id = ${properties.plugin_id}"
  }
}
```

- 这个 provider 只表达过滤，不要放分页、排序、extend 等路由节点。

### 4. Gallery router 拆分

- 将现有 `src-tauri/kabegame-core/src/providers/dsl/gallery/plugins/gallery_plugin_provider.json5` 改成 `gallery_plugin_router.json5`，或保留文件名但 provider `name` 改为 `gallery_plugin_router`。
- `gallery_plugin_router` 结构：

```json5
{
  "$schema": "../../schema.json5",
  "namespace": "kabegame",
  "name": "gallery_plugin_router",
  "properties": {
    "plugin_id": { "type": "string", "default": "", "optional": false }
  },
  "query": {
    "delegate": {
      "provider": "plugin_provider",
      "properties": { "plugin_id": "${properties.plugin_id}" }
    }
  },
  "list": {
    "extend": {
      "provider": "plugins.${properties.plugin_id}.entry_provider"
    },
    "desc": { "provider": "sort_router" },
    "...": "保留现有分页节点"
  },
  "resolve": {
    "extend": {
      "provider": "plugins.${properties.plugin_id}.entry_provider"
    },
    "...": "保留现有 xNNNx 和页码 resolve"
  }
}
```

- `gallery_plugins_router.json5` 的 list/resolve 都改为指向 `gallery_plugin_router`。

### 5. VD router 拆分

- 修改 `vd_plugins_provider.json5`：
  - list 仍然 SQL 枚举插件目录名。
  - list/resolve 指向对应 VD 插件 router，而不是 `gallery_plugin_provider` / `gallery_plugin_router`。
- 由于 `vd_plugins_provider` 本身不知道 locale，推荐做法是为每种语言单独拆插件列表 provider：
  - `vd_zh_CN_plugins_provider` -> `vd_zh_CN_plugin_router`
  - `vd_en_US_plugins_provider` -> `vd_en_US_plugin_router`
  - `vd_ja_plugins_provider` -> `vd_ja_plugin_router`
  - `vd_ko_plugins_provider` -> `vd_ko_plugin_router`
  - `vd_zhtw_plugins_provider` -> `vd_zhtw_plugin_router`
- 然后各语言 root router 改为：

```json5
"按插件": { "provider": "vd_zh_CN_plugins_provider" }
"By Plugin": { "provider": "vd_en_US_plugins_provider" }
```

- 每个 `vd_*_plugins_provider` 可以共享同一段 SQL，只是 child provider 不同。

### 6. VD 插件节点 router

- `vd_zh_CN_plugin_router` 示例：

```json5
{
  "$schema": "../schema.json5",
  "namespace": "kabegame",
  "name": "vd_zh_CN_plugin_router",
  "properties": {
    "plugin_id": { "type": "string", "default": "", "optional": false }
  },
  "query": {
    "delegate": {
      "provider": "plugin_provider",
      "properties": { "plugin_id": "${properties.plugin_id}" }
    }
  },
  "list": {
    "扩展": {
      "provider": "plugins.${properties.plugin_id}.entry_provider"
    },
    "全部": { "provider": "vd_all_provider" }
  },
  "resolve": {
    "扩展": {
      "provider": "plugins.${properties.plugin_id}.entry_provider"
    },
    "全部": { "provider": "vd_all_provider" }
  }
}
```

- 如果不想在插件目录下增加“全部”，可以只提供扩展节点；但要确认虚拟盘按插件目录原本是否依赖直接列图片。若需要保持旧行为，建议保留一个本语言的 “全部/All” 子目录，而不是让插件目录自身同时列图片和扩展目录。
- 各语言扩展目录名建议：
  - zh_CN: `扩展`
  - en_US: `Extend`
  - ja: `拡張`
  - ko: `확장`
  - zhtw: `擴展`

### 7. DSL 文件清单

- 更新 `src-tauri/kabegame-core/src/providers/dsl_loader.rs::DSL_FILES`：
  - 加入 `shared/plugin_provider.json5`。
  - 加入或替换 `gallery/plugins/gallery_plugin_router.json5`。
  - 加入各语言 `vd_*_plugins_provider.json5` 和 `vd_*_plugin_router.json5`。
  - 移除已不用的 `vd_plugins_provider.json5` 或保留为兼容 alias，但不得再引用 Gallery router。
- 如果保留旧 `gallery_plugin_provider.json5` 文件名，确认 provider `name` 与 `DSL_FILES` 中引用一致，避免同名冲突。

### 8. 清理隐患引用

- 搜索并清理：

```powershell
rg -n "gallery_plugin_provider|gallery_plugin_router" src-tauri/kabegame-core/src/providers/dsl/vd
```

- VD DSL 中不能引用 Gallery router。允许引用：
  - `plugin_provider`
  - `vd_*_plugin_router`
  - 其他 VD 自己的 provider

## Path Semantics

- Gallery:
  - `/gallery/plugin/{plugin_id}/extend`
  - `/gallery/plugins/{plugin_id}/extend`
- VD 中文：
  - `/vd/i18n-zh_CN/按插件/{插件显示名 - plugin_id}/扩展`
- VD 英文：
  - `/vd/i18n-en_US/By Plugin/{display - plugin_id}/Extend`
- Gallery 的 `extend` 是 Gallery 路由约定；VD 的扩展目录名是 VD 语言路由约定。两者共享插件入口 provider，但不共享 router。

## Test Plan

- DSL 模板 provider 名测试：`provider: "plugins.${properties.plugin_id}.entry_provider"` 能正确实例化。
- Gallery 路由测试：`/gallery/plugin/{id}/extend` 可解析到插件入口。
- VD 路由测试：中文 `/按插件/{display}/扩展` 和英文 `/By Plugin/{display}/Extend` 可解析到插件入口。
- 隔离测试：VD DSL 不再引用 Gallery router。
- 公共过滤测试：Gallery router 和 VD router 都能通过 `plugin_provider` 保持 `images.plugin_id = ...` 查询过滤。
- 空入口测试：无自定义入口的插件扩展目录为空，不列出图片。
- 旧路径回归：现有 `/gallery/plugin/{id}/x100x/1`、`/gallery/plugins/{id}/desc/1`、VD 按插件列表仍可解析。

建议执行：

```powershell
cargo test -p pathql-rs --features "json5 validate"
cargo test -p kabegame-core --test dsl_e2e
cargo check -p kabegame
rg -n "gallery_plugin_provider|gallery_plugin_router" src-tauri/kabegame-core/src/providers/dsl/vd
```
