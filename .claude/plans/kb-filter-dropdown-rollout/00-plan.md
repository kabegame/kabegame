# KbFilterDropdown 替换存量 el-dropdown

## 总体设计思路

`KbFilterDropdown` 名字来自第一个用例（画廊过滤维度），但它实际是**「chip 触发器 +
浮层」的通用单选器**：内置列表（`options` + 可选 `count`）和 `#panel` 插槽二选一，
`clearable` 决定是「可清空的过滤维度」还是「恒有值的必选项」。画廊工具行的排序 /
顺序 / 每页条数已经按后者接完（commit `c06072ed`），这份计划把剩下的 el-dropdown
按同一把尺子过一遍。

尺子只有一条：**这个下拉是在选一个「值」，还是在下一条「命令」**。

- 选值 → 有 `modelValue`，chip 上要长期显示当前值，换 KbFilterDropdown。
- 下命令（编辑/复制/删除、header 折叠动作）→ 没有 modelValue，点完就执行。硬套过来
  会把 chip 的「当前值 / 清除」语义扭曲成假状态，**保留 el-dropdown**。这类要统一
  观感的话，应该另抽一个 `KbActionMenu`：复用同一套 popper 皮肤与选项行样式，但
  不带 modelValue、不带 chip。本计划不做。

还有一条边界：**紧凑 / Android 不走 chip**。那边现在是 `van-picker` 底部选择器，
交互和触屏更贴，KbFilterDropdown 只接管 `!uiStore.isCompact` 分支。

## 现状锚点

**a. 画廊工具行（已完成，作为参照）**（`GalleryToolbar.vue:19`）

```vue
<!-- 现状:三个必选项已经是 chip 下拉,与下面的过滤 chip 同一套观感 -->
<KbFilterDropdown
  :model-value="sortField"
  :options="sortFieldItems"
  :chip-label="t('gallery.sort')"
  :clearable="false"
  class="flex-none"
  @update:model-value="(value) => { if (value) onDesktopSortFieldCommand(value); }"
>
  <template #icon><Sort /></template>
</KbFilterDropdown>
```

**b. 画册/任务/畅游工具行**（`GalleryFilters.vue:40`、`:76`、`:112`）

```vue
<!-- 现状:与 a 完全同构的三个 el-dropdown,只是多了 feature 开关 -->
<el-dropdown v-if="sortFeatures.length > 0" trigger="click" @command="onDesktopSortFieldCommand">
  <el-button class="max-w-[280px]">…{{ sortFieldLabel(sortField) }}…</el-button>
  <template #dropdown>
    <el-dropdown-menu>
      <el-dropdown-item v-for="field in sortFeatures" :command="field" …>
```

**c. 失败图片按插件过滤**（`FailedImagesDialog.vue:19`）

```vue
<!-- 现状:带计数的过滤器,「全部」就是 anyLabel,这是最贴合内置 options 的一处 -->
<el-dropdown v-if="pluginGroups.length > 1" trigger="click" @command="onPluginFilterCommand">
  <template #dropdown>
    <el-dropdown-menu>
      <el-dropdown-item command="">{{ t('gallery.filterAll') }}</el-dropdown-item>
      <el-dropdown-item v-for="g in pluginGroups" :command="g.pluginId">
        {{ getFailedPluginName(g.pluginId) }} ({{ g.count }})
```

**d. 自动配置列表的启用过滤**（`AutoConfigs.vue:29`）

```vue
<!-- 现状:全部 / 仅启用 二选一,command 串直接映射到 onlyEnabled 布尔 -->
<el-dropdown trigger="click" @command="onScheduleFilterCommand">
  <el-dropdown-menu>
    <el-dropdown-item command="all" :class="{ 'is-active': !onlyEnabled }">…
    <el-dropdown-item command="enabled" :class="{ 'is-active': onlyEnabled }">…
```

**e. header 里的排序方向**（`GallerySortControl.vue:2`）

```vue
<!-- 现状:asc/desc 二选一,但触发器是 header 里的图标按钮,不是 chip -->
<el-dropdown trigger="click" @command="handleCommand">
  <el-button class="gallery-sort-btn">…</el-button>
```

**f. header 里的简单过滤（带嵌套子菜单）**（`GalleryFilterControl.vue:26`）

```vue
<!-- 现状:一级菜单里嵌 trigger="hover" 的二级 el-dropdown,时间维度还要递归
     (GalleryTimeFilterSubmenu.vue 整个组件就是这层递归) -->
<el-dropdown-item divided class="plugin-submenu-wrap" @click.stop>
  <el-dropdown trigger="hover" placement="right-start" @command="handleTimeCommand" …>
    <template #dropdown>
      <el-dropdown-menu class="plugin-submenu-menu">
        <GalleryTimeFilterSubmenu :nodes="timeMenuRoots" … />
```

