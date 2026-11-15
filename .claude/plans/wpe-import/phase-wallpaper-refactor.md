# 壁纸显示重构：Wallpaper > ImageContent[]，WPE 显示归 WpeWallpaperContent（含场景加载进度）

> 状态：2026-11-15 用户批准（待定 1–6 全按建议）。取代 `phase-scene-loading-progress.md`（那份的宿主上报与进度换算并入本计划
> 步骤 2，UI 部分按本计划改）。前置条件见「前置」。

## 总体设计思路

现在桌面壁纸窗口和图库是两套显示：桌面用 `WallpaperStage`（2027 行），它自己管图片 / 视频的双层与过渡、平铺、WPE 视频属性、
网页 iframe、场景宿主；图库预览与应用背景用 `ImageContent`，它的 wallpaper 形态再套一个 `WallpaperStage`。两者在图片 / 视频
加载、失败回退、播放控制上大面积重叠，而 WPE 的网页与场景显示又埋在 Stage 里，图库只能隔着 Stage 用。

重构后只有一条显示路径，三层各管一件事：

```
Wallpaper（原 WallpaperStage，改名）        —— 只管「铺放」与「过渡」
  └─ 每个壁纸一层：样式包装 + ImageContent    —— 新旧两层按 transition 交接
       └─ ImageContent                        —— 一张图片行的媒体：缩略层 / 原图层 / 视频 / wallpaper 形态
            └─ wallpaper 形态：缩略层打底 + 加载进度 + WpeWallpaperContent（当「原图」）
                 └─ WpeWallpaperContent       —— WPE 网页 iframe 或 WpeSceneView，二选一
                      └─ WpeSceneView         —— 场景宿主 iframe
```

- **`Wallpaper`** 不再认识媒体类型：每换一次目标挂一个新的 `ImageContent`（包在样式包装里），等它 `ready` 再按 `transition` 淡入 /
  滑入 / 缩放，过渡结束卸载旧的（旧的 `<video>`、iframe、场景宿主随卸载释放）。样式是包装层的事：fill / fit / stretch / center 换算成
  `ImageContent` 的 `fit`（object-fit 的 cover / contain / fill / none），tile 由包装层用 `ImageContent` 交出的当前图源画重复背景；
  WPE 网页、场景的样式原样往下传（场景由宿主按样式铺放、留白用 `schemecolor`）。过渡期间来了新目标，就替换「正在进来的那一层」，不排队。
- **`ImageContent`** 是一张图片行的全部显示：缩略 / 原图回退链、视频播放（音量 0–1、先静音播放再恢复音量、倍速、循环、暂停）、
  WPE 视频的作者属性（翻转、位移、颜色、留边色），以及 wallpaper 形态。桌面、图库预览、应用背景都用它；桌面不显示骨架、丢失图、
  不允许拖出（新增 `variant="wallpaper"`）。
- **wallpaper 形态 = 缩略层打底 + WPE 壁纸当原图**（用户定）：下面是缩略图（作者 `preview.*` 或自定义封面），一打开就能看；上面是
  `WpeWallpaperContent`，实时画面出来（场景首帧、网页 load）才揭开。加载期间缩略图上叠细进度条与阶段文字，所有地方都显示（预览、应用
  背景、桌面）；加载态至少 300 ms。场景不能渲染（编译相关的失败、30 s 超时）就当「原图加载失败」，走图片一样的回退链：缩略图留着当
  最终画面，缩略图也坏了才进丢失态。运行时脚本出错等不算失败、不回退。
- **`WpeWallpaperContent`** 是专门显示 WPE 壁纸的组件：网页壁纸的 iframe（创建 / 销毁、load 判定、音量协议、右键、指针、ping 委托，从
  Stage 搬来）或 `WpeSceneView`。它不读任何设置，全部由参数给（音量、倍速、暂停、样式、场景三项、可交互）；场景 30 s 没有结果就上报
  超时失败并卸载宿主（用户定）。它向上报：进度、实时、失败（原因）、致命错误、右键；并暴露 `delegatesPing()`。

