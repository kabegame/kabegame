# VD 与 Provider DSL 的集成

本文档描述 **VD（Virtual Disk / 虚盘）** 作为 Provider DSL 引擎的**消费者**如何落地。
DSL 内核规则见 [RULES.md](./RULES.md)；本文档**不**引入新规则，只示范 VD 场景如何用现有规则
解决两类内核外的问题：

1. i18n 翻译文本作路径段（DB 不可读、内核不参与翻译）
2. 插件元数据接入路径树（DB 只有 plugin_id，显示信息来自运行时插件管理器）

凡涉及"主机层做什么"的部分都属于 host-mediated pattern，与引擎规则解耦——这是规则文件不收录
本文档内容的原因。

---

## 1. VD 路径树概览

VD 的根为 `/vd`，由 `root_provider.list.vd` 路由到 `vd_root_router`。
之下依次分三层：

```
/vd/                                  ← root_provider.list 入口
/vd/i18n-<locale>/                    ← vd_root_router (i18n 分发层)
/vd/i18n-<locale>/<本地化目录>/        ← vd_<locale>_root_router (按业务维度分组)
/vd/i18n-<locale>/<本地化目录>/<...>/  ← 业务 provider (vd_albums_provider 等)
```

i18n 层的存在让"切语言"等价于"换路径前缀"——引擎层无感知，缓存天然分隔。

---

## 2. i18n 路径分发

### 2.1 问题

VD 目录在不同语言下显示不同名（"按画册" / "By Album" / "アルバム別"）。
i18n 设置不在 DB（用户偏好），而路径段又必须是字面字符串（DSL 不能在路径段位置动态求值翻译）。

### 2.2 解决方式

在 VD 根 router 之下放一层 `i18n-<locale>` 静态分发，每个 locale 对应一份独立的 router 文件。
路径段的字面匹配交给静态 list（精确、零开销），翻译树由 locale 文件自身承担。

### 2.3 落地文件

```json5
// vd/vd_root_router.json5  (i18n 分发层)
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "vd_root_router",
    "list": {
        "i18n-zh_CN": { "provider": "vd_zh_CN_root_router" },
        "i18n-en_US": { "provider": "vd_en_US_root_router" }
    }
}
```

```json5
// vd/vd_zh_CN_root_router.json5  (中文翻译树)
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "vd_zh_CN_root_router",
    "list": {
        "按画册":  { "provider": "vd_albums_provider" },
        "按插件":  { "provider": "vd_plugins_router" },
        "按任务":  { "provider": "vd_tasks_provider" },
        "按浏览":  { "provider": "vd_surfs_provider" },
        "按媒体":  { "provider": "vd_media_type_provider" },
        "按时间":  { "provider": "vd_dates_provider" },
        "全部":    { "provider": "vd_all_provider" }
    }
}
```

`vd_en_US_root_router.json5` 结构相同，只是 key 改成 `By Album` / `By Plugin` 等英文路径段。

### 2.4 主机端职责

1. 用户访问 VD → 主机同步读取当前 i18n 设置（如 `zh_CN`）
2. 主机拼接路径前缀 `/vd/i18n-zh_CN/<rest>` 后交给 provider runtime
3. 用户切语言 → 主机切前缀；引擎对此无感知，旧 locale 的 LRU 项自然按需淘汰，
   新 locale 走新 provider 实例（缓存键不同，零干扰）

### 2.5 优势

- DSL 内核完全不碰 i18n，规则纯净
- 切 locale = 换路径前缀 → **自动重新走一次路径折叠**，无需特殊缓存失效
- 每个 locale 是独立的 ProviderInvocation 实例，缓存天然分隔

---

## 3. 插件维度：`get_plugin` SQL 桥与两层 router

### 3.1 问题

DB 只有 `images.plugin_id`（ID 字符串），但 VD 的"按插件"需要展示：
- 翻译过的插件显示名
- 插件版本 / 图标 / 描述（来自 PluginManager 注册的运行时元数据）
- 上述信息**不在 DB**，DSL 的 SQL 路径无法直接 SELECT 出来

### 3.2 解决方式

**主机注册 SQL 函数 `get_plugin(plugin_id) → JSON`**，在 SQL 层桥接 PluginManager 状态。
该函数在 SQL 上下文中视为普通函数；引擎层完全不知它是"主机注入"。

之后用两层 provider：
- **`plugins_provider`**：用 `get_plugin` 把每个插件的元数据展开为一行结构，meta 透传整行
- **`vd_plugins_router`**：上层路由壳，delegate 到 `plugins_provider`，用 child.meta 构造路径段
  并实例化每个插件的下层 router

### 3.3 落地文件

