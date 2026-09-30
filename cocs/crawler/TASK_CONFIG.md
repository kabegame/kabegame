# 收集弹窗与三层配置（task config）

## 1. 三种配置的包含关系

```
plugin config（插件变量 JSON，后端格式）
  ⊂ task config（一次收集任务的全部参数）
      ⊂ 自动任务 config（= task config + 自动/定时配置，即 RunConfig）
```

- **plugin config**：插件脚本读到的 `userConfig`，键值由插件 `config.json` 的 `vars` 决定。
  checkbox 在后端是对象 `{ a: true }`，表单内部用的是数组 `["a"]`（`normalizeVarsForUI` / `expandVarsForBackend`）。
- **task config**：`TaskConfig`（`packages/kabegame-core/src/stores/crawler.ts`）——
  `pluginId` / `userConfig` / `outputDir` / `httpHeaders` / `outputAlbumId`。
- **自动任务 config**：`RunConfig`，等于 task config 再加 `name` / `description` / `url` /
  `scheduleEnabled` / `scheduleSpec` / `schedulePlannedAt` / `scheduleLastRunAt`。
  用户保存的配置一律是这一层，「保存为配置」恒为 `scheduleEnabled: false`。

## 2. 全局唯一的 taskConfig 与「先写再打开」

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
| 1 | 任务右键「再次执行」 | `await writeTaskConfig(taskConfigFromTask(task))` 再 `crawlerDrawerStore.open()` |
| 2 | 其他任何方式直接打开 | 不写，直接 `open()` |
| 3 | 首次打开、无上次值 | 同 2（`taskConfig` 为 `null`，弹窗只显示插件选择器） |
| 4 | 自动配置卡片「以此配置运行」 | `await writeTaskConfig(taskConfigFromRunConfig(cfg))` 再 `open()` |

通路 4 **不写配置 id、任务不关联该配置、也不回存原配置**：它只是把该配置的 task 部分当作参数初值；
要改原配置走卡片「更多 → 编辑」。

## 3. 唯一写入口与优先级

app 侧 `apps/kabegame/src/composables/taskConfig.ts` 是唯一的写入口：

```ts
writeTaskConfig(input)  // 读插件定义 + fetchPluginUserDefault，整体替换 store 值并 revision++
```

`resolveTaskConfig(input, userDefault, defs)` 是**无副作用纯函数**，优先级：

- **vars 逐 key**：`入参有效值 > 用户默认有效值 > 插件声明 default`
  （复用 `validateVarValue`；入参无效值回落到用户默认；显式 `null` 抑制默认值填充）。
- **整字段**：`outputDir` / `httpHeaders` / `outputAlbumId` 直接 `input ?? userDefault ?? 空`，
  `""` 与 `{}` 也算显式值，不回落到用户默认。

弹窗内改选来源插件本身也是一次写入：`writeTaskConfig({ pluginId })`，
于是 vars / outputDir / headers 取「用户默认 > 插件默认」。

## 4. revision 重建与 `when` 只控显隐

`PluginConfigForm` 的 v-model 是**后端格式**的 plugin config，内部持有 UI 格式；
父级以 `:key="taskConfigRevision"` 重建它——**只有外部写入才重建**，用户编辑不触发循环。

`when`（字段级与选项级）只控制显隐/可选，不改 store：

- 字段级 `when` 隐藏的字段，其值原样留在 `tc.userConfig`，依赖项切回来时原值重新出现；
  只有切换插件（整体替换）才清掉。
- 选项级 `when` 用派生只读的 `effectiveVars = withCoercedOptions(uiVars, defs)` 供展示：
  当前值不可选时界面显示回退值，但 store 里的原值不动；用户一旦手动选择才写回。
- **提交时裁剪**：`buildSubmitUserConfig` 按真实表单结构产出提交用 plugin config——
  选项回退 → 只保留当前可见字段 → 转后端格式，被隐藏的字段不传给插件脚本。

## 5. Dialog 交互

- **header 右侧「运行配置」**：任何入口都显示，`modal.close()` 后跳自动配置页。
- **footer 左下「保存为配置」**：弹名称 + 描述小对话框，写入 `addRunConfig({ ...tc, scheduleEnabled: false })`；
  未选插件时禁用。
- **无运行配置下拉、无定时表单**：定时只在自动配置页编辑。
- 「开始收集」发起的任务一律是手动任务，**不带 `runConfigId`**；成功后关闭且不重置 `taskConfig`。

## 6. 相关代码

| 位置 | 职责 |
| --- | --- |
| `apps/kabegame/src/components/CrawlerDialog.vue` | 壳：桌面 `ElDialog` / 紧凑 `AndroidDrawer`、header 链接、footer 按钮 |
| `apps/kabegame/src/components/crawler/CrawlerTaskForm.vue` | 表单主体、新建输出画册、保存为配置、提交 |
| `apps/kabegame/src/components/crawler/PluginConfigForm.vue` | 插件变量区（UI 格式 ↔ 后端格式） |
| `apps/kabegame/src/composables/taskConfig.ts` | `writeTaskConfig` / 优先级纯函数 / 翻译函数 |
| `apps/kabegame/src/stores/crawlerDrawer.ts` | 只剩 `visible` / `open()` / `close()` |
| `packages/kabegame-core/src/stores/crawler.ts` | `taskConfig` / `taskConfigRevision` / `RunConfig.outputAlbumId` |
