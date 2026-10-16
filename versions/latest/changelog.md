# v4.5.2 changelog

## 用户侧

- 插件配置项都可以随时清空（插件收到空值），必填项只在启动任务时校验，保存插件默认配置时可以留空；「不限」「全部」等空值选项现在能正常显示和选择。
- 文档
    - readme更显示介绍而非简单的声明
    - 主站文档同步，去掉过时内容
    - 畅游指南按当前 dev 重写，补充一键下载、冻结网页、Cookie 复用和站点下载图片管理，并用带 `-annotated` 标识的 Wallhaven 实机截图精简操作说明。
    - 画册指南用 9 张带短标签和箭头的 dev 实机截图替代大段入口说明，突出标签自动归类、本地文件夹同步以及「移除关系 / 删除文件」的区别。
    - 任务指南补齐「等待剩余下载」收尾状态、逐任务下载并发、任务详情、创建与停止确认流程，并用 5 张带标注的 dev 实机截图指出关键状态与操作位置。
    - 项目新增 `annotate-ui-screenshots` skill，统一真实界面截图的短标签、箭头、文件命名、目视复核和正文去重流程。

## 插件开发侧

- **Breaking**：`kbConfig` 变量的取值语义重新定义，插件脚本需要能处理 `null` 与 `undefined`：
  - 被 `when` 隐藏的字段**不出现在 config 中**（读到 `undefined`）；
  - 可见但用户未填的字段为 `null`，宿主不再补 `""`、`0`、`[]` 或全 `false` 的 checkbox 对象；
  - 没有 key 时才回落到用户默认配置、再回落到 `default`；用户主动清空带 `default` 的字段得到的是 `null`，不会回落；
  - `boolean` 永不为 `null`，没写 `default` 时为 `false`；
  - checkbox 的值是包含全部 `variable` 的 `{ [variable]: boolean }` 对象，一项都没勾时为 `null`；
  - options 中声明的 `variable: ""` 是合法选项值，选中时原样传 `""`。
- 新增变量字段 `required: true` 显式声明必填。没有 `default` 不再隐式等于必填；可选字段不需要再写 `default: ""` / `default: []`。必填只在字段可见时校验，由宿主在创建任务前统一拦截（主应用、CLI、自动任务都会经过）。
- 宿主在创建任务前严格校验变量值，不再静默纠正：字符串类必须非空、list 必须非空、int / float 受 `min` / `max` 约束、options 必须是当前可见的选项、checkbox 键集合必须与声明一致，不合规直接拒绝任务。
- `when` 支持链式传递：被隐藏的字段不能再让依赖它的字段可见。字段级或选项级 `when` 形成依赖环的插件会在打包与安装时被拒绝。
- CLI `plugin run --var`：`key=` 显式清空为 `null`；checkbox 写作 `key=a,b`；options 只接受声明过的 `variable` 或显示名，其余值直接报错。
- `@kabegame/plugin-sdk` 类型：`kbCfgField<K, T, M>` 新增修饰参数，`{ required: true }` 去掉 `null`、`{ when: true }` 让 key 变成可选；`kbCfgCheckbox<V>` 改为 `Record<V, boolean>`，与运行时一致。
- 仓库内插件已全部迁移：删掉多余的空 `default`，给必需输入加上 `required`，并修复把 `null` 拼成字符串 `"null"` 的读取点。第三方插件请检查 `String(x)`、模板字符串插值、`x.trim()` / `x.split()` / `x.length` 和 `Object.entries(checkbox)` 等写法。

## 开发侧

- AGENT 约束文档
    - 将顶层命令的参数、构建注意事项和验证指南迁入 `scripts/AGENTS.md`，根规则仅保留命令索引和用途摘要。
    - 将组件库、`packages/` 子仓库和生成型包的维护规则收口到 `packages/AGENTS.md`。
    - 将第三方补丁工作流统一收口到 `third-patches/AGENTS.md`，并明确 CEF 正式补丁序列与构建期临时提交的边界。