**g. 已死的每页条数控件**（`GalleryPageSizeControl.vue`）

全仓 grep（`apps` / `packages`，含 `.ts`/`.vue`）**零引用**。`HeaderFeatureId.GalleryPageSize`
在 `headerFeatures.ts:132` 注册时也没有 `comp`。

## 点 1 — 先删死代码（`GalleryPageSizeControl.vue`）

- **删除**
  - `apps/kabegame/src/components/GalleryPageSizeControl.vue` 整个文件。
    > 说明：零引用。迁移它等于给一段没人跑的代码做适配，先确认 `HeaderFeatureId.GalleryPageSize`
    > 这条 header feature 是否还有意义（目前只有 label + icon，没有 comp），一并处理。

## 点 2 — 画册/任务/畅游工具行（`GalleryFilters.vue`）

优先级最高：与已完成的画廊工具行完全同构，改动机械，且不改就出现「画廊是 chip、
画册是按钮」的分裂。

- **修改**
  - 排序维度 / 每页条数两个 `el-dropdown` → `KbFilterDropdown` + `:clearable="false"`，
    options 由 `sortFeatures` / `pageSizeOptions` map 出来（照抄 `GalleryToolbar` 的
    `sortFieldItems` / `pageSizeItems`）。
  - 搜索模式的 `el-dropdown` + 独立 `SearchInput`（`:112`、`:136`）→ 并成一个搜索
    chip，`#panel` 里放 `KbTab`（三个模式）+ `KbText`，与画廊一致。
    > 说明：这一项比前两项大，可以拆成第二步做。并进 chip 之后 `enableSearch` 的
    > 布局分支（`ml-auto`）也能一起去掉。
- **删除**
  - `onSearchModeCommand`（`:507`）改成 KbTab 的 `v-model` 后无用。

## 点 3 — 失败图片按插件过滤（`FailedImagesDialog.vue`）

- **修改**
  - `el-dropdown` → `KbFilterDropdown`，`clearable` 保持默认 `true`：
    `anyLabel = t('gallery.filterAll')`，`options = pluginGroups.map(g => ({ label, value, count }))`。
    > 说明：唯一一处天然带 `count` 的，内置列表的计数列（右对齐 mono）正是为它准备的；
    > 现在的 `名字 (12)` 拼字符串可以去掉。

## 点 4 — 自动配置启用过滤（`AutoConfigs.vue`）

- **修改**
  - `el-dropdown` → `KbFilterDropdown`，两项 options（`all` / `enabled`），
    `:clearable="false"`（「全部」本身就是一个显式值，不是空态）。

## 点 5 — header 里的排序方向（`GallerySortControl.vue`）

- **修改**
  - `el-dropdown` → `KbFilterDropdown` + `#trigger` 插槽保留现有 header 图标按钮外观。
    > 说明：header 里塞 chip 会破坏那一行的按钮节奏，所以只换浮层、不换触发器。
    > `#trigger` 插槽已经支持（`kb-filter-dropdown.vue:109`，透出 `open` / `selected`）。

## 点 6 — header 简单过滤的嵌套子菜单（`GalleryFilterControl.vue` + `GalleryTimeFilterSubmenu.vue`）

工作量最大、收益也最大的一处，建议放在最后单独做。

- **修改**
  - 整个一级菜单 → 一个 `KbFilterDropdown`，`#panel` 里放 `GalleryFilterTree`
    （桌面工具行已经是这个方案）。
    > 说明：KbFilterDropdown **没有子菜单能力**，也不该加——hover 二级菜单在触屏上
    > 本来就难用。方向是把「菜单里套菜单」换成「浮层里放树」，跟桌面过滤维度对齐。
- **删除**
  - `GalleryTimeFilterSubmenu.vue` 整个文件（它的存在理由就是 el-dropdown 的递归子菜单）。
  - `GalleryFilterControl.vue` 里 `plugin-submenu-*` 那套 scoped 样式与 hover 懒加载
    （`loadTimeRootData` / `loadTimeNodeChildren` / `timeLoadingNames`）——树面板自己
    管懒加载。

## 不动的部分（动作菜单）

以下三处是「下命令」不是「选值」，**保留 el-dropdown**：

| 文件 | 位置 | 内容 |
|---|---|---|
| `scheduler/AutoConfigListCard.vue` | `:57` | 编辑 / 复制 / 删除 |
| `header/comps/CollectAction.vue` | `:9` | 本地导入 / 网络采集 |
| `common/PageHeader.vue` | `:39` | header 折叠起来的动作 |

要统一它们的观感，正确做法是抽 `KbActionMenu`（同一套 popper 皮肤 + 32px/6px 选项行，
无 modelValue、无 chip），而不是把它们塞进 KbFilterDropdown。
