# Phase 2 — 壁纸窗口 Vue 化：同 `index.html` + `WallpaperStage` 组件

> 状态：方案（2026-10-26）。上级：[PLAN.md](PLAN.md)。
>
> 范围：只重构壁纸窗口的前端形态，**不改**壁纸的任何业务行为（样式 / 过渡 / 音量 / 倍速 / 轮播 / 挂载 / ready 握手 /
> 看门狗语义全部保持），不引入 Web 壁纸。图库侧的预览接入（`ImageContent` 切换、桌面画布）只对 `x-wpe/web` /
> `x-wpe/scene` 生效，Phase 2 没有这类行可验证，所以**留到 Phase 3 与 Web 导入一起做**；本文件末尾把接入点定义好，
> 让 `WallpaperStage` 现在就按「可被嵌入」设计。**WPE 视频不走壁纸组件**：预览与应用背景继续用普通视频链路
> （`compatible_path` + `<video>` + `VideoControls`），保留 seek 能力。

## 总体设计思路

壁纸窗口今天是一个独立入口：`wallpaper.html` 内联全部 CSS，`wallpaper.ts` 用 `getElementById` 直接操作 base / top
两层 `<img>` / `<video>` / tile 元素，自己拼过渡状态机，自己经 IPC 拉设置与当前壁纸。它跟主界面没有任何共享：
没有 Vue、没有 Pinia、没有组件库、没有 UnoCSS。要让图库预览「内嵌一个壁纸本体」，就得把这套渲染逻辑变成一个可以
在任何 Vue 页面里挂的组件。

重构后壁纸窗口与主窗口**加载同一个 `index.html`**，URL 带 `?window=wallpaper`。`main.ts` 变成一个极小的分发器：
按 `window` 查询参数动态导入两套 bootstrap——主界面那套就是今天的 `main.ts` 全部内容；壁纸那套只装 Pinia、i18n、
UnoCSS 与主题变量，根组件是新的 `WallpaperWindow.vue`，不装 router、组件库和 vant。两个窗口因此共用一个 Vite 入口、
一套 alias / define / chunk 策略，`wallpaper.html` 与 rollup 的多入口配置一并删除；而壁纸窗口的 JS 体积不增加，因为
两套 bootstrap 是分开的动态 chunk。

渲染被拆成两层。**`WallpaperStage.vue`** 是纯渲染组件：输入是「要显示什么」（`WallpaperTarget`）和「怎么显示」
（样式模式、过渡、音量、倍速），内部持有 base / top 双层与 prep → enter → commit 的过渡状态机、tile 平铺、WPE 视频
的作者属性样式，这些全部从 `wallpaper.ts` 原样搬过来，只是把 `getElementById` 换成模板 ref、把内联 style 操作换成
响应式 class / style 绑定。它不知道自己在哪个窗口、不碰 IPC、不读设置 store，所以预览弹窗可以直接 `import` 它。
**`WallpaperWindow.vue`** 是壁纸窗口的根：负责今天 `init()` 里的一切——看门狗、`setting-change` 监听、启动时五个 getter、
`wallpaper_window_ready` 握手、dev 调试面板——然后把结果作为 props 喂给 `WallpaperStage`。数据流方向不变：后端仍是
唯一属主，壁纸窗口仍是「自驱动」的观察方。

预览内嵌因此不需要 iframe 嵌 `wallpaper.html`，也不需要同源桥。接入点放在 **`ImageContent`**（Phase 3 实现）：
它仍是图库里所有媒体的统一出口，缩略图 → 原图的降级链条、丢失态都归它；只有当一个 **非视频的** `x-wpe/*` 行
（`x-wpe/web`、`x-wpe/scene`）要以「原图形态」显示（预览大图、应用背景）时，`ImageContent` 切换为渲染
`WpeWallpaperContent`——一个薄的数据绑定层，按 `image.id` 经新命令 `get_wallpaper_target_for_image` 取目标、从
`settingsStore` 取样式 / 过渡 / 音量 / 倍速，再交给 `WallpaperStage`。`WallpaperStage` 自身没有缩略图降级链条，所以它
不替代 `ImageContent`，而是被 `ImageContent` 在 WPE 分支里使用。网格缩略图（`prefer="thumbnail"`）不受影响，仍是作者的
`preview.*`。**`x-wpe/video` 除外**：它在图库里就是一个视频，继续走 `ImageContent` 的 `<video>` 链（`compatible_path`），
这样预览的 `VideoControls`、seek、双击播放暂停全部照旧；只有桌面壁纸窗口用 `WallpaperStage` 播它。

