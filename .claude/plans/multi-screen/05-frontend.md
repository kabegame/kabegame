# 05 · 前端：设置页与其它入口

## 总体设计思路

设置页的壁纸分区分成三层：**全局**（打开壁纸、壁纸模式、显示器模式、轮播开关与间隔、音量 / 倍速 / 暂停、WPE 设置）→ **布局图与目标选择** → **目标设置**（轮播路径、当前壁纸、样式、过渡）。目标设置的每一行都绑定「当前选中的目标」，选中目标是页面本地状态（`localStorage` 记住，默认 = 默认目标），不进设置。

前端读目标统一经一个 composable `useWallpaperTarget(targetId?)`：它从 `settingsStore.values.wallpaperTargets` 取配置，按能力表算出当前壁纸模式下的有效样式 / 过渡，写操作调已有命令并带 `target`。

**设置页以外凡是要落到某个目标的操作，都先经同一个目标选择弹窗**：图库与预览的「设为壁纸」、画册「设为轮播」、查询栏「用当前视图轮播」、收藏视图的轮播。弹窗里是和设置页同一个显示器布局组件，用户点一块屏、确定。只有一个活跃目标时（`multiple`、`span`，或 `single` 但只接一块屏）不弹，直接用那个目标——所以单屏用户和不用 single 的用户完全感觉不到它。入口是一个命令式函数 `pickWallpaperTarget()`，写法照已有的 `askSettingChoice` + `SettingChoiceHost`（`composables/useSettingChoice.ts`）：模块级的待处理请求 + 挂在 `App.vue` 的宿主组件，调用方 `await` 结果。

不需要用户选的地方仍用默认目标：应用背景、切壁纸模式引导里的兜底换图。

能力表 `useWallpaperCapabilities` 跟随后端结构改成 `displayModes[mode]`；所有选项的禁用与原因都从这里来，组件里不写平台判断。

## 现状锚点

**a. 设置描述符是扁平键**（`stores/settingsDescriptors.ts:172`）
```ts
tauri("wallpaperRotationEnabled", "get_wallpaper_rotation_enabled", "set_wallpaper_rotation_enabled", "enabled"),
tauri("wallpaperRotationPath", "get_wallpaper_rotation_path", "set_wallpaper_rotation_path", "path"),
tauri("wallpaperStyle", "get_wallpaper_rotation_style", "set_wallpaper_style", "style"),
tauri("wallpaperRotationTransition", "get_wallpaper_rotation_transition", "set_wallpaper_rotation_transition", …),
tauri("wallpaperStyleByMode", …), tauri("wallpaperTransitionByMode", …),
tauri("currentWallpaperImageId", "get_current_wallpaper_image_id", "set_current_wallpaper_image_id"),
```

**b. 能力只按壁纸模式**（`composables/useWallpaperCapabilities.ts`）
```ts
export interface WallpaperCapabilities {
  modes: WallpaperOption[];
  styles: Record<string, WallpaperOption[]>;       // 现状：mode → options
  transitions: Record<string, WallpaperOption[]>;
}
```

**c. 样式 / 过渡组件绑定扁平键**（`components/settings/items/WallpaperStyleSetting.vue`）
```ts
const { settingValue, disabled, set } = useSettingKeyState("wallpaperStyle");
const options = computed(() => capabilities.stylesFor(mode.value).map(…));
```

**d. 其它读扁平键的地方**
```text
App.vue:413                         应用背景：settingsStore.values.currentWallpaperImageId
components/ImageGrid.vue:345        当前壁纸标记
composables/useImageOperations.ts   设为壁纸 / 删图时清当前壁纸 / 设画册为轮播
components/imageGrid/adapters/album.ts:33  画册内删图清当前壁纸
utils/wallpaperMode.ts:65           切模式引导后 save("currentWallpaperImageId")
views/Albums.vue:598,614            设为轮播、当前轮播画册
components/albums/AlbumTreeView.vue:365, actions/albumActions.ts:198, AlbumContextMenu.vue:33  轮播画册标记
services/albums.ts:326              删画册时比对轮播路径
components/gallery/GalleryQueryBar.vue:389,398   用当前视图轮播
components/gallery/savedViews/SavedViewsSection.vue:280  收藏视图的轮播标记
composables/useSettingKeyState.ts:42-51         埋点分组表
views/Settings.vue:182-310          壁纸分区
```

