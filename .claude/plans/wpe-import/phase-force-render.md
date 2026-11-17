# 场景壁纸「强制渲染」设置

> 2026-11-17 用户提出。来由：预览 dino_run（不支持 `combo:SPRITESHEET`、`tex:animation`）时只能看到退回的封面与红字原因，
> 想「我就要看」。现在只有 dev 构建能靠 `localStorage["kabegame-dev-scene-force-render"]` 强制渲染。

## 总体设计思路

把强制渲染做成 WPE 设置字段组里的一项开关「强制渲染」，和后处理 / 反射 / 阴影 / 体积光同一套：桌面用全局设置键
`wpeSceneForceRender`（设置页「壁纸设置」），预览与应用背景用这张壁纸 metadata 里的 `previewSettings.forceRender`（预览右侧边栏），
默认关。它只对场景壁纸有意义，字段只在场景上显示。

开关的值跟着现有的场景设置消息走：`kabegame:wpe-scene-settings` 加一项 `forceRender`，桌面由壁纸窗口、预览由
`useWpePreviewPlayback` 算好，经 `Wallpaper` / `ImageContent` / `WpeWallpaperContent` 交到 `WpeSceneView`，再 postMessage 给宿主。
宿主把它当编译输入：和另外四项一样，变了就整场重新加载；加载时 `force` = 这个值，或 dev 的 `localStorage` 覆盖（保留，给
dev 工具与旧文档用）。有不支持项时，开了就照常渲染（渲染器自查仍生效，真画不出来照样退回），没开就照旧退回封面。

离用户最近的入口是报错条幅下方的「我就要看」按钮（用户定）：预览里场景显示不了、红字原因留在缩略图底部时，原因下面多一个按钮，
点了打开这张壁纸的强制渲染（写预览设置）。只在预览出现：桌面的点击落在桌面上、应用背景不交互，都点不到。预览的画布上盖着拦指针的
覆盖层（`WallpaperPointerOverlay`），按钮在画布里，覆盖层按点击位置找下面带 `data-wallpaper-clickable` 的元素转交点击。

预览弹窗顶部名称右边的警告色「强制渲染」只看设置（用户定：有了设置就知道该不该显示，不要宿主的事件）：这张是场景、预览设置里
开着强制渲染时显示，悬停说明画面可能有误、在右侧设置里关。

打开强制渲染一律先确认：设置页、预览侧栏、「我就要看」都经同一个 `confirmWpeForceRender()`（`messageBox.confirm`，警告样式），
提示画面可能缺东西、和 Wallpaper Engine 不一致或出错；取消就不写。关掉不确认。设置页与侧栏的确认放在纯视图的字段组
`WpeSettingsFields` 里拦 `update`，两个调用方都不用改。

关键决策：
- 开关进场景设置消息而不是新开一条消息：五项都是编译输入、变了都整场重载，宿主已有「首次加载等它、之后比较再重载」的逻辑，
  桌面与预览的值也已经各自算好往下传，加一个字段全链路自动通。
- 不加宿主到父页面的新消息：按钮与标题都从设置推得出来。按钮只在没开强制、失败原因不是超时 / 宿主不可用时出现（开了还失败的是
  真画不出来，强制也没用）。
- 不持久化「这张壁纸被强制过」之外的状态：开关就是设置本身，换图、重开预览都按设置来。

## 现状锚点

**a. 宿主的强制渲染只认 dev 的 `localStorage`**（`apps/wpe-scene/src/host.ts`）
```ts
const FORCE_RENDER_KEY = "kabegame-dev-scene-force-render";

function forceRender(): boolean {
  if (!__SCENE_DEV__) return false;            // 现状：生产构建恒为 false
  try {
    return localStorage.getItem(FORCE_RENDER_KEY) === "1";
  } catch {
    return false;
  }
}
// reload() 里：
      const force = forceRender();
      …
      if (bundle.unsupported.length) {
        if (!force) {
          this.fallbackAfterLoad(bundle.unsupported, compiledWith);   // 现状：退回封面，父页面只收到 fallback(reasons)
          return;
        }
        this.options.report.warn(`场景壁纸 ${this.options.imageId} 强制渲染（dev），不支持项：`, bundle.unsupported);
      }
```

