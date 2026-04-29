# Phase 7 总览 — DSL 全量迁移 + 主机 SQL 函数 + Parity 测试

## Context

承接 **Phase 6e 完成态**：
- pathql-rs 全套就绪：AST + parser + validate + compose + Provider runtime + executor (sync trait + dialect) + DslProvider 完整动态部分
- core 端 33 个 programmatic provider 注册到同一 registry；9 个 DSL provider 落地（含 6e 改造）
- ImageQuery 已删；Storage 接口接 ProviderQuery；template_bridge 私有
- 6e 后 delegate 是 ProviderCall；providers path-unaware；`__provider` 私有 resolve 间接桥消除

### Phase 7 总目标

把仍在 programmatic 的 ~28 个 provider 全部迁到 DSL；删除 programmatic/ 模块；建立主机 SQL 函数注册框架（让 DSL 能访问 plugin manifest 等非 SQL 表数据源）；建立 parity 测试套保证迁移行为零回归。

完成后：
- `core/src/providers/programmatic/` 整个模块删除（仅留 `register_all_hardcoded` 一个空 stub 或彻底删）
- 9 → 28+ DSL provider，所有 gallery / vd 路径走 DSL 解释
- 主机 SQL 函数（`get_plugin` / 等）注册框架可扩展
- E2E 测试覆盖 gallery / vd 主路径 + LRU + i18n 切换

### 拆分原则

- **每个子期单独 atomic**：完成后 `cargo test` 全绿 + `bun check` 通过 + 手测主路径不回归
- **DSL 与 programmatic 共存到全部迁完为止**：迁移期间 registry 同名 provider 由 programmatic / DSL 之一占位（同名互斥；当一个 .json5 加载时 programmatic 跳过）
- **每个迁移加 parity 单测**：跑 programmatic vs DSL 在 fixture DB 上的 SQL 输出 + image set 等价

---

## 设计原则（迁移期 checklist；违反必出 PathNotFound 类 bug）

### 原则 1：Leaf vs Router 不能混用

**叶子 provider（仅做 apply_query，list/resolve 永远空）只能放在路径终端位置**。如果路径预期会继续往下走（用户能在该 segment 后接更多 segment），listing 此处的 provider 必须是 **router**——拥有自己的 `list` 或 `resolve` 表能把后续 segment 解析下去。

**真实案例（来自 Phase 7 调试期，6e 后引入）**：

```jsonc
// gallery_all_router.json5 (错):
"list": {
    "desc": { "provider": "sort_provider" }   // ❌ sort_provider 是 leaf
}
```

`sort_provider`（programmatic）`fn resolve` 返回 `None`、`fn list` 返回空。语义上它正确地"翻转 order"，但结构上把它放在 `desc` 槽位 → `/gallery/all/desc/1` 路径在 `1` 这一步 PathNotFound——sort_provider 没法把"1"继续解析到分页层。

**正确写法**：用一个**包装 router** DSL 文件（既翻转 order 又持有 resolve 表）：

```jsonc
// gallery_all_router.json5 (对):
"list": {
    "desc": { "provider": "gallery_all_desc_router" }   // ✅ router with resolve
}
```

```jsonc
// gallery_all_desc_router.json5:
{
    "name": "gallery_all_desc_router",
    "query": { "order": { "all": "revert" } },     // 翻转 (语义等价 sort_provider.apply_query)
    "resolve": {                                   // 自己的 resolve 表 → 路径能继续
        "x([1-9][0-9]*)x": { "provider": "gallery_paginate_router", ... },
        "([1-9][0-9]*)": { "provider": "gallery_page_router", ... }
    }
}
```

**判别 leaf vs router 的简单方法**：grep 所有 `<segment>/<more>...` 形态的 URL；如果 segment 后面有继续段，listing 此处的 provider 必须有 `list` 或 `resolve`。

### 原则 2：路径无感（Path-unaware）—— 6e 已铸造

延续 6e 的设计：provider 永远不感知"我在路径树的哪个位置"。它只关心"我是谁、我贡献什么"。当一个 provider 想引用另一个 provider 时，永远用 `{provider, properties}` 形态，不用路径字符串。