**e. 已有的命令式弹窗写法**（`composables/useSettingChoice.ts` + `components/common/SettingChoiceHost.vue`，宿主在 `App.vue:179`）
```ts
const currentChoice = shallowRef<PendingSettingChoice | null>(null);     // 现状：模块级当前请求
export function askSettingChoice(req): Promise<SettingChoiceResult | null> { … }   // 调用方 await
export function resolveSettingChoice(value) { … }                         // 宿主组件在选择 / 关闭时调用
```

---

## 点 1 — 能力与目标 composable

- **修改** `useWallpaperCapabilities.ts`
```ts
export interface DisplayModeCapability {
  value: "multiple" | "span" | "single";
  label: Record<string, string>; desc: Record<string, string>;
  unavailable: Record<string, string> | null;
  styles: WallpaperOption[]; transitions: WallpaperOption[];
  sharedStyle: boolean;
}
export interface WallpaperCapabilities {
  modes: WallpaperOption[];
  displayModes: Record<string, DisplayModeCapability[]>;   // 修改：取代 styles / transitions
}
// 新增
const displayModesFor = (mode: string) => displayModes.value[mode] ?? [];
const comboFor = (mode: string, display: string) => displayModesFor(mode).find((d) => d.value === display);
```

- **新增** `composables/useWallpaperTarget.ts`
```ts
/** targetId 缺省 = 默认目标（由 wallpaperDisplayMode / wallpaperDefaultScreen / 在线屏算出，与后端 layout 同规则）。 */
export function useWallpaperTarget(targetId?: MaybeRef<string | null | undefined>) {
  const id = computed(() => unref(targetId) ?? defaultTargetId.value);
  const config = computed(() => settingsStore.values.wallpaperTargets?.[id.value] ?? null);
  const style = computed(() => effective(config.value?.style, combo.value?.styles));
  const transition = computed(() => effective(config.value?.transition, combo.value?.transitions));
  return {
    id, config, style, transition,
    currentImageId: computed(() => config.value?.currentImageId ?? null),
    setRotationPath: (p: string) => invoke("set_wallpaper_rotation_path", { path: p, target: id.value }),
    setStyle: (s: string) => invoke("set_wallpaper_style", { style: s, target: id.value }),
    setTransition: (t: string) => invoke("set_wallpaper_rotation_transition", { transition: t, target: id.value }),
    setWallpaper: (imageId: string) => invoke("set_wallpaper_by_image_id", { imageId, target: id.value }),
  };
}
/** 当前显示器模式下的活跃目标 id（与后端 layout 同规则：在线屏 × 显示器模式），默认目标在前。 */
export function useActiveWallpaperTargets(): ComputedRef<string[]>;
/** 所有活跃目标的当前壁纸 id（网格标记用）。 */
export function useActiveWallpaperImageIds(): ComputedRef<Set<string>>;
```
  - 轮播开关与间隔是全局键，继续用 `useSettingKeyState("wallpaperRotationEnabled" / "wallpaperRotationIntervalMinutes")`，不经这个 composable。
  > 说明：写入不走 `settingsStore.save` 的乐观更新；后端写库后发 `setting-change { wallpaperTargets }`，store 照常落地。保存中状态由各设置项自己持有。