数据来源：桌面壁纸窗口仍由后端给 `WallpaperTarget`（`build_wallpaper_target`），用一个适配函数换成 `ImageContent` 要的图片行形状
（`id / type / localPath = path / compatiblePath / thumbnailPath = previewPath`），WPE 部分（`wpeVideo / webEntry / sceneAssets`）作为
附加参数一起下传，不再在 `WpeWallpaperContent` 里自己取目标（图库没有目标时仍按图片 id 取）。播放参数（音量、倍速、暂停、场景三项）
桌面传全局「壁纸设置」，图库传这张壁纸的「预览设置」，由调用方算好、作为一个参数对象下传，`ImageContent` 与 `WpeWallpaperContent`
都不读 store。

## 前置

- 另一个会话正在改 `WallpaperStage.vue` / `WpeSceneView.vue` / `WallpaperPreviewCanvas.vue`（预览缩放、指针覆盖层），步骤 1 要把 Stage
  掏空，**等它提交再开工**。
- 本会话上一节「壁纸设置与预览设置」还没提交，也碰了这几个文件，**先提交它**（待用户批准）。

## 现状锚点

**a. 消费关系**
```vue
<!-- WallpaperWindow.vue：桌面直接用 Stage，不听 ready / error -->
<WallpaperStage ref="stage" :target="state.target" :style-mode="state.styleMode" :transition="state.transition"
  :volume="stageVolume" :playback-rate="state.playbackRate" :paused="stagePaused" :scene-settings="stageSceneSettings" interactive />
<!-- ImageContent.vue：wallpaper 形态 → WpeWallpaperContent → 又一个 WallpaperStage -->
<WpeWallpaperContent v-else-if="mode === 'wallpaper'" :image="image" :fit="fit" :playing="videoPlaying" :muted="videoMuted" ... />
```

**b. Stage 的样式与过渡**（`WallpaperStage.vue`）
```ts
// 现状：styleMode → 图片 object-fit；tile 是背景图 div；视频 tile 当 cover；WPE 视频的 transform / filter / 背景写在整个 stage 上
function getImgStyle() { /* fill→cover, fit→contain, stretch→fill, center→none, tile→{} */ }
const el = topImgEl || topTileEl;   // 现状 bug：tile 永远拿不到过渡类，1400 ms 兜底后硬切
```

**c. 场景层**（`WallpaperStage.vue`）
```ts
// 现状：loading → live / fallback；退回或 10 s 超时才加载 previewPath；超时不卸载 WpeSceneView
const SCENE_RESULT_TIMEOUT_MS = 10_000;
```

**d. `ImageContent` 的 wallpaper 形态**（`ImageContent.vue`）
```ts
// 现状：wallpaper 形态没有缩略链，加载期间只有骨架（浅灰 + 图标脉动）
if (mode.value === "wallpaper") return [];
```

## 步骤 1 — `WpeWallpaperContent` 独立成 WPE 显示组件（桌面仍经 Stage，可独立验收）

> 2026-11-15 实施时调整：图库不再经 Stage 之后，场景退回时没人显示预览图，所以把步骤 3 的「缩略层打底、失败当原图失败、
> 实时画面满 300 ms 才揭开、`wallpaperLive` 取代 `sceneLive`」并进本步；步骤 3 只剩进度覆盖层（依赖步骤 2 的上报）。

- **修改** `WpeWallpaperContent.vue`：吃参数不吃 store；可选 `target`（不给时按 `imageId` 取）；内含网页 iframe（从 Stage 搬
  `createWebFrame` / `teardownWeb` / load 判定 / 8 s 超时 / 音量协议 / 右键 / 指针）与 `WpeSceneView`；场景结果超时 30 s（新常量），
  到点上报 `fail(["render:timeout"])` 并卸载宿主；事件 `live` / `fail(reasons)` / `error(fatal)` / `contextmenu`，`defineExpose({ delegatesPing })`。
  网页导航被拦（没带补丁 05、被改写成 about:blank#blocked、没有入口）报 `fail`；导航了但 8 s 没 load 照旧当实时画面（只记 warn）。