`ImagePreviewDialog` 对非视频 WPE 行只多做一层布局：把 `ImageContent` 放进一个按主显示器逻辑分辨率定尺寸、再整体
`transform: scale()` 到弹窗可用区域的「桌面画布」里，用户看到的就是设到桌面上的样子；画布接收鼠标事件，为 Web 壁纸
的交互留好了位置。应用背景层本来就铺满窗口，不需要这层缩放，直接受益于 `ImageContent` 的切换。Web / Scene 的渲染从此
只在 `WallpaperStage` 里实现一次，Video 的壁纸形态也在那里。

关键决策与理由：
- **用查询参数而不是路由区分窗口**：`?window=wallpaper` 在 dev（vite 直接服务 `index.html`）和 prod（Tauri asset
  协议按路径取 `index.html`，忽略 query）都不需要 SPA 回退；`surf-navbar.html?host=…` 已是同样的传参方式。路由方案要么
  让 `App.vue` 带着侧栏、插件加载、文件拖入等全部启动逻辑一起进壁纸窗口，要么到处加 `if (isWallpaperWindow)`，两者都不如
  在 `main.ts` 分叉干净。
- **`WallpaperStage` 不替代 `ImageContent`，而是被它在 WPE 分支里使用**：`ImageContent` 的职责是缩略 → 原图流式覆盖
  与丢失态，`WallpaperStage` 没有这条降级链，只有壁纸渲染（双层过渡、tile、逐壁纸的 WPE 样式与音量 / 倍速）。
  所以接入点是「`ImageContent` 渲染 `x-wpe` 的原图形态时切到它」，而不是让调用方绕开 `ImageContent`。
- **`WallpaperStage` 不读设置、不发 IPC**：数据绑定由 `WpeWallpaperContent`（图库侧）和 `WallpaperWindow`（壁纸窗口侧）
  各自负责，`WallpaperStage` 在两边都是同一个纯组件。
- **壁纸窗口的数据来源保持直连 IPC**：这次只搬代码不改数据流。`settingsStore.loadAll()` 会拉全部设置，对壁纸窗口过重；
  若 settings 架构已有单键读取（`refresh(key)`）可以用它替代五个 getter，但 `setting-change` 的处理语义必须与现状一致。
- **WPE 视频在图库里按普通视频对待**：预览与应用背景不切到壁纸组件，`VideoControls` / seek 保留；只有桌面窗口用
  `WallpaperStage` 播它。壁纸组件接管的只有没有「单文件媒体」形态的类型（web / scene）。

## 现状锚点

**a. 壁纸窗口是独立 HTML 入口，Rust 直接加载它**（`src-tauri/kabegame/src/wallpaper/manager/window.rs:59`）
```rust
        // 独立的 wallpaper.html，只渲染壁纸层。
        let builder = WebviewWindowBuilder::new(
            &self.app,
            WALLPAPER_LABEL,
            WebviewUrl::App("wallpaper.html".into()),   // 现状：独立入口
        )
```

**b. Vite 为它单开一个 rollup 入口**（`apps/kabegame/vite.config.ts:30`）
```ts
  // web mode: no wallpaper window, chunking always on
  const hasWallpaper = !isWeb && (isWindows || isMacOS);
  const hasSurfNavbar = !isWeb;
  const rollupInput = {
    ...(hasWallpaper && { wallpaper: "./wallpaper.html" }),   // 现状：第二入口
    ...(hasSurfNavbar && { "surf-navbar": "./surf-navbar.html" }),
  };
```

**c. 页面是内联 CSS + 裸 DOM**（`apps/kabegame/wallpaper.html:156`）
```html
    <div id="app">
      <div class="wallpaper-root">
        <div class="wallpaper-stage">
          <img id="base-img" class="wallpaper-img base" alt="wallpaper-base" />
          <img id="top-img" class="wallpaper-img top" alt="wallpaper-top" />
          <video id="base-video" class="wallpaper-img base" style="display: none" autoplay muted loop playsinline></video>
          <video id="top-video" class="wallpaper-img top" style="display: none" autoplay muted loop playsinline></video>
          <div id="base-tile" class="wallpaper-tile base" style="display: none"></div>
          <div id="top-tile" class="wallpaper-tile top" style="display: none"></div>
        </div>
        <div id="debug-panel" class="debug-panel" style="display: none"></div>
      </div>
    </div>
    <script type="module" src="/src/wallpaper.ts"></script>   <!-- 现状：独立脚本，无 Vue -->
```
`.top.fade.enter` / `.top.slide.prep` / `.top.zoom.enter` 等过渡类与 `.debug-panel` 样式都内联在 `<head>` 里。

