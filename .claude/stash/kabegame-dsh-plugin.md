我的判断是：`dsh-plugin-kabegame` 最有价值的方向，不是再写一遍 Kabegame API，而是把 Kabegame 从“一个 MCP 数据源”升级成“DSH 里的视觉素材工作台”。

Kabegame 已经有比较完整的 MCP：能读图片、metadata、画册、任务、畅游记录、插件，也能创建画册、加图、排序和重命名。单纯接入的话，配置一个 `@deepseek-ai/dsh-mcp-client` 就够了，并不值得单独做插件。

真正值得做成 DSH 插件的能力，我会分成三层。

### 1. 第一优先：面向任务的原生工具

不要直接把 PathQL 和底层资源暴露给模型，而是提供稳定的语义工具，例如：

- `kabegame_search_images`
  - 按来源、日期、画册、名称、媒体类型组合搜索
  - 插件内部生成和校验 PathQL
- `kabegame_get_image`
  - 返回图片字段、metadata，以及真正可供模型看的缩略图
- `kabegame_create_album`
- `kabegame_collect_to_album`
  - 搜索、筛选、建画册、加入图片合成一次任务
- `kabegame_curate_album`
  - 重排、重命名、剔除候选；删除仍留给用户确认
- `kabegame_compare_images`
  - 把若干图片作为多模态内容交给模型比较

这里最关键的是“让模型真正看到图片”。DSH 当前通用 MCP resource 读取对二进制资源只给描述，不直接投影为模型图片；专用插件可以读取 Kabegame 缩略图，并通过 DSH attachment/tool content 管线持久化成多模态结果。这会比单纯的 MCP 接入多出一整档能力。

### 2. 第二优先：DSH 原生工作流

把多个 Kabegame 操作变成可恢复、有进度、需要时可确认的长任务：

- “找出最近一个月收藏的原神竖屏图，选 30 张建一个手机壁纸画册”
- “分析这个画册的色调和角色分布，按视觉节奏重新排序”
- “把疑似重复、低分辨率或文件丢失的图片归入‘待清理’画册”
- “等待某个抓取任务结束，然后整理结果并汇报”
- “每天抓取指定来源，把新增内容分类到不同画册”

这可以接 DSH 的：

- `ctx.jobs`：抓取、分析、批量整理等后台任务
- `ctx.goals`：跨多轮完成一个整理目标
- schedule：定时收集和策展
- approval：批量修改前确认
- session events：持久记录选择、进度和结果
- agent preset：给“壁纸策展助手”限定专属工具集

不过现在 Kabegame MCP 没有“启动抓取任务、停止任务、设壁纸”等写能力。要做这层，最好先扩展 Kabegame MCP；不建议 DSH 插件私自绕过 MCP 去调用带 `super=1` 的通用 JSON-RPC，否则权限模型会分裂。

### 3. 第三优先：专门的 Web UI

给聊天里的 Kabegame 工具结果做原生卡片：

- 缩略图网格，而不是一大段 JSON
- 图片多选和取消选择
- 画册创建、加入和排序预览
- 抓取任务进度与日志
- “在 Kabegame 中打开”
- 用户确认后的批量操作
- 每次工具结果只呈现摘要，需要时再展开 metadata

这个方向最能体现“DSH 插件”而不是普通 MCP 客户端。Host presenter 保持纯函数，Web 端从持久化的 tool result/session event 渲染，刷新会话后仍可重建。

### 还可以做的两个垂直方向

一个是“视觉偏好助手”：从用户主动选中的画册中总结颜色、构图、角色、横竖屏等偏好，辅助后续搜索和策展。不要默认扫描全库，也不要把全库长期塞进 system prompt；应按任务读取并记录实际进入模型的内容。

另一个是“Kabegame 插件开发助手”：帮助创建 `.kgpg` 爬虫插件、生成配置、调用 CLI 验证、读取任务日志。这和图库助手受众不同，我倾向于拆成独立包或独立 preset，例如：

- `dsh-plugin-kabegame`：图库与应用集成
- `dsh-plugin-kabegame-dev`：爬虫插件开发和调试

### 我建议的 MVP

第一版只做四件事：

1. 连接本机 Kabegame MCP，并提供明确的连接状态和设置项。
2. 提供 `search_images`、`get_image`、`create_album`、`add_images_to_album` 四个高层工具。
3. `get_image` 和搜索结果能把缩略图真正送入多模态模型。
4. Web 端提供可多选的图片网格卡片，批量写操作前确认。

这样已经形成完整闭环：

```text
自然语言需求
  → 结构化搜索
  → 模型看图与筛选
  → 用户确认
  → 创建/整理画册
  → 会话中保留可重放结果
```

一句话总结：普通接入直接用 DSH 的 MCP client；只有当你要做“看图、策展、长任务、交互式图库卡片”时，`dsh-plugin-kabegame` 才真正成立。