**b. 场景设置消息四项**（`apps/wpe-scene/src/sceneStyle.ts`、`host.ts` 的 `setSceneSettings`）
```ts
    } else if (data?.type === SCENE_SETTINGS_MESSAGE) {
      handlers.settings({
        postprocess: data.postprocess,
        reflection: data.reflection,
        shadows: data.shadows,
        volumetrics: data.volumetrics,          // 现状：只有四项
      });
// setSceneSettings：和最近一次加载用的值比，四项有变化才整场重载
    if (resolved.volumetrics !== this.volumetrics) keys.push("volumetrics");
    if (!keys.length) return;
```

**c. 字段组是纯视图，改值统一经 `update` 报出去**（`components/wallpaper/WpeSettingsFields.vue`）
```vue
      <WpeSettingControl
        :setting-key="key"
        …
        @update="(k, v) => emit('update', k, v)"   <!-- 现状：直接转发，设置页写全局键、预览写这张的 previewSettings -->
      />
```

**d. 字段与默认值**（`utils/wpeSettings.ts`）
```ts
  if (isWpeSceneType(type))
    return ["paused", "volume", ...media, "fps", "postprocess", "reflection", "shadows", "volumetrics"];
…
export interface WpeSceneSettings {
  postprocess: string;
  reflection: string;
  shadows: string;
  volumetrics: string;                         // 现状：推给宿主的四项
}
```

**e. 逐壁纸预览设置的布尔项**（`src-tauri/kabegame-core/src/wpe/preview_settings.rs`）
```rust
const MEDIA_INTEGRATION: &str = "mediaIntegration";
const DEFAULT_MEDIA_INTEGRATION: bool = true;
fn normalize(key: &str, value: &Value) -> Result<Value, String> {
        MEDIA_INTEGRATION => value
            .as_bool()
            .map(Value::Bool)
            …
```

**f. 壁纸窗口的场景设置只有字符串四项**（`views/WallpaperWindow.vue`）
```ts
const SCENE_SETTING_KEYS = [
  ["wpeScenePostprocess", "postprocess"],
  ["wpeSceneReflection", "reflection"],
  ["wpeSceneShadows", "shadows"],
  ["wpeSceneVolumetrics", "volumetrics"],
] as const;
// setting-change 里只认字符串值：typeof changes[settingKey] === "string"
```

**g. 预览弹窗顶部只有名称与关闭**（`components/common/ImagePreviewDialog.vue`）
```vue
          <header class="flex h-12 shrink-0 items-center gap-3 …">
            <DialogTitle class="m-0 min-w-0 flex-1 truncate …">{{ previewDialogTitle }}</DialogTitle>
            <Tooltip :content="t('common.close')"> … </Tooltip>
          </header>
```

## 点 1 — 全局设置 `wpeSceneForceRender`（Rust）

- **新增**
  - `kabegame-core/src/settings/mod.rs`：`SettingKey::WpeSceneForceRender`（布尔，默认 `false`，键名 `wpeSceneForceRender`），
    `get_wpe_scene_force_render` / `set_wpe_scene_force_render`（写后发 `setting-change`），照 `WpeMediaIntegration`。
  - `kabegame/src/commands/settings.rs`：两个命令；`lib.rs` 注册。
```rust
#[tauri::command]
pub fn get_wpe_scene_force_render() -> bool {             // 新增
    Settings::global().get_wpe_scene_force_render()
}
/// 场景壁纸「强制渲染」：有不支持的特性也照常渲染。写设置并广播 `setting-change`，桌面壁纸窗口下发给场景宿主，宿主整场重新加载。
#[tauri::command]
pub fn set_wpe_scene_force_render(enabled: bool) -> Result<(), String> {   // 新增
    Settings::global().set_wpe_scene_force_render(enabled)
}
```

## 点 2 — 逐壁纸预览设置 `forceRender`（Rust）

- **新增**（`wpe/preview_settings.rs`）：`FORCE_RENDER = "forceRender"`、`DEFAULT_FORCE_RENDER = false`，`normalize` 收布尔、
  `default_of` 给默认（和默认值相同的不存，同其它键）；单测一例。