**d. 渲染状态与 IPC 混在一个模块里**（`apps/kabegame/src/wallpaper.ts:41`、`:849`、`:988`）
```ts
let baseSrc = ""; let topSrc = ""; let baseVideoSrc = ""; let topVideoSrc = "";
let phase: Phase = "idle";                 // 现状：过渡状态机是模块级变量
let currentTarget: WallpaperTarget | null = null;
let pendingTarget: WallpaperTarget | null = null;
let queuedTarget: WallpaperTarget | null = null;
let busy = false;
let mode: Mode = "fill"; let transition: Transition = "fade";
let wallpaperVolume = 1; let wallpaperPlaybackRate = 1;
// ...
let baseImgEl: HTMLImageElement | null = null;   // 现状：initDOM() 里 getElementById 取到
// ...
async function init() {
  armInitWatchdog();                        // 现状：看门狗、setting-change、五个 getter、ready 握手全在这里
  initDOM();
  // ...
  unlistenSettingChange = await listen("setting-change", async (event) => { /* 改 mode / transition / 目标 / 音量 / 倍速 */ });
  const [styleRes, transitionRes, volumeRes, playbackRateRes, targetRes] = await Promise.all([
    invoke<string>("get_wallpaper_rotation_style"),
    invoke<string>("get_wallpaper_rotation_transition"),
    invoke<number>("get_wallpaper_volume"),
    invoke<number>("get_wallpaper_video_playback_rate"),
    invoke<WallpaperTarget | null>("get_current_wallpaper_target"),
  ]);
  // ...
  await invoke("wallpaper_window_ready");
}
```
`setTarget()`（`:610`）是整套双层过渡逻辑：去重 → 串行 → 视频 / 图片分支 → 首帧直设 base 或 top prep → 两帧 rAF →
enter → `transitionend` 或 1400ms 兜底 `commitTopToBase()`。WPE 视频的 `effectiveAlignment` / `getVideoStyle` /
`wpeVideoFilter` / `applyWpeStageStyles`（`:201`–`:322`）把作者属性换算成 `object-fit` / `object-position` /
`transform` / `filter` / 背景色。

**e. 主入口把所有东西装进一个根**（`apps/kabegame/src/main.ts:1`、`:52`）
```ts
import App from "./App.vue";
import router from "./router";
// ... element-plus / vant / uno / 主题 / 指令
const app = createApp(App);              // 现状：唯一的根，App.vue 的 onMounted 会加载插件、文件拖入、各服务
app.use(pinia); app.use(i18n); app.use(router); app.use(ElementPlus); /* vant ... */
app.mount("#app");
```

**f. 预览弹窗对 WPE 视频走普通视频分支**（`apps/kabegame/src/components/common/ImagePreviewDialog.vue:319`、`:506`）
```vue
          <div v-if="previewImage && isPreviewVideo" class="preview-video-wrapper">
            <ImageContent ref="previewContentRef" :image="previewImage" prefer="original" video-playing video-loop @ready="handlePreviewReady" />
            <VideoControls :video="previewVideoEl" :show-play-pause="true" :is-fullscreen="isAppFullscreen" @toggle-fullscreen="toggleAppFullscreen" />
          </div>
```
```ts
const isPreviewVideo = computed(() => isVideoPlaybackType(previewImage.value?.type)); // 现状：x-wpe/video 也算视频
```

**g. 当前壁纸目标只能按「当前设置」取**（`src-tauri/kabegame/src/commands/wallpaper.rs:48`）
```rust
pub async fn get_current_wallpaper_target_from_settings() -> Result<Option<WallpaperTarget>, String> {
    let Some(id) = Settings::global().get_current_wallpaper_image_id() else { return Ok(None) };
    let img = Storage::find_image_by_id(&id)?;              // 现状：取行 + 读 project.json + 组装，全在一个函数里
    // ... wpe_video = read_project(dir) → resolve_video_props
    Ok(Some(WallpaperTarget { id, path: info.local_path, media_type: info.media_type, compatible_path: info.compatible_path, wpe_video }))
}
```

