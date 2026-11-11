# 05 前端：排序维度「颜色」

## 总体设计思路

排序在前端是一个 `GallerySort { field, desc, seed? }`，随机排序用 `seed` 带参数。颜色排序照这个先例加两个字段值与一个参数 `color`（六位小写十六进制）：`by-color` 对应色桶段 `sort/by-color_0x…`（预计算），`by-any-color` 对应现算段 `sort/by-any-color_0x…`。字段值与路径段一一对应，路径的构造与解析仍是纯函数。其余靠 TypeScript 的穷尽检查把所有按 `field` 分支的地方（标签、图标、说明文案）逐个点出来；两个字段在界面上是同一个维度「颜色」，标签与图标相同。四个网格页共用 `GalleryQueryBar`，各自的 `sortFeatures` 里只加 `by-color` 一项，它同时代表两个字段。

**用色桶还是现算，前端在一个地方判断**：`colorSortFor(hex, buckets)`——颜色在色桶列表里就给 `by-color`，否则给 `by-any-color`。用户选颜色时调它；色桶列表变化（存了新色桶、删了色桶）或带着过期的段进来（收藏视图、粘贴的路径）时，再用它校正一次当前排序。两个段对同一个颜色排出的顺序相同，校正只换路径、画面不跳。收藏视图存的是当时的路径，前端不会因为存视图去建色桶。

交互上，排序维度下拉里多一行「颜色」（调色板图标）。它和别的行不同：点它不直接选中，而是在下拉面板里**就地展开**一块色桶面板，里面是色块网格；点一个色块才导航并关闭。就地展开而不是侧向弹出二级浮层，是因为同一个下拉在窄屏（安卓）上是居中对话框，侧向浮层放不下；就地展开两种承载方式都成立，也不涉及「点了子浮层把父面板关掉」的问题。为此 `KbFilterDropdown` 的选项加一个 `expandable` 标记与一个 `option-panel` 插槽，组件库只管展开收起，面板内容由应用侧的 `ColorBucketPanel` 提供。

代表色的展示是另一件独立的小事：色盘作为列表字段随图片行到前端（JSON 文本），详情的「基本信息」面板把它解析后画成一条按占比分段的色带。面板不发请求、不观察任何 key，数据与补丁都走图片行现有的通路。

色桶列表是 `color_buckets://` 的观察方（`useColorBuckets`），听 `color-buckets-change` 重读。面板里依次是 12 个基本色块、用户保存的色块、末尾一个「其它颜色」。点「其它颜色」打开内嵌的取色面板（组件库自带的 `ElColorPickerPanel`，不是弹层），下面两个按钮：「按这个颜色排序」直接导航（不在色桶里就是现算段），「保存为色桶」调 `add_color_bucket` 后按色桶排序。用户保存的色块悬停出现删除角标，确认后调 `delete_color_bucket`。写完不主动刷新，等事件。

## 现状锚点

**a. 排序类型与路径**（`utils/galleryPath.ts:44`、`:130`、`:408`）

```ts
export type GallerySortField =
  "by-id" | "by-time" | "by-size" | "by-name" | "by-aspect" | "by-set-time" | "by-album-order" | "random";

export interface GallerySort {
  field: GallerySortField;
  desc: boolean;
  /** 随机排序种子（十进制字符串，1-18 位）；field 为 "random" 时必填。 */
  seed?: string;
}

function sortBodyPath(sort: GallerySort, omitRandomSeed = false): string {
  if (sort.field !== "random") return `sort/${sort.field}`;      // 现状：只有随机带参数
  return omitRandomSeed ? "sort/random" : `sort/random-${sort.seed || newRandomSortSeed()}`;
}

function parseSortChunk(chunk: readonly string[]): { sortField?: GallerySortField; sortSeed?: string } {
  const field = chunk[1];
  const randomMatch = /^random-([0-9]{1,18})$/.exec(field ?? "");
  if (randomMatch) return { sortField: "random", sortSeed: randomMatch[1] };
  return isGallerySortField(field) ? { sortField: field } : {};
}
```