- **修改** `WallpaperStage.vue`：网页层与场景层改成挂一个 `WpeWallpaperContent`，删掉搬走的代码与 Stage 自己的 10 s 场景超时；
  对外行为基本不变（桌面照旧），差别：场景超时 10 s → 30 s 且超时后宿主卸载（迟到的首帧不再切回实时）；网页 `fail` 时放弃切入、
  保留上一张（原来是淡入一张空白页）。
- **修改** `ImageContent.vue` 的 wallpaper 形态（原步骤 3 的一部分）：缩略层打底（`buildChain` 不再对 wallpaper 返回空）；
  `WpeWallpaperContent` 叠在上面、满 300 ms 且 `live` 才揭开；`fail` 当原图失败（缩略层是最终画面，缩略也死才丢失）；
  Android / Web 不挂实时层；`ready` 在缩略层加载完或揭开时发（每张一次）；`wallpaperLive(boolean)` 取代 `sceneLive`。
- **修改** 图库调用方：预览设置的读取挪到调用方（新增 `useWpePreviewPlayback`，`ImagePreviewDialog` / `App.vue` 经 `ImageContent`
  的 `playback`（`WallpaperPlayback { volume, sceneSettings }`）下传；暂停仍是 `videoPlaying`、静音仍是 `videoMuted`）；预览的
  `previewRendering` 改看 `wallpaperLive`。
- 测试：`WallpaperStage.webVolume.test.ts` / `scene.test.ts` 里网页、场景的用例挪到 `WpeWallpaperContent` 的测试，Stage 只留过渡与图片 / 视频
  （及它对 `WpeWallpaperContent` 事件的反应）；`ImageContent` 补 wallpaper 形态的用例。

## 步骤 2 — 场景加载进度（宿主上报 → 应用页）

同 `phase-scene-loading-progress.md` 点 1、点 2：宿主按 `page / compile / decode / gpu / frame` 上报（postMessage
`kabegame:wpe-scene-progress`，Worker 协议加 `progress`，只在首次加载报），`WpeSceneView` 收、`WpeWallpaperContent` 转发；应用页
`wpeSceneProgress.ts` 按权重换算、单调、宿主阻塞时缓慢逼近。超时改成「30 s 内**没有新进度**才判超时」还是「从挂载算 30 s」见待定 4。
「开始渲染」日志加分阶段用时（见待定 5）。

## 步骤 3 — `ImageContent` 的 wallpaper 形态双层 + 进度 UI（图库预览、应用背景生效）

> 缩略层、揭开、失败回退与 `wallpaperLive` 已在步骤 1 做完，本步只剩进度覆盖层。

- **修改** `buildChain`：wallpaper 形态走缩略链（排除目录本身）。
- **修改** 模板：缩略层 `z-1` + 壁纸层 `z-2`（揭开前 `opacity: 0`）+ 进度覆盖层（细进度条 + 阶段文字，i18n 五种语言；网页只有
  「加载中」与不确定进度条），从挂上就显示，至少 300 ms。
- **新增** `wallpaperState`：`loading` → `live`（实时且满 300 ms：揭开、覆盖层淡出）/ `failed`（当原图失败：壁纸层隐藏，缩略层是
  最终画面；缩略链也死 → 丢失态）。
- **修改** emit：`ready` 在缩略层加载完发（同图片）；新增 `wallpaperLive(boolean)`（取代 `sceneLive`，网页也走它），预览弹窗的
  `previewRendering` 改看它。

## 步骤 4 — `ImageContent` 补齐桌面要的能力

- **新增** `variant="wallpaper"`：不显示骨架与丢失图、不允许拖出、视频 `autoplay muted`，进度覆盖层照显示。
- **修改** `fit`：`"contain" | "cover" | "fill" | "none"`；**新增** expose `displaySource()`（当前图源与固有尺寸，给 tile 用）。
- **新增** 播放参数对象（`volume` 0–1、`playbackRate`、`paused`、`sceneSettings`、`style`）：视频「先静音 play、成功后恢复音量」、倍速
  钳 0.25–3；wallpaper 形态原样下传。