迁移期 checklist：
- ❌ 不要在 DSL 里写 `delegate: "./X"` / `delegate: "/foo/bar"`
- ✅ 写 `delegate: { provider: "X", properties: {...} }`

### 原则 3：DSL_FILES 清单同步

每新建一个 .json5 文件，**必须**同时加入 [`core/src/providers/dsl_loader.rs`](../../src-tauri/core/src/providers/dsl_loader.rs) 的 `DSL_FILES` 常量数组——`include_dir!()` 把文件嵌入二进制，但 loader 用**显式清单**而非自动遍历加载。漏加 → registry 没注册 → 父级 list/resolve 引用时 instantiate 返回 None → 路径 PathNotFound。

迁移期 checklist：每个迁移 commit 必含 `DSL_FILES` 数组的更新。建议加测试 `tests/dsl_files_consistency.rs`：扫 `dsl/` 实际 `.json5`/`.json` 文件 vs `DSL_FILES` 常量，差集报错——任何新文件忘了加清单 → cargo test 立刻挂。

### 原则 4：Modifier 段需要包装 router

凡是路径中"翻转/过滤/分组" 等**变换语义** + **后面有续段**的 segment，对应的 provider 必须是 router 模式（带 list/resolve）。常见 modifier 段及对应 router DSL：

| URL 段 | 角色 | 推荐 DSL 形态 |
|---|---|---|
| `desc` | 翻转 ORDER 后接分页 | router 持有 xNx + 裸数字 resolve |
| `image-only` / `video-only` | 媒体过滤后接分页 | router 持有同样 resolve |
| `wallpaper-order` | 设过壁纸过滤后接分页 | router |
| `<year>y` / `<month>m` / `<day>d` | 日期下钻后接分页 | router 持有正则 + 子分页 |

错误模式：把 sort_provider / media_filter_provider 等 leaf 直接挂在 modifier 段——会断链。

---

## 子期布局

```
Phase 7a — 基础设施 + i18n 补全 + pilot 迁移         (~小)
   └─ 7b — Gallery 滤镜大迁移 (17 provider)            (~大)
        └─ 7c — Gallery 日期 + shared sort 迁移        (~中)
             └─ 7d — VD 大迁移 + programmatic 模块删除  (~大)
                    + Tauri cleanup + E2E 测试
```

依赖关系：7a 提供基础设施（主机 SQL 函数 + parity 测试模板 + i18n_en_US 补全）；7b/c/d 大量复用其框架。每个子期独立提交、独立合并。

---

### Phase 7a — 基础设施 + i18n_en_US 补全 + pilot 迁移

**详细计划**：[phase7a-foundation.md](./phase7a-foundation.md)

**目标**：
1. 补 `vd_en_US_root_router.json5`（vd_zh_CN 的英文翻译镜像；解 dangling）
2. core 主机 SQL 函数注册框架：`KabegameSqlExecutor` 构造期通过 `Connection::create_scalar_function` 注册 `get_plugin(plugin_id [, locale]) -> JSON_TEXT`
3. `get_plugin` 实现：返回 `{id, name, description, baseUrl}` JSON 对象（name / description i18n 解析；basic 元数据）
4. Pilot 迁移 1-2 个简单 provider（候选：`gallery_search_router` 路由壳 + `sort_provider` contrib query）—— 验证迁移流程跑得通
5. Parity 测试模板：可复用的 helper，给 7b/c/d 的所有迁移用

**完成标准**：
- `/vd/i18n-en_US/...` 路径不再 PathNotFound
- `get_plugin('pixiv', 'en_US')` 在 sqlite 内可调，返回正确 JSON
- 2 个 pilot provider 在 DSL 下行为与 programmatic 等价（parity 测试通过）
- programmatic/ 模块仍在，未删除（pilot 之外的 26 个保留）

---

### Phase 7b — Gallery 滤镜大迁移

**详细计划**：（7a 完成后写 phase7b-gallery-filters.md）