**b. 排序维度 chip**（`components/gallery/GalleryQueryBar.vue:17`、`:634`）

```vue
<KbFilterDropdown
  v-if="showSortFieldChip"
  :model-value="sortField"
  :options="sortFieldItems"
  :chip-label="t('gallery.sort')"
  chip-display="icon"
  :title="chipTitle(t('gallery.sort'), sortFieldChipValue)"
  :clearable="false"
  @update:model-value="(value) => { if (value) onSortFieldCommand(value); }"
>
  <template #icon>
    <span class="sort-combo">
      <Sort class="sort-combo__base" />
      <component :is="sortFieldIcon" class="sort-combo__badge" />
    </span>
  </template>
</KbFilterDropdown>
```

```ts
const sortFieldItems = computed<KbFilterDropdownOption[]>(() =>
  props.sortFeatures.map((field) => ({ label: gallerySortFieldLabel(field, t), value: field })),
);

function onSortFieldCommand(cmd: string) {
  if (!props.sortFeatures.includes(cmd as GallerySortField)) return;
  if (cmd === "random") {
    navigate({ sort: { field: "random", desc: props.sort.desc, seed: newRandomSortSeed() } });
    return;
  }
  navigate({ sort: { field: cmd as GallerySortField, desc: props.sort.desc } });
}
```

**c. 下拉选项**（`packages/kabegame-element-plus/src/components/kb-filter-dropdown/src/`）

```ts
// kb-filter-dropdown.ts —— 现状：选项是平的，没有子项
export interface KbFilterDropdownOption {
  label: string
  value: string
  count?: number
}
```

```vue
<!-- kb-filter-dropdown.vue —— 现状：每个选项一颗按钮，点了就选中并关闭 -->
<button
  v-for="(option, index) in filteredOptions"
  :key="option.value"
  type="button"
  role="option"
  ...
  @click="selectValue(option.value)"
>
  <span :class="ns.e('option-label')">{{ option.label }}</span>
  ...
</button>
```

**d. 排序图标表**（`components/gallery/galleryChipIcons.ts:34`）

```ts
export const SORT_FIELD_ICONS: Record<GallerySortField, Component> = {
  "by-id": markRaw(Rank),
  "by-time": markRaw(Clock),
  ...
  random: markRaw(MagicStick),
};
```

**e. 各页的排序维度清单**

```ts
// GalleryQueryBar.vue:341（画廊默认）
sortFeatures: () => ["by-id", "by-time", "by-size", "by-name", "by-aspect", "by-set-time", "random"],
// views/TaskDetail.vue:220、views/SurfImages.vue:100
const taskSortFeatures: GallerySortField[] = ["by-id", "by-time", "by-size", "by-name", "by-aspect", "by-set-time"];
// views/Albums.vue:584 —— 同上，另含 by-album-order
```

---

## 点 1 — 排序类型、路径构造与解析（`utils/galleryPath.ts`）

- **修改**

