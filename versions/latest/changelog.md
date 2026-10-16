# v4.5.2 changelog

## 用户侧

### Added
- 任务列表顶部新增搜索框，输入插件名称或插件 ID 即可筛选出对应任务。
- 桌面端视频预览支持按空格键播放/暂停，按 `Command/Ctrl + ←/→` 快退/快进 5 秒。

### Optimized
- 将 v8 fetch 请求超时上线提高到5分钟

### Changed
- 插件配置项都可以随时清空（插件收到空值），必填项只在启动任务时校验，保存插件默认配置时可以留空。
- 插件页当前所在的商店 tab 记录在地址栏（`?tab=`），从插件详情返回时停留在原商店 tab，商店列表与图标不再重新加载。
- 画册选择下拉框不再显示分区之间的分割横线。
- 任务列表中正在运行的任务不能直接删除，需要先停止任务；运行中的删除按钮和右键「删除任务」会置灰。
- 任务列表进度条旁的停止叉号不再弹出确认对话框，改为在叉号下方弹出「停止任务？」小确认框；右键菜单「停止任务」仍用确认对话框。
- 文档
    - readme更显示介绍而非简单的声明
    - 日文、韩文和英文 README 同步重写为与中文版逐行同构的产品入口结构（181 行）。
    - 主站文档同步，去掉过时内容
    - 畅游指南按当前 dev 重写，补充一键下载、冻结网页、Cookie 复用和站点下载图片管理，并用带 `-annotated` 标识的 Wallhaven 实机截图精简操作说明。
    - 画册指南用 9 张带短标签和箭头的 dev 实机截图替代大段入口说明，突出标签自动归类、本地文件夹同步以及「移除关系 / 删除文件」的区别。
    - 任务指南补齐「等待剩余下载」收尾状态、逐任务下载并发、任务详情、创建与停止确认流程，并用 5 张带标注的 dev 实机截图指出关键状态与操作位置。

### Fixed
- 桌面宽屏标题栏补上「管理源」入口，可编辑商店源名称与地址。
- 桌面端插件选择下拉框搜索时同时匹配插件 ID，可直接输入 `pixiv` 等 ID 找到插件。
- 插件配置中「不限」「全部」等空值选项现在能正常显示和选择。
- 源管理弹窗中删除商店源现在会真正删除。
- 修复管理源按钮不显示的问题
- 修复文件夹画册切换为递归同步（或从递归切走）后，画册树中已展开的子画册仍显示旧同步状态、需要手动刷新的问题。
- 修复加入画册、收集输出画册、轮播画册等选择器里标签目录无法展开、选不到目录下标签的问题：点目录行即展开。

### Optimized
- 画册选择器与画册树打开更快：标签很多时不再卡顿数秒，画册列表先显示，图片数量随后补上。

## 插件开发侧

### Added
- 新增变量字段 `required: true` 显式声明必填。没有 `default` 不再隐式等于必填；可选字段不需要再写 `default: ""` / `default: []`。必填只在字段可见时校验，由宿主在创建任务前统一拦截（主应用、CLI、自动任务都会经过）。
- `@kabegame/plugin-sdk` 与 `@kabegame/types` 发布到 npm 并改为 MIT 许可；`kabegame-cli plugin new` 的 V8 模板改为从 npm 安装二者（版本跟随 CLI），仓库外的插件作者生成后可直接 `npm install`。

### Changed
- **Breaking**：`kbConfig` 变量的取值语义重新定义，插件脚本需要能处理 `null` 与 `undefined`：
  - 被 `when` 隐藏的字段**不出现在 config 中**（读到 `undefined`）；
  - 可见但用户未填的字段为 `null`，宿主不再补 `""`、`0`、`[]` 或全 `false` 的 checkbox 对象；
  - 没有 key 时才回落到用户默认配置、再回落到 `default`；用户主动清空带 `default` 的字段得到的是 `null`，不会回落；
  - `boolean` 永不为 `null`，没写 `default` 时为 `false`；
  - checkbox 的值是包含全部 `variable` 的 `{ [variable]: boolean }` 对象，一项都没勾时为 `null`；
  - options 中声明的 `variable: ""` 是合法选项值，选中时原样传 `""`。
- 宿主在创建任务前严格校验变量值，不再静默纠正：字符串类必须非空、list 必须非空、int / float 受 `min` / `max` 约束、options 必须是当前可见的选项、checkbox 键集合必须与声明一致，不合规直接拒绝任务。
- `when` 支持链式传递：被隐藏的字段不能再让依赖它的字段可见。字段级或选项级 `when` 形成依赖环的插件会在打包与安装时被拒绝。
- CLI `plugin run --var`：`key=` 显式清空为 `null`；checkbox 写作 `key=a,b`；options 只接受声明过的 `variable` 或显示名，其余值直接报错。
- `@kabegame/plugin-sdk` 类型：`kbCfgField<K, T, M>` 新增修饰参数，`{ required: true }` 去掉 `null`、`{ when: true }` 让 key 变成可选；`kbCfgCheckbox<V>` 改为 `Record<V, boolean>`，与运行时一致。
- 仓库内插件已全部迁移：删掉多余的空 `default`，给必需输入加上 `required`，并修复把 `null` 拼成字符串 `"null"` 的读取点。第三方插件请检查 `String(x)`、模板字符串插值、`x.trim()` / `x.split()` / `x.length` 和 `Object.entries(checkbox)` 等写法。
- 插件 `package.json` 的 `name` 可写成 `kabegame-plugin-<id>`，应用加载时剥离前缀作为插件 id；`kabegame-cli plugin new <id>` 生成 `kabegame-plugin-<id>/`，`plugin pack` 要求输出 `<id>.kgpg`；官方插件目录同步改名，id 不变，`engines.kabegame` 提到 `>=4.5.2`。

## 开发侧

### Added
- 项目新增 `annotate-ui-screenshots` skill，统一真实界面截图的短标签、箭头、文件命名、目视复核和正文去重流程。

### Changed
- AGENT 约束文档
    - 将顶层命令的参数、构建注意事项和验证指南迁入 `scripts/AGENTS.md`，根规则仅保留命令索引和用途摘要。
    - 将组件库、`packages/` 子仓库和生成型包的维护规则收口到 `packages/AGENTS.md`。
    - 将第三方补丁工作流统一收口到 `third-patches/AGENTS.md`，并明确 CEF 正式补丁序列与构建期临时提交的边界。
- 画册目录页的 `~~/images` 计数不再给标签目录（`label_dir`）出行；前端画册树只等行与子画册数就渲染，图片计数单独到达后再补。