#### 3.3.1 `plugins_provider.json5`（数据层）

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "plugins_provider",
    "query": {
        "fields": [
            // 确保 plugin_id 列被加载到 ${composed} 子查询中
            { "sql": "images.plugin_id", "as": "plugin_id", "in_need": true }
        ]
    },
    "list": {
        // 动态 SQL: 每个 distinct plugin_id 一项
        // get_plugin 是主机注册的 SQL 函数, 返回该插件的 JSON 元数据
        "${plugin.info.plugin_id}": {
            "data_var": "plugin",
            "sql": "select get_plugin(plugin_id) as info from (${composed}) group by plugin_id",
            "meta": "${plugin}"
        }
    }
}
```

要点：
- `${composed}` 被嵌入子查询，自动继承上游 from / where / join / fields
- `as info` 把主机函数的 JSON 输出聚到一列；`${plugin.info.plugin_id}` 是 JSON 字段的点访问
- `meta: "${plugin}"` 把整行（含 `info` 列）作为 meta 传给上层

#### 3.3.2 `vd_plugins_router.json5`（路由壳）

```json5
{
    "$schema": "../schema.json5",
    "namespace": "kabegame",
    "name": "vd_plugins_router",
    "list": {
        // delegate 到 plugins_provider, 拿到的 child:
        //   child.name = ${plugin.info.plugin_id} (来自下层 list key)
        //   child.meta = 整行 {info: {plugin_id, name, ...}}
        // 此处 plugin.info.name 是主机已经做过 i18n 翻译的显示名
        "${plugin.meta.info.name} - ${plugin.meta.info.plugin_id}": {
            "delegate": "./__plugins_source",
            "child_var": "plugin",
            "provider": "vd_plugin_router",
            "properties": {
                "plugin_id": "${plugin.meta.info.plugin_id}"
            }
        }
    },
    "resolve": {
        "entries": {
            // 反向解析: 路径段如 "PluginA - some.plugin.id" 截取 plugin_id
            "^.+ - (?<plugin_id>[^ ]+)$": {
                "provider": "vd_plugin_router",
                "properties": { "plugin_id": "${capture[1]}" }
            }
        }
    }
}
```

`__plugins_source` 是 `vd_plugins_router` 内部约定的私有路径段，挂载点指向 `plugins_provider`
（实际配置可放在父 router 的 list / 同 namespace 内部 path）。

要点：
- key 中 `${plugin.meta.info.X}` 走 child.meta JSON 嵌套访问（详见 RULES.md §6）
- 显示名 `info.name` 由主机的 `get_plugin` 决定——也就是说 i18n 翻译在 SQL 层完成，
  DSL 只负责消费现成结果
- `properties.plugin_id` 把 ID 透传给下层 `vd_plugin_router`，进入按插件过滤的 query

### 3.4 主机端职责

主机在 SQL 引擎初始化时注册自定义函数：

```rust
// 伪代码 — 实际在 src-tauri/core/src/db/mod.rs 一类的初始化点
conn.create_scalar_function("get_plugin", 1, |ctx| {
    let plugin_id: String = ctx.get(0)?;
    let info = plugin_manager.get_info(&plugin_id, current_locale());
    Ok(serde_json::to_string(&info)?)
})?;
```

主机要保证：
- 函数返回的 JSON 已按当前 locale 翻译（让 DSL 拿到的就是显示名）
- 函数对未知 plugin_id 返回结构合法的 fallback 对象（避免 list 行解析失败）
- 插件装卸时显式失效 LRU 缓存（让下次访问重新跑 get_plugin）

---

## 4. 路径解析示例

走一遍 `/vd/i18n-zh_CN/按插件/PluginA - some.plugin.id/某画册/` 的折叠：

| 段 | 命中位置 | 累积变化 |
|---|---|---|
| `/vd` | `root_provider.list.vd` → `vd_route` | 进入 VD 根 |
| `/i18n-zh_CN` | `vd_root_router.list["i18n-zh_CN"]` → `vd_zh_CN_root_router` | 选定中文 router |
| `/按插件` | `vd_zh_CN_root_router.list["按插件"]` → `vd_plugins_router` | 进入插件维度 |
| `/PluginA - some.plugin.id` | `vd_plugins_router.resolve.entries` 正则截取 plugin_id | `properties.plugin_id = "some.plugin.id"`; 进入 `vd_plugin_router`，给上游 query 加 `WHERE images.plugin_id = ?` |
| `/某画册` | `vd_plugin_router.list[<i18n>]` 或下层 album router | 加 album 过滤 |

每段命中均进 LRU；切语言只需把 `i18n-zh_CN` 换成 `i18n-en_US` —— 整条路径自动重新折叠，
旧缓存不污染新结果。

---

## 5. 通用判别（来自 RULES.md §11）

| 数据特征 | DSL 处理方式 |
|---|---|
| SQL 可读（DB 列、JOIN 投影、子查询） | 直接走 query / list sql |
| ID 类标识符（plugin_id、album_id、task_id） | DSL 持有 ID；显示由前端 / 主机翻译 |
| 配置 / 偏好 / locale | 主机层决定路径前缀（如 `i18n-<locale>`） |
| 运行时元数据（PluginManager 注册项等） | 主机注册 SQL 函数桥接（如 `get_plugin`） |

VD 的设计选择是上述四种的组合：业务过滤走 DSL，i18n 走路径前缀，插件元数据走 SQL 函数桥。

---

## 6. 引用

- DSL 规则：[RULES.md](./RULES.md)
- 语法 schema：[../../src-tauri/core/src/providers/schema.json5](../../src-tauri/core/src/providers/schema.json5)
- VD 现有 provider 文件：[../../src-tauri/core/src/providers/vd/](../../src-tauri/core/src/providers/vd/)
- Gallery 旧实现（迁移参考）：[../gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md](../gallery/PROVIDER_IMAGEQUERY_COMPOSABLE.md)