**h. ACL 与能力**（`src-tauri/kabegame/capabilities/main.json:5`、`permissions/main.toml:155`）
```json
  "windows": ["wallpaper", "main"],     // 现状：壁纸窗口 label 不变，仍被 main-capability 覆盖
```
```toml
  "get_current_wallpaper_target",       // 现状：没有按 id 取目标的命令
```

---

## 点 1 — Rust：壁纸窗口改加载 `index.html?window=wallpaper`（`wallpaper/manager/window.rs`）
- **修改**
  - `create_window` 的 URL 改为 `index.html?window=wallpaper`；label、标题、全屏、无边框、透明、`visible(false)`、
    挂载与 ready 流程全部不变。
```rust
        // 与主窗口同一个 index.html，前端 main.ts 按 ?window= 分发到壁纸 bootstrap。
        let builder = WebviewWindowBuilder::new(
            &self.app,
            WALLPAPER_LABEL,
            WebviewUrl::App("index.html?window=wallpaper".into()),   // 修改
        )
```
- **不做**
  - 不改 `WallpaperWindow::mark_ready / wait_ready / reset_ready`，不改 `wallpaper_window_ready` 命令。

## 点 2 — Rust：抽出壁纸目标组装（`commands/wallpaper.rs`）
- **新增**
  - `build_wallpaper_target(info: ImageInfo) -> WallpaperTarget`：从现有函数抽出「读 `project.json` → `resolve_video_props`
    → 组装」这一段；`get_current_wallpaper_target_from_settings` 改为取 id → 取行 → 调它。行为不变，只为 Phase 3 的
    按 id 命令铺路（命令本身在 Phase 3 加，见文末）。
```rust
/// 新增：由图片行组装壁纸目标（当前壁纸与预览内嵌共用）。
async fn build_wallpaper_target(info: ImageInfo) -> WallpaperTarget {
    let wpe_video = if is_wpe_video_type(info.media_type.as_deref()) {
        let dir = PathBuf::from(&info.local_path);
        tokio::task::spawn_blocking(move || read_project(&dir)).await.ok().and_then(Result::ok)
            .map(|project| resolve_video_props(&project))
    } else { None };
    WallpaperTarget { id: info.id, path: info.local_path, media_type: info.media_type, compatible_path: info.compatible_path, wpe_video }
}
```

## 点 3 — 前端入口分发（`apps/kabegame/src/main.ts`、新增 `bootstrap/`）
- **新增**
  - `src/bootstrap/app.ts`：今天 `main.ts` 的全部内容原样搬入（包括 Ctrl+Shift+R 重载、Android class、指令、图标注册、
    pinia / i18n / router / ElementPlus / vant、`app.mount("#app")`）。
  - `src/bootstrap/wallpaper.ts`：只装 pinia、i18n、`virtual:uno.css`、`@/styles/anime-theme.css`，根组件
    `WallpaperWindow.vue`，`app.mount("#app")`。不装 router、ElementPlus、vant、header features、crawler guard。
  - `src/windowKind.ts`：`export const WINDOW_KIND = new URLSearchParams(location.search).get("window") === "wallpaper" ? "wallpaper" : "main"`。
- **修改**
  - `main.ts` 只剩分发：
```ts
import { WINDOW_KIND } from "./windowKind";
// 两套 bootstrap 用动态导入，保证壁纸窗口不会把主界面的组件库 / vant / 路由打进自己的 chunk。
if (WINDOW_KIND === "wallpaper") {
  void import("./bootstrap/wallpaper");
} else {
  void import("./bootstrap/app");
}
```
- **删除**
  - `apps/kabegame/wallpaper.html`、`apps/kabegame/src/wallpaper.ts`。
  - `vite.config.ts` 的 `hasWallpaper` 与 `rollupInput.wallpaper`（`surf-navbar` 入口保留）。
```ts
  const hasSurfNavbar = !isWeb;
  const rollupInput = {
    ...(hasSurfNavbar && { "surf-navbar": "./surf-navbar.html" }),   // 修改：只剩导航栏入口
  };
```
- **说明**
  - Web 发布版 / Android 永远不会以 `?window=wallpaper` 打开，`bootstrap/wallpaper.ts` 对它们只是一个不会被请求的 chunk；
    如需硬门控，在 `windowKind.ts` 里对 `IS_WEB || IS_ANDROID` 强制 `"main"`。

