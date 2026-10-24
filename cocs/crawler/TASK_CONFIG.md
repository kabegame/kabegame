# 收集弹窗与三层配置（task config）

## 1. 三种配置的包含关系

```
plugin config（插件变量 JSON，后端格式）
  ⊂ task config（一次收集任务的全部参数）
      ⊂ 自动任务 config（= task config + 自动/定时配置，即 RunConfig）
```

- **plugin config**：插件脚本读到的 `userConfig`，键值由 `package.json.kbConfig` 决定。
  checkbox 在后端是完整对象 `{ a: true, b: false }`，表单内部用数组 `["a"]`（`normalizeVarsForUI` / `expandVarsForBackend`）。
- **task config**：`TaskConfig`（`apps/kabegame/src/stores/crawler.ts`）——
  `pluginId` / `userConfig` / `outputDir` / `httpHeaders` / `outputAlbumId` /
  `maxConcurrentDownloads` / `isDryRun`。并发字段为 `null` 时跟随应用全局下载并发；`isDryRun`
  是本次任务的冻结参数，空跑时仍执行插件逻辑、请求、翻页、日志与进度，但不下载、不入库。
- **自动任务 config**：`RunConfig`，等于 task config 再加 `name` / `description` / `url` /
  `scheduleEnabled` / `scheduleSpec` / `schedulePlannedAt` / `scheduleLastRunAt`。
  用户保存的配置一律是这一层，「保存为配置」恒为 `scheduleEnabled: false`。

## 2. 插件变量的转换、合并与校验

职责边界是「入口转换，后端定语义」：主应用把控件的空表示转换为 `null`，CLI 把 `key=value` 字符串转换成声明类型；两者都不自行决定最终默认值。`build_effective_user_config_from_var_defs` 是唯一的合并、链式 `when` 过滤和校验入口。

合并顺序从高到低为：本次提交 config → `default-configs/<id>.json` 的 `userConfig` → 插件字段 `default` → 隐式空值。显式 `null` 算已提交，不继续回落。隐式空值中 boolean 为 `false`，其他类型为 `null`。未在 `kbConfig` 声明的扩展键继续原样透传，以兼容内建本地导入等调用方。

合并后按不动点计算 `when`：每轮只让当前仍可见的字段参与条件匹配，隐藏一个字段会使依赖它的下游字段继续隐藏。隐藏字段从最终对象中删除；依赖图成环在插件解析与安装阶段直接拒绝。剩余值只允许是声明类型的规范值或 `null`，`required: true` 和 boolean 不接受 `null`。options 的 `variable: ""` 是合法选项，不按空值处理。

`start_task` 在建任务前完成上述处理，并把最终快照写入 `TaskInfo.user_config`；因此用户之后修改默认配置不会让既有任务漂移。调度器运行前再次用当前插件定义校验该快照，插件升级使旧任务失配时任务直接失败。

### 路径类变量的冻结解析

`user_config` 里 `path` / `file` / `folder` / `file_or_folder` 的值是**用户选择的宿主路径（Android 为 `content://`）**，数据库永远保留这个原值。调度器 `freeze_task` 在配置合并 / 校验之后调用 `input_mounts::resolve_input_mounts`：