**目标**：迁移 17 个 gallery 滤镜 provider 到 DSL：

- `gallery_albums_router` / `gallery_album_provider`（router + entry）
- `gallery_plugins_router` / `gallery_plugin_provider`（**用 7a 的 get_plugin**）
- `gallery_tasks_router` / `gallery_task_provider`
- `gallery_surfs_router` / `gallery_surf_provider`
- `gallery_media_type_router` / `gallery_media_type_provider`
- `gallery_hide_router`
- `gallery_search_router` / `gallery_search_display_name_router` / `gallery_search_display_name_query_provider`（**7a 已 pilot search_router**）
- `gallery_wallpaper_order_router`
- `gallery_date_range_router` / `gallery_date_range_entry_provider`

**子任务结构（建议）**：按子目录分组 commit：
- S1：albums + album_entry（router + leaf 模板）
- S2：plugins + plugin_entry（**使用 get_plugin SQL 函数**）
- S3：tasks + task_entry
- S4：surfs + surf_entry
- S5：media_type + media_type_entry + hide
- S6：search 三件套
- S7：wallpaper_order + date_range 两件套
- S8：删除 17 个 programmatic 实现 + parity 测试覆盖全部

**完成标准**：17 个 provider 在 DSL 下；programmatic gallery_filters.rs / gallery_albums.rs 大幅缩减或删除；parity 测试每个新 DSL provider 都覆盖。

---

### Phase 7c — Gallery 日期 + shared sort 迁移

**详细计划**：（7b 完成后写 phase7c-dates-sort.md）

**目标**：
- `sort_provider`（shared）：单 contrib query，`order.global = Revert`
- `gallery_dates_router` / `gallery_date_year_provider` / `gallery_date_month_provider` / `gallery_date_day_provider`：嵌套日期下钻结构（年/月/日三层），动态 list 通过 SQL `GROUP BY` 拿 distinct 年份/月份/日 + 模板渲染 segment 名
- 5 个 provider 迁移 + parity 测试

**关键技术点**：日期下钻是 7c 真正的复杂之处——动态 list 项的 SQL 聚合（`SELECT DISTINCT strftime('%Y', images.crawled_at) AS year FROM ...`）+ 子层 properties 传递（year → year_provider 的 properties.year）。

**完成标准**：sort + 日期 5 个 provider 全 DSL；programmatic gallery_dates.rs 删除；shared.rs 缩减；parity 测试覆盖。

---

### Phase 7d — VD 大迁移 + programmatic 模块删除 + E2E 测试

**详细计划**：（7c 完成后写 phase7d-vd-finalize.md）

**目标**：
1. **9 个 VD provider 迁 DSL**：`vd_all_provider` / `vd_albums_provider` / `vd_album_entry_provider` / `vd_sub_album_gate_provider` / `vd_plugins_provider`（用 get_plugin）/ `vd_tasks_provider` / `vd_surfs_provider` / `vd_media_type_provider` / `vd_dates_provider`
2. **programmatic 模块整体删除**：所有 26+ provider 已迁移；删除 `core/src/providers/programmatic/` 整个目录；`init.rs` `register_all_hardcoded` 改空（或删）
3. **Tauri cleanup**：grep 全工程确认无任何代码绕开 `provider_runtime()` 直接构造 provider；任何残余的 `pub use` 等清理
4. **`browse_gallery_provider` / 等 IPC 命令** 切换确认（已经用 `provider_runtime()`，6d 后仍如此；本期只需 audit）
5. **E2E 测试**：新建 `core/tests/dsl_e2e.rs`，构造 fixture DB，跑：
   - `/gallery/all/x100x/1/` 完整路径，断言 SQL + image ID set
   - `/vd/i18n-zh_CN/按画册/<album_id>/`、`/vd/i18n-en_US/albums/<album_id>/` 双 locale 等价
   - `/vd/i18n-zh_CN/按插件/<plugin_id>/` 走 get_plugin，断言 plugin name 按 locale 切换
   - LRU 测试：连续访问 100 个不同 page，确认 cache 不击穿