## 点 4 — `WallpaperStage.vue`：纯渲染组件（新增 `components/wallpaper/WallpaperStage.vue`、`components/wallpaper/types.ts`）
- **新增**
  - `types.ts`：把 `wallpaper.ts` 顶部的 `WallpaperTarget` / `WpeVideoProps` / `Mode` / `Transition` 类型搬出来导出，
    `ImagePreviewDialog` 与 `WallpaperWindow` 共用。
  - 组件 props / emits / expose：
```ts
interface Props {
  target: WallpaperTarget | null;                      // 要显示什么；null 清空
  styleMode: Mode;                                     // fill / fit / stretch / center / tile
  transition: Transition;                              // none / fade / slide / zoom
  volume: number;                                      // 0…1
  playbackRate: number;                                // 0.25…3（负值仍表示倒放语义，与现状 getPlaybackRateMagnitude 一致）
  paused?: boolean;                                    // 新增能力：true 时暂停视频（应用背景不可见、预览关闭时用），默认 false
  interactive?: boolean;                               // 预览内嵌为 true：容器接收指针事件；桌面默认 false
}
const emit = defineEmits<{ error: [message: string]; ready: [] }>();
defineExpose({ debugState });                          // 给 dev 调试面板读 phase / 当前路径 / 最近错误
```
  - 模板即现状 `wallpaper.html` 的 `.wallpaper-stage` 子树：`baseImg` / `topImg` / `baseVideo` / `topVideo` / `baseTile` /
    `topTile` 六个模板 ref；过渡类与 tile / img 基础样式从 `wallpaper.html` 搬进 `<style>`（非 scoped 或用 `:deep`，
    保证 `.top.fade.enter` 这类组合类照常生效）。
  - 逻辑按原函数一对一搬：`setTarget` → `watch(() => props.target, …)` 触发；`applyStyles` / `getImgStyle` /
    `getVideoStyle` / `getBaseTileStyle` / `getTopTileStyle` / `getTopClasses` / `commitTopToBase` /
    `handleTopTransitionEnd` / `handleImageError`（含 base 图重试）/ `playVideo` / `unmuteVideo` /
    `applyWallpaperVolume` / `applyWallpaperPlaybackRate` / `applyVideoLoopMode` / `effectiveAlignment` /
    `wpeVideoFilter` / `applyWpeStageStyles` / `prefetchTarget`；`mode` / `transition` / 音量 / 倍速改为 `watch` props。
    `getVideoUrl` / `getImageUrl` 继续用 `fileToUrl` / `compatibleToUrl`，并在首次使用前 `await initHttpServerBaseUrl()`。
  - 去重键、严格串行（`busy` / `queuedTarget`）、两帧 rAF、1400ms 兜底、`transitionGuardTimer` 清理、`onBeforeUnmount`
    里的 `cleanup()` 全部保留。
- **不做**
  - 不读 `settingsStore`、不 `invoke`、不 `listen`；不处理看门狗与 ready 握手。

## 点 5 — `WallpaperWindow.vue`：壁纸窗口根（新增 `views/WallpaperWindow.vue`）
- **新增**
  - 模板：`<div class="wallpaper-root"><WallpaperStage ref="stage" v-bind="state" /> <div v-if="IS_DEV" class="debug-panel">…</div></div>`，
    `html / body / #app` 透明与 100% 尺寸的全局样式从 `wallpaper.html` 搬到本组件的非 scoped `<style>`。
  - `setup`：现状 `init()` 的全部内容——`armInitWatchdog()`（`sessionStorage` 的 `wallpaperInitRetry` 与 reload 语义不变）、
    `getCurrentWebviewWindow().label`、`listen("setting-change")`（`wallpaperStyle` / `wallpaperRotationTransition` /
    `currentWallpaperImageId` → `get_current_wallpaper_target` / `wallpaperVolume` / `wallpaperVideoPlaybackRate`）、启动时
    五个 getter 并行、`invoke("wallpaper_window_ready")`、`initDone` 与清零重试计数、`onBeforeUnmount` 释放监听。
    `updateDebugPanel` 改为从 `stage.value?.debugState()` 读。
  - 响应式状态 `state = reactive({ target, styleMode, transition, volume, playbackRate })` 直接作为 `WallpaperStage` 的 props。