- **新增** WPE 视频作者属性（翻转、位移、颜色 filter、留边色）作用在本层自己的 `<video>` 上（见待定 3）。
- **修改** `ready` 每个图片行只发一次。

## 步骤 5 — `Wallpaper` 取代 `WallpaperStage`

- **新增** `components/wallpaper/Wallpaper.vue`：层列表（当前 + 正在进来的）；每层 = 样式包装 + `ImageContent variant="wallpaper"`；
  新层 `ready` 后加过渡类，`transitionend`（兜底 1400 ms）后卸载旧层；进来的层在 ready 前报错就放弃、保留旧层；过渡中来了新目标替换
  进来的那层。样式包装：fill / fit / stretch / center → `fit`；tile → 图片用 `displaySource()` 画重复背景、视频按 cover、WPE 原样下传
  （见待定 2）。expose `debugState()`、`delegatesPing()`（转问当前层）。
- **修改** `WallpaperWindow.vue`：用 `Wallpaper`，目标经适配函数变成图片行形状；ping 委托、调试面板、看门狗照旧。
- **删除** `WallpaperStage.vue` 与 `targetKind.ts` 里只给它用的部分；两份 Stage 测试改写成 `Wallpaper` 的过渡 / 交接测试。
- **文档**：`AGENTS.md` 一处、`cocs/README.md` 7 处、`WPE_IMPORT.md` 27 处（顺手修已过时的 `isShowingWeb()`、「暂停时网页层
  `visibility: hidden`」、「场景 ping 仍由应用页应答」）、`WPE_SCENE.md` 9 处（「接入 WallpaperStage（scene 层）」整节）、
  `MULTI_SCREEN.md` / `TAURI_ACL_PERMISSION_SYSTEM.md` / `I18N_MIGRATION.md` 各一处；Rust 与 `wpe-scene` 里提到 Stage 的注释、
  `p3a-missing.test.ts` 的测试名。

## 已定（2026-11-15 用户）

- 桌面也用 `ImageContent`；样式在它外面包；`WallpaperStage` 改名 `Wallpaper`，结构 `Wallpaper > ImageContent[]`，按 style 装、按
  transition 交接；WPE 显示是 `WpeWallpaperContent > WpeSceneView`。
- 加载底图用缩略图，同图片「原图出来前缩略图能看」；进度与加载态由 `ImageContent` 按 `WpeWallpaperContent` 的事件管；进度条下有
  阶段文字，所有地方都显示；加载态至少 300 ms。
- 超时 30 s，放在 `WpeWallpaperContent` / `WpeSceneView`，超时上报失败、不再挂着宿主；上报的失败只和编译有关（不支持、编译失败、
  渲染器建不起来），运行时脚本出错等不回退缩略图。

## 已定（续，2026-11-15 用户「可以」）

1. 场景 → 场景：新层挂上就开始过渡，旧场景过渡后卸载，期间两个宿主短暂并存。
2. 平铺：图片画重复背景；视频按 cover；网页壁纸忽略样式铺满；场景交给宿主。
3. WPE 视频的作者属性放进 `ImageContent`，预览与应用背景也生效。
4. 超时按「30 s 内没有新的进度」算（每条进度重置计时）。
5. 「开始渲染」日志加分阶段用时。
6. 编译类退回（不支持、编译失败）留着宿主，只有超时卸载。

## 验证

- 每步独立验收：`git status`、`deno task check -c kabegame`、`apps/wpe-scene` tsc、相关 vitest（只跑相关文件）、Prettier。
- 步骤 1：Stage 的网页 / 场景用例迁到 `WpeWallpaperContent` 后全过；桌面换网页、场景、图片、视频壁纸行为不变（真机）。
- 步骤 2：屏外宿主收一次加载的全部进度消息，核对顺序、单调、最后一条是 `frame`；大场景看各段用时。
- 步骤 3–5：预览、应用背景、桌面各换一遍图片 / 视频 / 网页 / 场景 / 不能渲染的场景，看缩略图打底、进度、揭开、回退与过渡（桌面与预览的
  观感由用户看）；fill / fit / stretch / center / tile 与 none / fade / slide / zoom 组合；WPE 视频属性；多屏两个窗口各自交接。