```rust
const FORCE_RENDER: &str = "forceRender";                 // 新增
const DEFAULT_FORCE_RENDER: bool = false;                 // 新增
        FORCE_RENDER => value.as_bool().map(Value::Bool).ok_or_else(|| …),   // 新增
        FORCE_RENDER => Value::Bool(DEFAULT_FORCE_RENDER),                   // 新增（default_of）
```

## 点 3 — 字段组加「强制渲染」（`utils/wpeSettings.ts`、`stores/settings*.ts`、`WpeWallpaperSettings.vue`）

- **修改**
  - `WpeSettingKey` 加 `"forceRender"`，`WpeSettingValues.forceRender: boolean`，默认 `false`，全局键 `wpeSceneForceRender`，
    标签 `settings.wpeSceneForceRender`；场景字段末尾加它；`wpePreviewSettingValues` 收布尔。
  - `WpeSceneSettings` 加 `forceRender: boolean`（`WPE_FOLLOW_SCENE_SETTINGS` 为 `false`），`wpeSceneSettingsOf` 带上。
  - `AppSettings.wpeSceneForceRender: boolean`，descriptor `tauri("wpeSceneForceRender", "get_wpe_scene_force_render", "set_wpe_scene_force_render", "enabled")`。
  - 设置页 `WpeWallpaperSettings` 的 `values` 读 `forceRender`。控件：布尔走开关（同媒体集成）。
```ts
  if (isWpeSceneType(type))
    return ["paused", "volume", ...media, "fps", "postprocess", "reflection", "shadows", "volumetrics", "forceRender"]; // 修改
…
export interface WpeSceneSettings {
  postprocess: string;
  reflection: string;
  shadows: string;
  volumetrics: string;
  /** 有不支持的特性也照常渲染（用户开了才为 true） */
  forceRender: boolean;                        // 新增
}
```

## 点 4 — 打开时统一确认（`utils/wpeForceRender.ts` 新增、`WpeSettingsFields.vue`）

- **新增** `confirmWpeForceRender(): Promise<boolean>`：`messageBox.confirm`（警告样式），文案见点 8；取消返回 false。
- **修改** `WpeSettingsFields`：`update` 先过一道，`forceRender` 由关变开时先确认，确认了才往外报；关掉直接报。设置页、预览侧栏都经它。
```ts
async function onUpdate(key: WpeSettingKey, value: boolean | number | string) {   // 新增
  // 打开强制渲染一律先确认（用户定）：设置页与预览侧栏共用这一处
  if (key === "forceRender" && value === true && !(await confirmWpeForceRender())) return;
  emit("update", key, value);
}
```

## 点 5 — 宿主收开关（`apps/wpe-scene/src/sceneStyle.ts`、`main.ts`、`host.ts`）

- **修改**
  - 场景设置消息多一项 `forceRender`（只认 `true`，其余当 false）；`setSceneSettings` 比较它，变了整场重载（原因 `settings`，key `forceRender`）。
  - `reload` 里 `const force = this.forceRender || forceRender()`（dev 覆盖保留）；warn 文案按来源写（设置 / dev）。
```ts
      const force = this.forceRenderSetting || forceRender();   // 修改：用户设置或 dev 覆盖
      …
      if (bundle.unsupported.length) {
        if (!force) { this.fallbackAfterLoad(bundle.unsupported, compiledWith); return; }
        this.options.report.warn(`场景壁纸 ${this.options.imageId} 强制渲染，不支持项：`, bundle.unsupported);
      }
```

## 点 6 — 应用页传开关（`wpeSceneStyle.ts`、壁纸窗口）

- **修改**
  - `wpeSceneStyle.ts`：设置消息带 `forceRender`（测试照旧读宿主源码比对字面量）。
  - `WallpaperWindow`：场景设置多一项布尔，启动时 `get_wpe_scene_force_render`，`setting-change` 认布尔值。
  - 预览与应用背景经 `useWpePreviewPlayback` → `wpeSceneSettingsOf` 自动带上。

## 点 7 — 「我就要看」按钮（`WpeLoadingOverlay`、`ImageContent`、`WallpaperPointerOverlay`、`ImagePreviewDialog`）