- **修改** `settingsDescriptors.ts`：删 7 个扁平条目（含 readonly 的 web 版条目；`wallpaperRotationEnabled`、`wallpaperRotationIntervalMinutes` 保留不动），新增 `wallpaperTargets`（getter `get_wallpaper_targets`，无 setter）、`wallpaperDisplayMode`（setter `set_wallpaper_display_mode`）、`wallpaperDefaultScreen`（setter `set_wallpaper_default_screen`）。`stores/settings.ts` 的类型同步；`useSettingKeyState.ts` 埋点分组表同步。

## 点 2 — 设置页壁纸分区（`views/Settings.vue`）

- **修改** 布局（自上而下）
```text
打开壁纸
壁纸模式            [原生 | 窗口]                    ← 从分区底部移上来：它决定下面哪些显示器模式可选
显示器模式          [各屏复制 | 跨屏拼接 | 逐屏独立]  ← 不可用项置灰，悬停显示 unavailable 原因
轮播 / 间隔                                          ← 全局：一开全开，所有目标同一个节拍
┌ 显示器布局图 ───────────────────────────────┐
│  ┌──────┐┌────────────┐                      │  single：每块可点，选中高亮，默认屏带「默认」角标
│  │  2   ││     1 ★    │                      │  multiple：所有块同色，点任一块都选中唯一目标
│  └──────┘└────────────┘                      │  span（Windows / GNOME 原生）：外接矩形描边，块之间连成一片
│  已断开：DELL U2720Q（忘记）                   │  只在 single 下显示断开屏
└──────────────────────────────────────────────┘
目标：显示器 2 · 2560×1440   [设为默认]          ← single 才有「设为默认」
  轮播路径 / 当前壁纸 / 样式 / 过渡               ← 绑定选中目标
  （sharedStyle 时样式行说明「该平台所有显示器共用」；span 下样式只有一项、只读，说明「由系统铺放」）
暂停 / 音量 / 倍速 / WPE …                       ← 全局
```
- **新增** `components/settings/items/WallpaperDisplayModeSetting.vue`（`KbSegmentedControl`，同 `WallpaperModeSetting`；切换中禁用，失败回滚）。
- **新增** `components/wallpaper/WallpaperScreenLayout.vue`（设置页与目标选择弹窗共用，所以不放在 `settings/` 下）：纯展示 + 选择，`v-model:selected`（目标 id），入参 `displayMode`、`defaultScreen`、`showDisconnected`；屏幕列表自己取（`list_wallpaper_screens`，监听 `wallpaper-screens-change` 重读）；算并集外接矩形 → 平移到原点 → 等比缩进容器；竖屏自然画成高块；每块显示序号、名字、分辨率，默认屏带角标。样式用 UnoCSS。只有一块屏时仍画，附一行「只有一块显示器，三种模式效果相同」。
- **修改** `WallpaperStyleSetting.vue` / `WallpaperTransitionSetting.vue`：加 `targetId` prop，改用 `useWallpaperTarget`，选项来自 `comboFor(mode, displayMode)`。过渡组件里「当前值不在选项里就纠正」的逻辑删除（归一化在后端读取时做，不写回）。
- **修改** 轮播路径、当前壁纸（含 WPE 属性按钮、封面）两行改读选中目标。
- `WallpaperRotationEnabledSetting.vue` 与间隔行不改（全局键），只是在布局里上移到全局层。
- Android：不显示壁纸模式之外的新控件（`displayModes` 只有 multiple 时整组隐藏）；web 只读版不显示。

## 点 3 — 目标选择弹窗