```ts
export type GallerySortField =
  | "by-id" | "by-time" | "by-size" | "by-name" | "by-aspect" | "by-set-time" | "by-album-order" | "random"
  | "by-color"          // 新增：色桶，预计算
  | "by-any-color";     // 新增：任意颜色，现算

export interface GallerySort {
  field: GallerySortField;
  desc: boolean;
  seed?: string;
  /** 颜色（六位小写十六进制，不带前缀）；field 为 "by-color" / "by-any-color" 时必填。 */
  color?: string;                                                // 新增
}

/** 两个颜色排序字段在界面上是同一个维度。 */
export function isColorSortField(field: GallerySortField): field is "by-color" | "by-any-color" {   // 新增
  return field === "by-color" || field === "by-any-color";
}

/**
 * 按某个颜色排序该用哪个段：在色桶里用预计算段，否则用现算段。
 * 用色桶还是现算只在这里判断。
 */
export function colorSortFor(hex: string, bucketHexes: ReadonlySet<string>, desc: boolean): GallerySort {   // 新增
  return { field: bucketHexes.has(hex) ? "by-color" : "by-any-color", desc, color: hex };
}

function sortBodyPath(sort: GallerySort, omitRandomSeed = false): string {
  if (isColorSortField(sort.field)) return `sort/${sort.field}_0x${sort.color}`;   // 新增：两个段同一种写法
  if (sort.field !== "random") return `sort/${sort.field}`;
  ...
}

function parseSortChunk(chunk) {
  const field = chunk[1];
  const randomMatch = ...;
  if (randomMatch) return { sortField: "random", sortSeed: randomMatch[1] };
  const colorMatch = /^(by-color|by-any-color)_0x([0-9a-f]{6})$/.exec(field ?? "");   // 新增
  if (colorMatch) return { sortField: colorMatch[1] as GallerySortField, sortColor: colorMatch[2] };
  // 不带颜色的裸 "by-color" / "by-any-color" 不是合法排序段：返回 {}，调用方回落默认排序
  return isGallerySortField(field) && !isColorSortField(field) ? { sortField: field } : {};   // 修改
}
```

  - `isGallerySortField` 加两个新值。
  - `normalizeGallerySort`：颜色排序且 `color` 合法（`/^[0-9a-f]{6}$/`）时保留 `color`；不合法时整体回落 `by-time`（与无法识别的字段同样处理）。
  - 解析结果组装处（`:275` 附近，现在给随机排序带 `seed`）同样带上 `color`。
  - 收藏视图：查询体把排序段原样存下（`omitRandomSeed` 只影响随机排序）。存的是当时的段——现算就是 `by-any-color_0x…`——不触发任何色桶写入；应用时若段已过期，由点 6 校正。

## 点 2 — 标签、图标、i18n

- **新增**
  - 图标 `FilterColor`（调色板，16px 线性，和其它 `filter-*` 一套画法）：`packages/kabegame-element-plus-icons/svg/filter-color.svg`，跑图标生成器产出组件。
  - `utils/galleryFilterLabels.ts`：`colorLabel(hex, buckets, t)`——基本色桶返回 `t("gallery.colorBucket." + key)`，其它颜色（用户保存的色桶、没保存的颜色）返回 `#rrggbb`。
  - i18n（`packages/kabegame-i18n/src/locales/{zh,zhtw,en,ja,ko}/gallery.json`）：

| 键 | 中文 |
|---|---|
| `sortByColor` | 颜色 |
| `byColorAsc` / `byColorDesc` | 最接近的在前 / 最远的在前 |
| `colorBucket.red` … `colorBucket.gray` | 红、橙、黄、绿、青、蓝、紫、粉、棕、黑、白、灰 |
| `colorOther` | 其它颜色 |
| `colorSortByThis` | 按这个颜色排序 |
| `colorSaveAsBucket` | 保存为色桶 |
| `colorAnyHint` | 没保存的颜色每次排序时现算，图库很大时会慢；保存为色桶后不用再算 |
| `colorBucketDelete` / `colorBucketDeleteConfirm` | 删除这个色桶 / 删除后按它排序的视图改为现算 |
| `colorBucketExists` / `colorBucketLimit` | 这个颜色已经是色桶了 / 最多保存 24 个颜色 |

- **修改**
  - `SORT_FIELD_ICONS` 的 `by-color` 与 `by-any-color` 都是 `markRaw(FilterColor)`。
  - `gallerySortFieldLabel`：两个颜色字段都是 `sortByColor`；`gallerySortOrderLabels`：都是 `byColorAsc` / `byColorDesc`。
  - `header/comps/GallerySortControl.vue` 的两段 `if` 链各加一行（用 `isColorSortField` 判）（或顺手改成调 `gallerySortOrderLabels`，两处文案本来就重复）。
  - `components/gallery/savedViews/SavedViewCombination.vue`：排序是颜色排序（两个字段之一）时在维度名后跟一个小色块与 `colorLabel`。

## 点 3 — `KbFilterDropdown` 的可展开选项（组件库）

- **修改**
  - `KbFilterDropdownOption` 加 `expandable?: boolean`。
  - 可展开的选项点一下只切换展开状态，不 emit、不关闭；展开时在它下方渲染 `option-panel` 插槽。面板重新打开时收起；键盘上回车 / 空格同样是切换。