- **说明**
  - 若 settings 架构已提供单键读取（见 `cocs/settings/SETTINGS_BACKENDS.md` 的 `refresh(key)`），可用它替代四个 getter；
    否则保持 `invoke`。不得调用 `settingsStore.loadAll()`。

## 点 6 — 文档、技能与回归
- **修改**
  - `cocs/wpe/WPE_IMPORT.md` 第六节「壁纸窗口」：说明壁纸窗口现为 `index.html?window=wallpaper` + `WallpaperWindow.vue` +
    `WallpaperStage.vue`；第八节「涉及文件」更新。
  - `cocs/wallpaper/WINDOW_MOUNT_WEMT.md`、`AGENTS.md`、`apps/docs` 中凡提到 `wallpaper.html` / `wallpaper.ts` 的地方同步
    （先 grep）。
  - `.claude/skills/kabegame-chromium/SKILL.md`「选窗口」一节的 targets 示例：壁纸窗口 URL 改为
    `http://localhost:1420/index.html?window=wallpaper`；`isMainWindow()` 的「路径不以 `.html` 结尾」启发式仍然成立，
    `--url wallpaper` 仍可匹配。
  - `versions/latest/regression.md`：新增「壁纸窗口 Vue 化」一节——图片 / 视频 / tile 显示、四种过渡、五种样式、音量与倍速
    实时生效、切换壁纸、WPE 视频的作者属性（对齐 / 翻转 / 背景色 / 滤镜）仍生效、关闭再开启窗口模式（窗口重建 +
    ready 握手）、看门狗重载、dev 调试面板、主窗口功能不受入口分发影响（启动、路由、Ctrl+Shift+R）。
  - `versions/latest/changelog.md` 补一行。

## 验收
- `deno task check -c kabegame`（用 `check-kabegame` 技能）通过。
- 真机（用户已在跑 dev；Rust 改动后 dev 会自己重建，**不要 sleep 轮询**，连不上就记为未验证）：
  - `kabegame-chromium` 的 `targets` 能看到 `index.html?window=wallpaper`，`shot --url wallpaper` 有壁纸，默认截图仍是主窗口；
  - 在设置里切样式 / 过渡 / 音量 / 倍速，壁纸窗口立即变化；设一张普通图、一个普通视频、WPE 视频 12091 各一次；
  - 关闭窗口模式再开启，壁纸窗口重建并显示；
  - 图库里 WPE 视频的预览仍是普通视频预览（有 `VideoControls`、可 seek），与重构前一致。
- `git status` 不得出现本方案以外的改动；不提交。

---

## 留给 Phase 3 的接入点（本 Phase 不实现，只约束 `WallpaperStage` 的设计）

Phase 3 导入 `x-wpe/web` 后，图库侧按下面三点接入；`WallpaperStage` 在 Phase 2 就要满足：props 驱动、不读 store、
不发 IPC、支持 `paused` / `interactive`、可在非全屏容器里铺满父元素。

### 3-a — Rust：按 id 取壁纸目标（`commands/wallpaper.rs`、`lib.rs`、`permissions/main.toml`）
- 命令 `get_wallpaper_target_for_image(image_id: String) -> Option<WallpaperTarget>`，复用点 2 的 `build_wallpaper_target`；
  `lib.rs` 注册；`permissions/main.toml` 的 `commands.allow` 加 `"get_wallpaper_target_for_image"`。
```rust
#[tauri::command]
pub async fn get_wallpaper_target_for_image(image_id: String) -> Result<Option<WallpaperTarget>, String> {
    let Some(info) = Storage::find_image_by_id(&image_id).map_err(|e| format!("Storage error: {}", e))? else { return Ok(None) };
    Ok(Some(build_wallpaper_target(info).await))
}
```

### 3-b — `ImageContent` 的非视频 WPE 分支切到壁纸组件（新增 `components/wallpaper/WpeWallpaperContent.vue`，修改 `image/ImageContent.vue`）
- **新增**
  - `WpeWallpaperContent.vue`，props `{ image: ImageInfo; playing?: boolean; muted?: boolean; interactive?: boolean }`，
    emits `ready` / `error`：
    - 目标：`invoke("get_wallpaper_target_for_image", { imageId: image.id })`；`image.id` 或 `image.compatiblePath` 变化重取；
      行不存在或失败 emit `error`。
    - 设置：`styleMode` / `transition` / `volume` / `playbackRate` 来自 `useSettingsStore().values`
      （`wallpaperStyle` / `wallpaperRotationTransition` / `wallpaperVolume` / `wallpaperVideoPlaybackRate`），响应式跟随；
      `muted` 时 `volume` 传 0；`playing === false` 时 `paused` 传 true。
    - 渲染 `<WallpaperStage>` 铺满自身，透传 `interactive`；`ready` / `error` 向上转发。