6. **memory + RULES.md** 收尾

**完成标准**：
- programmatic/ 模块删除（或仅剩兼容性桩）
- 28+ DSL provider 全部走通，所有 gallery + vd 路径在 DSL 下行为正确
- E2E 测试 `cargo test -p kabegame-core --test dsl_e2e` 全绿
- 手测 dev server gallery + vd 全路径不回归
- i18n 切换：zh_CN ↔ en_US，VD 路径前缀切换正确，plugin 名字按 locale 切换
- memory `project_dsl_architecture.md` 加决策"DSL 全量迁移完成"

---

## 全局完成标准（Phase 7 整体）

- [ ] `cargo test -p pathql-rs --features "json5 validate"` 全绿
- [ ] `cargo test -p kabegame-core` 全绿（含 parity + e2e 测试）
- [ ] `bun check -c main --skip vue` 通过
- [ ] `core/src/providers/programmatic/` 删除（或仅剩 `register_all_hardcoded(_) -> Ok(())` 空 stub）
- [ ] DSL .json5 文件总数 ≥ 35（9 已有 + 17 gallery 滤镜 + 5 gallery 日期 + sort + vd_en_US + 9 vd = 42）
- [ ] 主机 SQL 函数 `get_plugin(plugin_id [, locale])` 在 KabegameSqlExecutor 内部注册；DSL 文件有实际调用案例
- [ ] 全工程 `vd_en_US_root_router` dangling 不再
- [ ] E2E 测试覆盖：gallery + vd 主路径 + i18n 切换 + LRU + plugin 维度
- [ ] 手测 dev server：浏览所有 gallery / vd 路径无回归；浏览 plugin 维度名字按 locale 切换正确

## 风险（全局）

1. **迁移期 registry 同名冲突**：DSL provider 加载 + programmatic provider 仍注册同名 → 取舍：DSL 优先 / programmatic 优先 / 报错。**当前实现：programmatic 跳过 DSL-covered 名字**（6c 留下的策略），所以迁移期"加 .json5 + 从 register_all_hardcoded 注释掉对应 register 调用"是同一个 commit。每次迁移要双改

2. **`get_plugin` 性能**：每行 SQL 调用都查一次 `PluginManager::global().get_plugin(id)`；插件量大时是 N 次 lock。需测；如有问题加进程内 LRU

3. **i18n locale 在 DSL 里的传递**：vd_zh_CN_root / vd_en_US_root 各自 list 项 properties 传 `locale: "zh_CN" / "en_US"`，沿路径树往下传到 vd_plugins_provider；这是路径重构 —— 改 vd_root_router → vd_zh_CN_root → vd_plugins_provider 三层 properties 拼装

4. **parity 测试 fixture DB**：需要稳定 schema + 真实 sample 数据；建议 fixture 文件 commit 进 repo（约 10-50 KB），让测试可复现

5. **VD `按时间` 嵌套结构复杂**：`vd_dates_provider` 跟 `gallery_dates_router` 类似但 segment 名走 i18n（`年`/`月`/`日` vs `Year`/`Month`/`Day`）；7d 迁移时小心

6. **删 programmatic/ 时的 import 残留**：迁移完后 grep `crate::providers::programmatic` / `gallery_albums::` 等 import 路径，全部清理

7. **Phase 7 单期工作量极大**：7b 单期就是 17 个 provider；如有时间压力可暂停在 7b 完成，剩下的留 8+

## 完成 Phase 7 后的下一步

进入 **Phase 8+**（基础维护期）：
- sync/async feature 切换 trait 签名 + 内置 sqlx_executor feature
- 多方言完整支持（Postgres / Mysql build_sql 完整 placeholder 渲染）
- 非 SQL executor 抽象（ResourceExecutor）—— Phase 7 的 host SQL function 是 SQL-side 的桥；未来若需 list_children 数据来自非 SQL 数据源（如 API、文件系统），需要另一个抽象
- 性能调优：LRU 容量上限 / 命中率监控 / dynamic list 反查代价
- 第三方插件可声明 DSL provider（namespace 机制扩展）