```ts
export interface KbFilterDropdownOption {
  label: string
  value: string
  count?: number
  /** 点它不选中，而是在它下方展开 `option-panel` 插槽（由调用侧在面板里完成选择）。 */
  expandable?: boolean                                    // 新增
}
```

```vue
<template v-for="(option, index) in filteredOptions" :key="option.value">
  <button
    ...
    :aria-expanded="option.expandable ? expandedValue === option.value : undefined"
    @click="option.expandable ? toggleExpanded(option.value) : selectValue(option.value)"
  >
    <span :class="ns.e('option-label')">{{ option.label }}</span>
    <el-icon v-if="option.expandable" :class="[ns.e('option-arrow'), ns.is('expanded', expandedValue === option.value)]">
      <ArrowRight />
    </el-icon>
    ...
  </button>
  <!-- 新增：展开区。close 让面板内容在完成选择后关掉整个下拉 -->
  <div v-if="option.expandable && expandedValue === option.value" :class="ns.e('option-panel')">
    <slot name="option-panel" :option="option" :close="close" />
  </div>
</template>
```

  > 样式进 `theme-chalk` 的 `kb-filter-dropdown.scss`（箭头旋转、展开区内边距），不在业务侧覆盖。当前选中值是可展开选项时，该行照常高亮。

## 点 4 — 色桶数据与写操作

- **新增**
  - `services/kbEvents/events.ts`：`KbEventMap` 加 `"color-buckets-change": { seq: number }`。
  - `composables/useColorBuckets.ts`：`usePathqlLooker` 观察 `color_buckets://` 的行，`refreshOn: [on("color-buckets-change")]`；返回 `buckets`（`{ rgb, hex, key, position }[]`，`hex` 由 `rgb` 补零转出）、`loading`、`loaded`。
  - `useColorBuckets` 另给出 `bucketHexes`（`Set<string>`），供 `colorSortFor` 用。
  - `services/colorBuckets.ts`：`addColorBucket(hex)` / `deleteColorBucket(hex)`，`invoke("add_color_bucket", { rgb })` 等；失败按错误码映射到 i18n 提示。写后不请求任何 key，等事件。

## 点 5 — 色桶面板与接线（`components/gallery/ColorBucketPanel.vue`、`GalleryQueryBar.vue`）

- **新增**
  - `ColorBucketPanel.vue`：props `selected?: string`（当前排序的颜色）、`buckets`；emit `select(hex)`。面板只报「用户要按哪个颜色排序」，用哪个段由外面的 `colorSortFor` 定。
    - 色块网格（6 列，UnoCSS 工具类）：先 12 个基本色块，再用户保存的色块。每个色块一个圆角方块，`title` 是 `colorLabel`；当前排序的颜色带描边与对勾；白色等浅色块带细边框以免融进背景。
    - 用户保存的色块悬停时右上角出现删除角标，点它弹 `ElPopconfirm`（`popperClass` 挂进下拉的 `clickOutsideIgnore`，否则点确认会把下拉一起关掉——收藏视图的移除按钮是同样的处理）。基本色块没有删除角标。
    - 末尾「其它颜色」色块：当前排序的颜色不在色桶里时，它显示成那个颜色并带选中描边（让用户看得出现在按哪个颜色排）；否则是一个带「＋」的空块。点开后在网格下方内嵌 `ElColorPickerPanel`（不带透明度，初值为当前排序的颜色），下面一行说明 `colorAnyHint` 与两个按钮：
      - 「按这个颜色排序」：`emit("select", hex)`。
      - 「保存为色桶」：调 `addColorBucket(hex)`，期间按钮转圈、两个按钮都禁用（全库补算可能要几秒）；成功后 `emit("select", hex)`。取到的颜色已经是色桶时这个按钮置灰（提示 `colorBucketExists`），用户色桶到上限时同样置灰（`colorBucketLimit`）。

- **修改**（`GalleryQueryBar.vue`）