- **新增** `composables/useWallpaperTargetPicker.ts`
```ts
export interface WallpaperTargetPickRequest {
  /** 弹窗标题里的动作名：设为壁纸 / 设为轮播 */
  action: "setWallpaper" | "setRotation";
}
const current = shallowRef<{ request: WallpaperTargetPickRequest; resolve: (id: string | null) => void } | null>(null);
export const wallpaperTargetPickRequest = computed(() => current.value?.request ?? null);

/** 返回目标 id；用户取消返回 null。只有一个活跃目标时不弹，直接返回它。 */
export async function pickWallpaperTarget(request: WallpaperTargetPickRequest): Promise<string | null> {
  const targets = activeWallpaperTargets();            // 与 useActiveWallpaperTargets 同一份计算
  if (targets.length <= 1) return targets[0] ?? null;  // multiple / span / 单屏：不弹
  if (current.value) current.value.resolve(null);      // 同时只有一个，后来的顶掉前一个
  return new Promise((resolve) => { current.value = { request, resolve }; });
}
export function resolveWallpaperTargetPick(id: string | null) { … }   // 宿主调用
```
- **新增** `components/wallpaper/WallpaperTargetPickerHost.vue`（挂在 `App.vue`，紧挨 `SettingChoiceHost`）：`ElDialog` 里放 `WallpaperScreenLayout`（`displayMode="single"`、不显示断开屏），预选默认屏；点一块屏选中，「确定」/ 双击屏块 / 回车返回，「取消」/ 关闭返回 `null`。调用 `useModalBack`（AGENTS.md 要求所有覆盖层都调，桌面为空操作）。打开期间屏幕变化：被选中的屏断开时预选回到默认屏；在线屏只剩一块时直接以它返回。
  > 说明：弹窗只选目标，不带「记住选择」。默认屏的作用是预选，以及给不弹窗的入口（应用背景、CLI / MCP 缺省、托盘取不到光标时）兜底。

## 点 4 — 其它入口

| 入口 | 改为 |
|---|---|
| 图库 / 预览「设为壁纸」（`useImageOperations`） | `const id = await pickWallpaperTarget({ action: "setWallpaper" }); if (!id) return;` → `set_wallpaper_by_image_id({ imageId, target: id })` |
| 设为轮播画册（`Albums.vue:598`、`albumActions.ts:198`、`AlbumContextMenu`） | 先 `pickWallpaperTarget({ action: "setRotation" })`，再 `set_wallpaper_rotation_path({ path, target })`；顺带打开轮播开关的现有行为不变（开关是全局的）。成功提示带屏名（多目标时） |
| 用当前视图轮播（`GalleryQueryBar.vue:389`）、收藏视图轮播（`SavedViewsSection.vue`） | 同上 |
| 轮播来源标记（`AlbumTreeView`、`albumActions`、`AlbumContextMenu`、`SavedViewsSection`、查询栏 ↻） | 轮播开着且任一活跃目标的路径命中即标记 |
| 删画册（`services/albums.ts:326`） | 后端已按所有目标处理（02 点 6），前端删掉本地比对，等事件 |
| 网格当前壁纸标记（`ImageGrid.vue:345`、`adapters/album.ts:33`） | `useActiveWallpaperImageIds()`；删图时不再本地清空，等后端事件 |
| 应用背景（`App.vue:413`） | 默认目标的当前壁纸，不弹窗 |
| 切模式引导（`utils/wallpaperMode.ts:65`） | `set_wallpaper_by_image_id`（默认目标）替代直接 save，不弹窗 |
| 托盘「下一张」 | 后端按光标所在屏处理（02 点 6），前端无改动 |

## 点 5 — i18n

`packages/kabegame-i18n/src/locales/{zh,zhtw,en,ja,ko}/settings.json` 新增：`displayMode`、`displayModeDesc`、`displayModeMultiple(Desc)`、`displayModeSpan(Desc)`、`displayModeSingle(Desc)`、各不可用原因（`displayModeUnsupported`、`displayModeSingleGnome`、`displayModeSpanWindow`、`displayModeSpanNoSystem`、`displayModeLater`）、`screenDefault`、`screenSetDefault`、`screenDisconnected`、`screenForget`、`screenOnlyOne`、`styleSharedAcrossScreens`、`styleSpanBySystem`、`pickTargetTitleSetWallpaper`、`pickTargetTitleSetRotation`；后端 `i18n_map` 用的键同一批。