- **新增**
  - `WpeLoadingOverlay`：可选 `action`（按钮文字），`bottom` 那块原因下面画一个链接文字「我就要看」（用户定：不做成按钮；`pointer-events-auto`、`data-wallpaper-clickable`），
    点了 emit `action`。
  - `ImageContent`：prop `offerForceRender`（只有预览给 true）；场景、红字原因在底部、`playback.sceneSettings.forceRender` 为假、原因
    不是 `render:timeout` / `host:unavailable` 时给覆盖层 `action`，点了 emit `wallpaperForceRender`。
  - `WallpaperPointerOverlay`：左键按下时按 `document.elementsFromPoint` 找带 `data-wallpaper-clickable` 的元素，有就不平移、松开在同一个
    元素上时 `click()` 它；悬停时光标为手形。
  - `ImagePreviewDialog`：收 `wallpaperForceRender` → `confirmWpeForceRender()` → 写这张壁纸的预览设置 `forceRender: true`。
```vue
          <WpeLoadingOverlay v-if="wallpaperFailureCaption" … placement="bottom"
            :action="forceRenderOffered ? t('gallery.wpeForceRenderAction') : undefined"
            @action="emit('wallpaperForceRender')" />   <!-- 新增 -->
```

## 点 7b — 预览标题的警告（`ImagePreviewDialog.vue`）

- **新增** 名称右边：这张是场景、预览设置 `forceRender` 为真时，警告色标记「强制渲染」（`TriangleAlert`），悬停说明画面可能有误、
  在右侧设置里关。只看设置，不看宿主。
```vue
            <DialogTitle class="… min-w-0 flex-1 truncate …">{{ previewDialogTitle }}</DialogTitle>
            <!-- 新增：开着强制渲染的场景，名称右边警告色标记 -->
            <Tooltip v-if="previewForceRender" :content="t('gallery.wpeForceRenderTitleTip')"> … </Tooltip>
```

## 点 8 — 文案（五种语言）

- 设置项：「强制渲染」，说明「有暂不支持的特性也照常渲染，画面可能缺东西或和 Wallpaper Engine 不一致」。
- 确认框：标题「打开强制渲染？」，正文「这张壁纸用到了 Kabegame 暂不支持的特性。强制渲染会跳过它们，画面可能缺失、错位或和
  Wallpaper Engine 不一致，严重时可能卡顿。确定打开吗？」，按钮「打开」「取消」。
- 标题：按钮「强制渲染」、标记「强制渲染中」、悬停「跳过了这些暂不支持的特性：…」。

## 验证

- Rust：`preview_settings` 单测；`cargo check`（经 `deno task check -c kabegame`，dev 占用时只看能跑的部分）。
- 宿主：`sceneStyle.test.ts`（消息解析）、`host.test.ts`（开关变了重载、强制时照常渲染并报 `forced`、没开时退回并报）。
- 应用：`wpeSettings.test.ts`、`WpeSettingsFields` 确认拦截（确认 / 取消 / 关掉不确认）、`WpeSceneView`、`WpeWallpaperContent`、
  `ImageContent.wallpaper`、`WallpaperWindow.target`、预览标题的标记；相关 vitest、vue-tsc、Prettier；变异检查。
- 真机（要重启 dev，Rust 有改动）：预览 dino_run，标题出现「强制渲染」→ 确认 → 画面渲染出来、标题变「强制渲染中」；侧栏开关同步；
  设置页打开桌面的强制渲染弹确认；关掉回到封面与红字。
- 文档：`WPE_SCENE.md`「dev 强制渲染（D4）」改写、`WPE_IMPORT.md` 设置字段组、`cocs/README.md`；回归一节；changelog 一行。

## 已定（用户 2026-11-17）

1. 「我就要看」按钮要做，离用户最近（点 7）；预览里覆盖层转交点击。
2. 不要宿主的事件：标题的警告与按钮都按设置显示（点 7、7b）。

## 实施记录（2026-11-17）

- 按点 1–8 落地；「我就要看」的文字由 `WpeLoadingOverlay` 自己出（`offerForceRender` 布尔），`ImageContent` 不引 i18n（很多测试挂它时没装 i18n）。
- 验证见回归「场景壁纸「强制渲染」设置」FR1；FR2–FR6 要重启 dev 后由用户在真机上看。
- 应用 crate 的 cargo check 在 dev 运行时跑不了（`cef-dll-sys` 拷 DLL 被占用），重启 dev 时一起编。