```ts
const { buckets: colorBuckets } = useColorBuckets();

const sortFieldItems = computed<KbFilterDropdownOption[]>(() =>
  props.sortFeatures.map((field) => ({
    label: gallerySortFieldLabel(field, t),
    value: field,
    ...(field === "by-color" ? { expandable: true } : {}),          // 新增
  })),
);

// 下拉里只有「颜色」一行，两个颜色字段都点亮它
const sortFieldModel = computed(() => (isColorSortField(sortField.value) ? "by-color" : sortField.value));   // 新增

function onSortColorSelect(hex: string, close: () => void) {        // 新增
  // 「保存为色桶」后立刻 select 时，事件可能还没把色桶列表刷回来，这里会先给出现算段；
  // 列表刷新后由点 6 的校正换成色桶段，两段顺序相同
  navigate({ sort: colorSortFor(hex, bucketHexes.value, props.sort.desc) });
  close();
}
```

```vue
<KbFilterDropdown ... :model-value="sortFieldModel" :click-outside-ignore="['.color-bucket-popconfirm']">
  <template #icon>...</template>
  <!-- 新增 -->
  <template #option-panel="{ option, close }">
    <ColorBucketPanel
      v-if="option.value === 'by-color'"
      :selected="isColorSortField(sort.field) ? sort.color : undefined"
      :buckets="colorBuckets"
      @select="(hex) => onSortColorSelect(hex, close)"
    />
  </template>
</KbFilterDropdown>
```

  - `sortFieldChipValue`（chip 的 tooltip）在颜色排序时写成「颜色 · 红」或「颜色 · #32fe98」。chip 图标仍是「排序双箭头 + 调色板徽章」，不把徽章换成色块：纯图标 chip 上一个小色点认不出是排序入口。
  - `sortFeatures`：画廊默认清单、`TaskDetail.vue`、`SurfImages.vue`、`Albums.vue` 四处各加 `"by-color"`（放在 `by-set-time` 之后、`random` 之前）；`by-any-color` 不进清单，`onSortFieldCommand` 等按清单校验的地方用 `isColorSortField` 把它当作 `by-color`。
  - 安卓：这颗下拉在紧凑档已是对话框承载（`kbFilterDropdownContextKey`，开合已接进返回栈），展开区与取色面板都在对话框主体里，不需要另外调 `useModalBack`。`ElPopconfirm` 是唯一的额外浮层，按现有 popconfirm 的用法处理。

## 点 6 — 校正排序段（`GalleryQueryBar.vue`）

- **新增**
  - 色桶列表已加载且当前是颜色排序时，用 `colorSortFor` 算出该用的字段；与当前字段不同就 `replace` 导航过去。写法与现有「按已卸载的插件过滤时清掉这一维度」那段 watch 并列。

```ts
watch([bucketHexes, colorBucketsLoaded, () => props.sort], () => {
  const sort = props.sort;
  if (!colorBucketsLoaded.value || !isColorSortField(sort.field) || !sort.color) return;
  const expected = colorSortFor(sort.color, bucketHexes.value, sort.desc);
  if (expected.field !== sort.field) navigate({ sort: expected }, { push: false });
});
```

  覆盖的情形：

| 情形 | 当前段 | 校正为 |
|---|---|---|
| 正按某个用户色桶排序，色桶被删（本页或别的页面删的） | `by-color` | `by-any-color`（否则结果是空集） |
| 正按某个现算颜色排序，用户把它保存成了色桶 | `by-any-color` | `by-color` |
| 应用一个收藏视图 / 打开一个链接，里面的段与现在的色桶列表对不上 | 任一 | 对应的另一个 |

  > 校正只改当前页面的路径，不回写收藏视图的记录。色桶列表还没加载完时不动（过期的 `by-color` 段会先显示空结果，列表到了再换）。

## 点 7 — 事件相关性（`services/kbEvents/imageViewRelevance.ts`）

- **修改**
  - 字段依赖表加 `palette`。回填会发 `palette` 补丁，而表外字段一律保守刷新——不登记的话，回填期间所有网格都会跟着每一批刷新。登记后只有按颜色排序的视图刷新，其余视图只把补丁打到已在手的行上。