- **修改**（`ImageContent.vue`）
  - 现状的 `mode` 对 WPE 视频行在 `prefer === "thumbnail" && hasWpePreview` 时为 `image`，否则为 `video`——**这一支不变**。
    新增：非视频 WPE 行（web / scene）在缩略图形态仍为 `image`（作者 `preview.*`），原图形态为新值 `"wallpaper"`，
    模板里渲染 `<WpeWallpaperContent :image="image" :playing="videoPlaying" :muted="videoMuted" @ready="…" @error="…" />`。
  - `expose` 的 `videoEl` 在 `wallpaper` 模式下为 `null`（调用方据此不挂 `VideoControls`）。
  - 缩略图链、原图链、丢失态、`failedSources` 等对其它形态不变。
```ts
const mode = computed<"image" | "gif" | "video" | "wallpaper">(() => {
  if (isWpe.value && !isWpeVideo.value) {
    return props.prefer === "thumbnail" ? "image" : "wallpaper"; // 新增：web / scene 的原图形态交给壁纸组件
  }
  if (isWpeVideo.value) return props.prefer === "thumbnail" && hasWpePreview.value ? "image" : "video"; // 不变
  if (!isVideo.value) return "image";
  return IS_ANDROID && props.prefer === "thumbnail" ? "gif" : "video";
});
```
- **说明**
  - `App.vue` 的应用背景层用的就是 `ImageContent prefer="original"`，因此非视频 WPE 背景自动改为 `WallpaperStage` 渲染，
    `video-muted` / `video-playing` 经上面的映射生效；`reset-video-on-pause` 对该分支忽略。WPE 视频背景照旧。

### 3-c — 预览弹窗的「桌面画布」（新增 `components/wallpaper/WallpaperDesktopCanvas.vue`，修改 `ImagePreviewDialog.vue`）
- **新增**
  - `WallpaperDesktopCanvas.vue`：纯布局，默认插槽放内容。
    - 桌面尺寸：`primaryMonitor()`（`@tauri-apps/api/window`）的 `size / scaleFactor` 得逻辑像素；取不到回退
      `window.screen.width / height`。
    - 外层按桌面宽高比 `contain` 进可用区域（`ResizeObserver` 量容器）；内层固定为桌面逻辑尺寸，
      `transform: scale(k)`、`transform-origin: 0 0`，插槽内容铺满内层；指针事件放行。
    - 可选角标：右下角小字「桌面预览 · W×H」（i18n key `gallery.wpeDesktopPreview`，五种语言），不遮挡内容。
- **修改**（`ImagePreviewDialog.vue`）
  - 新增 `isPreviewWallpaper = computed(() => isWpeType(type) && !isWpeVideoType(type))`；`isPreviewVideo` 保持
    `isVideoPlaybackType(type)`（WPE 视频仍是视频预览）。
  - 模板：在图片 / 视频两个 wrapper 之前加
    `<div v-if="previewImage && isPreviewWallpaper" class="preview-wallpaper-wrapper"><WallpaperDesktopCanvas><ImageContent :image="previewImage" prefer="original" video-playing interactive @ready="handlePreviewReady" /></WallpaperDesktopCanvas></div>`，
    不渲染 `VideoControls`；`PreviewControlBar`（含全屏）照常。`ImageContent` 需新增可选 prop `interactive`
    透传给 `WpeWallpaperContent`（默认 false）。
  - `desktopVideoActive`（音频保活）改为 `isPreviewVideo || isPreviewWallpaper`；Panzoom、双击播放 / 暂停、滚轮缩放等
    对 `isPreviewWallpaper` 一律跳过（与现在对视频的跳过同一处判断）。
  - `getOriginalPreviewUrl` 的 `isWpeVideoType` 分支保留（WPE 视频仍由它取 `compatible_path`）。
- **说明**
  - 预览里的 `WallpaperStage` 首次显示走的是空 → 目标的首帧直设分支，不会闪过渡。