- 桌面：必须是绝对路径 → `canonicalize`（不存在即报「配置不合法」）→ 按声明类型检查 `is_file` / `is_dir`；`path` / `file_or_folder` 两者都接受。
- Android：只接受 `content://`；`folder` 类型或目录 URI 直接报错（「Android 暂不支持文件夹类型的插件变量」）；文件经 `ContentIoProvider.open_fd` 得到 fd，挂载 `/proc/self/fd/N`，文件名取 `get_display_name`。
- 内建插件（`local-import` / `webpage`）跳过，它们直接用宿主路径。
- 变量 key 不能含 `/`、`\` 或为 `.` / `..`；文件名不可用时退回 `file`。

解析结果作为 `TaskParams.inputs` 交给 `Task::try_new`，后者把它挂到 `PluginVfs` 的只读 `input` 挂载点，并**就地改写 `params.config[key]` 为虚拟路径**（文件 `/{handle}/input/<key>/<文件名>`、文件夹 `/{handle}/input/<key>`）。V8 的 `custom.<key>` 与 WebView bootstrap 烘焙的 vars 都读取这份 config，因此两端一致且都不接触宿主路径。改写只发生在运行时 `TaskParams`，不写回任务记录。

## 3. 全局唯一的 taskConfig 与「先写再打开」

core crawler store 只存一份：

```ts
const taskConfig = ref<TaskConfig | null>(null);
const taskConfigRevision = ref(0); // 仅外部写入递增
function setTaskConfig(cfg: TaskConfig | null) { taskConfig.value = cfg; taskConfigRevision.value++; }
```

`CrawlerDialog` 对来源无感：它不接收 props 配置、不读 lastRun、不区分入口，表单控件直接绑定
`crawlerStore.taskConfig` 的字段，用户编辑即就地修改全局对象——所以关闭再打开「自然就是上次的值」。

四条通路：

| 通路 | 入口 | 做法 |
| --- | --- | --- |
| 1 | 任务「再次执行」（抽屉右键 / 任务详情页 header） | `await writeTaskConfig(taskConfigFromTask(task))` 再 `crawlerDrawerStore.open()`；两处共用 `useTaskRerun` |
| 2 | 其他任何方式直接打开 | 不写，直接 `open()` |
| 3 | 首次打开、无上次值 | 同 2（`taskConfig` 为 `null`，弹窗只显示插件选择器） |
| 4 | 自动配置卡片「以此配置运行」 | `await writeTaskConfig(taskConfigFromRunConfig(cfg))` 再 `open()` |

通路 4 **不写配置 id、任务不关联该配置、也不回存原配置**：它只是把该配置的 task 部分当作参数初值；
要改原配置走卡片「更多 → 编辑」。

## 4. 唯一写入口与优先级

app 侧 `apps/kabegame/src/composables/taskConfig.ts` 是唯一的写入口：

```ts
writeTaskConfig(input)  // 读插件定义 + fetchPluginUserDefault，整体替换 store 值并 revision++
```

`resolveTaskConfig(input, userDefault, defs)` 是**无副作用纯函数**，优先级：

- **vars 逐 key**：`入参有效值 > 用户默认有效值 > 插件声明 default`
  （复用 `validateVarValue`；入参无效值回落到用户默认；显式 `null` 抑制默认值填充）。
- **整字段**：`outputDir` / `httpHeaders` / `outputAlbumId` 直接 `input ?? userDefault ?? 空`，
  `""` 与 `{}` 也算显式值，不回落到用户默认。
- **任务并发**：`maxConcurrentDownloads` 只取本次入参，缺失或显式 `null` 都表示跟随全局；
  它不属于插件用户默认配置，不能从 `userDefault` 继承。
- **空跑**：`isDryRun` 同样只取本次入参，缺失为 `false`，不从 `userDefault` 继承；再次执行和
  `RunConfig` 回填原值，推荐配置导入/导出保留该字段，供定时站点结构检查使用。

弹窗内改选来源插件本身也是一次写入：`writeTaskConfig({ pluginId })`，
于是 vars / outputDir / headers 取「用户默认 > 插件默认」。

## 5. revision 重建与链式 `when`

`PluginConfigForm` 的 v-model 是**后端格式**的 plugin config，内部持有 UI 格式；
父级以 `:key="taskConfigRevision"` 重建它——**只有外部写入才重建**，用户编辑不触发循环。

`when`（字段级与选项级）按链式可见性控制显隐/可选，不改 store：

- 字段级 `when` 通过不动点迭代计算；上游隐藏后，下游即使值仍留在 store 也会继续隐藏。隐藏字段的原值留在 `tc.userConfig`，依赖项切回来时原值重新出现；
  只有切换插件（整体替换）才清掉。
- 选项级 `when` 只读取当前可见字段组成的值视图，并用派生只读的 `effectiveVars = withCoercedOptions(uiVars, defs)` 供展示：
  当前值不可选时界面显示回退值，但 store 里的原值不动；用户一旦手动选择才写回。
- **提交时裁剪**：`buildSubmitUserConfig` 按真实表单结构产出提交用 plugin config——
  选项回退 → 只保留当前可见字段 → 转后端格式，被隐藏的字段不传给插件脚本。

## 6. Dialog 交互

表单分三段，顺序固定：

1. **任务设置**（最上）：输出目录（仅非紧凑）、输出画册（含「新建画册」）、任务最大下载并发（`MaxDownloadsField`：「跟随全局」开关打开时存 `null`，关闭时以当前全局值为初值显示 `KbNumber`）与空跑开关。
2. **插件设置**（中间）：选择源 + 插件变量。
3. **高级设置**（最下）：HTTP 头。

**没有选源时三段都显示**：任务设置/高级设置编辑的是组件内的本地草稿
（`draftOutputDir` / `draftOutputAlbumId` / `draftHttpHeaders` / `draftMaxConcurrentDownloads` /
`draftIsDryRun`），`taskConfig` 仍为 `null`；
一旦选到源，草稿随 `writeTaskConfig({ pluginId, ...draft })` 一并并入 task config，
不会白填。（已经选过源之后再换插件不带草稿，避免把上一个任务的目录/头带给新插件。）

其余交互：

- **header 右侧「运行配置」**：任何入口都显示，`modal.close()` 后跳自动配置页。
- **footer 左下「保存为配置」**：弹名称 + 描述小对话框，写入 `addRunConfig({ ...tc, scheduleEnabled: false })`；
  未选插件时禁用。保存的内容与提交一样按可见字段裁剪。
- **无运行配置下拉、无定时表单**：定时只在自动配置页编辑。
- 「开始收集」发起的任务一律是手动任务，**不带 `runConfigId`**；成功后关闭且不重置 `taskConfig`。

## 7. 相关代码

| 位置 | 职责 |
| --- | --- |
| `apps/kabegame/src/components/CrawlerDialog.vue` | 壳：桌面 `ElDialog` / 紧凑 `AndroidDrawer`、header 链接、footer 按钮 |
| `apps/kabegame/src/components/crawler/CrawlerTaskForm.vue` | 表单主体、新建输出画册、保存为配置、提交 |
| `apps/kabegame/src/components/crawler/PluginConfigForm.vue` | 插件变量区（UI 格式 ↔ 后端格式） |
| `apps/kabegame/src/composables/taskConfig.ts` | `writeTaskConfig` / 优先级纯函数 / 翻译函数 |
| `apps/kabegame/src/stores/crawlerDrawer.ts` | 只剩 `visible` / `open()` / `close()` |
| `apps/kabegame/src/stores/crawler.ts` | `taskConfig` / `taskConfigRevision` / `RunConfig` 任务参数与实时并发命令 |