```ts
const FIELD_DEPS: FieldDeps = {
  ...
  lastSetWallpaperAt: (v) => v.sort.field === "by-set-time",
  palette: (v) => isColorSortField(v.sort.field),               // 新增：两个颜色排序段都依赖色盘
  ...
};
```

  - 新增图片按完整行与查询判断，沿用现状（按颜色排序的视图在 `images-added` 时与其它排序同样刷新，后端保证此时关系行已写入）。`imageViewRelevance.test.ts` 补一条：`palette` 补丁只让颜色排序（`by-color` / `by-any-color`）的视图刷新。

## 点 8 — 基本信息里的代表色（`ImageBasicInfoPanel.vue`）

现状：面板只吃一个 `image`，类型 `ImageDetailLike` 是 `ImageInfo` 的子集，没有色盘；媒体属性是一行 chip。

```ts
// components/common/ImageBasicInfoPanel.vue:205 —— 现状
export type ImageDetailLike = {
  id?: string;
  ...
  size?: number;
  width?: number;
  height?: number;
  ...
};
```

- **新增**
  - `utils/palette.ts`：`parsePalette(text?: string | null): PaletteColor[]`，`PaletteColor = { rgb: number; hex: string; percent: number }`；不是合法的 `[[rgb, 百分比], …]` 时返回空数组。
  - 面板里媒体属性 chip 行的下方加一条色带：圆角、固定高度（约 10px），各段宽度按占比（`flex-grow: percent`，每段最小宽度 6px 保证小占比也看得见），段与段之间 1px 间隔；整条带一圈细边框，白色、黑色段不会融进面板背景。每段 `title` 为 `#rrggbb · 62%`。没有色盘（空数组）时整条不渲染，不占位。
  - i18n：`gallery.imageDetailPalette`（「代表色」），用作色带的 `aria-label`。

- **修改**
  - `types/image.ts` 的 `ImageInfo` 与面板的 `ImageDetailLike` 各加 `palette?: string | null`。
  - `utils/imageRow.ts`（查询行 → `ImageInfo` 的映射）带上 `palette`。

```vue
<!-- 新增：媒体属性 chip 行之后 -->
<div
  v-if="paletteColors.length"
  class="basic-info-palette"
  role="img"
  :aria-label="t('gallery.imageDetailPalette')"
>
  <span
    v-for="color in paletteColors"
    :key="color.rgb"
    class="basic-info-palette-seg"
    :style="{ flexGrow: color.percent, backgroundColor: `#${color.hex}` }"
    :title="`#${color.hex} · ${color.percent}%`"
  />
</div>
```

```ts
const paletteColors = computed(() => parsePalette(props.image?.palette));   // 新增
```

  - **点色段按该颜色排序**：每段是一颗按钮，点了发 `open-color-sort(hex)`，沿现有 `open-gallery-filter` 的同一条链路上传（`ImageDetailDialog` / `ImagePreviewDialog` → `ImageGridCore` → `ImageGrid`）。`ImageGrid.handleOpenColorSort` 调 `adapter.routeStore.navigate({ sort: { field: "by-any-color", desc: false, color: hex } }, { push: true })`，导航落定后关闭详情与预览。与过滤跳转的区别：过滤跳转会换掉查询、不在画廊时跳去画廊；这里只换排序，留在当前页面（四个网格页都有颜色排序）。色盘的颜色是聚合出的平均色，几乎不会恰好是色桶，所以直接给现算段、网格不为此读色桶表；恰好是色桶时由点 6 的校正换成预计算段。为此 `GridRouteStore.navigate` 的补丁类型从空对象放宽到 `Pick<GalleryQueryPatch, "sort">`。
  > 色带的样式跟面板里其它 `basic-info-*` 一样写在本组件（尺寸与间距用 UnoCSS 工具类即可，背景色是运行时值只能走内联样式）。
  > 面板在预览侧栏与详情弹窗里都用同一个组件，两处同时生效；回填的 `palette` 补丁经现有的 `imagePatches$` 打到网格行与预览对象上，开着的面板会自己补上色带，不需要面板自己观察任何 key。
