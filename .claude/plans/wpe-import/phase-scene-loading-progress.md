# 场景壁纸加载进度

> 状态：已并入 `phase-wallpaper-refactor.md`（2026-11-15），本文件只留宿主上报与进度换算的细节（点 1、点 2）；UI 部分以那份为准。

## 总体设计思路

图库预览打开一张场景壁纸时，从挂上宿主到首帧出来要 0.3–2 s（大场景、粒子预热、视频首帧更久，超过 10 s 按退回显示预览图），这期间
画面只有 `ImageContent` 的骨架（浅灰底 + 图标脉动），用户不知道是在加载还是卡住了。

**壁纸当「原图」，缩略图打底**（用户定）：`ImageContent` 的 wallpaper 形态照图片的双层做——下面是缩略层（`thumbnail_path`：作者
`preview.*` 或自定义封面，网格里已经加载过），一打开就看得见；上面是 `WpeWallpaperContent`，相当于原图层，实时画面出来才揭开。
进度与加载状态由 `ImageContent` 管，依据是 `WpeWallpaperContent` 上报的事件（进度、实时、退回、致命错误）；场景不能渲染（退回）就
当作「原图加载失败」，走和图片一样的回退链：缩略层留着当最终画面，缩略图也坏了才进丢失态。`WallpaperStage` 自己「退回才加载
预览图」的逻辑只留给桌面（壁纸窗口没有 `ImageContent`），图库一侧关掉。加载态**至少 300 ms**：实时画面再快也等满 300 ms 才揭开，
避免缩略图一闪就被换掉。

进度：让场景宿主按阶段**上报**进度，应用页**画**进度：宿主 iframe 在出首帧之前整层 `opacity: 0`（`WallpaperStage` 的场景层），画在
里面看不见，所以 UI 只能在应用页；宿主只给数据。进度条下面显示阶段文字（用户定）。

数据流：宿主（`SceneHost.reload` 与它调的编译 / 解码 / 建 GPU 场景）→ postMessage `kabegame:wpe-scene-progress` → `WpeSceneView`
（核对来源是自己的 iframe，同右键、快捷方式那几条）→ `WallpaperStage` → `WpeWallpaperContent` → `ImageContent` 的加载覆盖层。
不走 `wpe_scene_report`：那条要过 Rust、每条一次 IPC、还要改 ACL；进度只给同一页面里的父组件，postMessage 足够，也不受 Rust 侧忙闲影响。

进度按**阶段 + 阶段内计数**给，总百分比由应用页按固定权重换算（一处常量，宿主不关心权重）：

| 阶段 | 宿主何时报 | 阶段内计数 | 权重（暂定） |
| --- | --- | --- | --- |
| `page` 宿主启动、拉属性、等设置 | 应用页挂上 iframe 到收到第一条消息 | 无（应用页自己的不确定动画） | 5 |
| `compile` Worker 编译 | 读完 scene.json 起 | 已处理对象 / 总对象，按「1 + 该对象的 effect 数」加权（读完 scene.json 就知道） | 45 |
| `decode` 解 PNG / JPG | Worker 结束后 | 已解 mip / 总 mip（开解前全知道；有缓存时瞬间完成） | 15 |
| `gpu` 建 GPU 场景 | `GpuScene.build` 起 | 已建程序 / 总程序（`used.size`，开建前知道），之后的管线、预热只报阶段 | 30 |
| `frame` 首帧 | 首帧提交后（等 GPU、等视频首帧） | 无 | 5 |

两条规则保证观感：**单调**（一次加载里进度只增不减，阶段只往前走），**不停**（宿主同步阻塞时——粒子预热、排版、`buildLayer`——发不出
消息，应用页在当前阶段的区间里按时间缓慢逼近区间上沿的 90%，消息一到就跳到真实值）。确定退回（`fallback`）时进度条直接走满再淡出。
重编译（改属性、改设置）时旧画面一直在画，不显示进度。

## 现状锚点

**a. 骨架覆盖层**（`apps/kabegame/src/components/image/ImageContent.vue:11-19`）
```vue
<!-- 现状：所有形态共用这一个骨架，wallpaper 形态也一样；ready 之前一直盖着 -->
<div
  v-if="showLoading"
  data-kb-motion
  class="ic-loading-overlay absolute inset-0 z-3 pointer-events-none grid place-items-center bg-kb-fill animate-[kb-pulse_1.6s_ease-in-out_infinite]"
  aria-hidden="true"
>
  <Film v-if="isVideo" class="size-7 text-kb-fg-subtle opacity-60" />
  <ImageIcon v-else class="size-7 text-kb-fg-subtle opacity-60" />
</div>
```

**b. 场景层的加载态**（`components/wallpaper/WallpaperStage.vue`，文件头与 `enterScene`）
```ts
// 现状：loading → live / fallback。结果出来前什么都不显示、不发 ready；首帧出来淡入实时画面；
// 不能渲染或 SCENE_RESULT_TIMEOUT_MS（10 s）内没有结果才加载作者预览图（previewPath）
sceneResultTimer = window.setTimeout(onSceneResultTimeout, SCENE_RESULT_TIMEOUT_MS);
await waitSceneShown();
```

**c. 宿主 → 父页面的消息**（`WpeSceneView.vue` 的 `onWindowMessage`）
```ts
// 现状：只认样式请求、右键、快捷方式、音量请求四种；没有进度
if (isWpeSceneStyleRequest(event.data)) { postSceneSettings(); postStyle(); postDisplay(true); return; }
const point = frame.value ? wpeContextMenuPoint(event.data, frame.value) : null;
```

**d. Worker 协议**（`apps/wpe-scene/src/compile/client.ts` 的 `worker.onmessage`）
```ts
// 现状：done / error 以外的消息一律当读文件请求；Worker 侧 compileScene 的对象循环（bundle.ts 的
// for (const [index, object] of scene.objects.entries())）全程串行，没有任何进度回调
if (message.type === "done") return finish(message.bundle);
if (message.type === "error") return finish(undefined, new Error(message.message));
try { const bytes = message.operation === "whole" ? await reader.readWhole(message.path) : ... }
```

**e. 宿主加载**（`apps/wpe-scene/src/host.ts` 的 `reload()`）
```ts
// 现状：等目标与设置 → compileSceneInWorker（Worker 编译 + 主线程解码）→ 文本 → 声音 / 视频 / 用户纹理 / 脚本
// → ensureRenderer（取设备）→ current.load(bundle)（GpuScene.build + 首帧）→ 等视频首帧 → report.ready()
// 唯一的计时是「开始渲染：N 层、M 个程序，…，用时 X ms」，不分阶段
```

## 点 1 — 宿主上报（`apps/wpe-scene`）

- **新增** `src/progress.ts`：`SceneProgress`（`stage`、`done`、`total`、`generation`）与 `postProgress`（`window.parent.postMessage`，
  同阶段 100 ms 节流、阶段变化立即发；字面量另写一份在应用侧，测试比对，同 `sceneStyle.ts`）。
- **修改** `compile/protocol.ts`：`WorkerResponse` 加 `{ type: "progress"; done: number; total: number }`。
- **修改** `compile/bundle.ts`：`CompileSceneInput` 加 `onProgress?(done, total)`；读完 scene.json 算总权重（Σ 1 + effect 数），对象循环
  每处理完一个调一次。快速退回时不再报。
- **修改** `compile/worker.ts`：`onProgress` 转成 `progress` 消息。`compile/client.ts`：**先**给 `progress` 加分支（现在会被当成读文件
  请求），转给 `WorkerCompileInput.onProgress`；`decodeEncodedTextures` 按 mip 回报 `decode`。
- **修改** `render/renderer.ts` / `render/scene.ts`：`SceneLoadOptions` 加 `onProgress`，`populate` 里每个 `ensureProgram` 落定回报一次
  `gpu`；首帧提交后报 `frame`。
- **修改** `host.ts`：`reload()` 只在**首次加载**（`state` 不是 `ready`）时上报，带本次的 `generation`，被取代的加载不再发。各段
  `performance.now()` 打点，「开始渲染」日志末尾加「编译 / 解码 / GPU / 首帧各 X ms」（待定 3）。
```ts
// host.ts reload() 里（目标代码示意）
const progress = this.state === "ready" ? null : sceneProgress(id);   // 新增：重编译不报
const bundle = await compileSceneInWorker({ ..., onProgress: progress?.stage("compile") });  // 修改
...
await current.load(bundle, { ..., onProgress: progress?.stage("gpu") });                      // 修改
progress?.stage("frame")(1, 1);                                                               // 新增
```

## 点 2 — 应用页接收与换算（`apps/kabegame`）

- **新增** `components/wallpaper/wpeSceneProgress.ts`：消息识别、阶段权重、`overallProgress(stage, done, total)`，以及「不停」的
  逼近曲线（纯函数，带 vitest）。
- **修改** `WpeSceneView.vue`：`onWindowMessage` 认进度消息，emit `progress`（只认当前宿主实例、`generation` 不倒退）。
- **修改** `WallpaperStage.vue`：加载态（`sceneRenderState === "loading"`）期间把进度往上 emit；live / fallback 后不再转发。
- **修改** `WpeWallpaperContent.vue` → `ImageContent.vue`：wallpaper 形态把进度交给覆盖层。

## 点 3 — `ImageContent` 的 wallpaper 形态改成双层（缩略层 + 壁纸层）

- **修改** `buildChain`：wallpaper 形态不再返回空链，`thumbSlot` 照常走缩略路径（仍排除目录本身的 `local_path`；没有 `preview.*`
  时 `thumbnail_path` 回落成目录，链为空，就没有底图，覆盖层退回现在的骨架底色）。
- **修改** 模板：wallpaper 形态 = 缩略层 `<img class="thumbnail-layer z-1">`（同图片形态）+ 壁纸层（`WpeWallpaperContent`，包一层
  `z-2` 的容器，揭开前 `opacity: 0`，揭开时淡入）。
- **新增** 加载覆盖层的 wallpaper 变体：不铺骨架底色，压在缩略图上，底部居中一条细进度条 + 下面一行阶段文字（「启动」「编译场景」
  「解码纹理」「准备渲染」「首帧」，i18n 五种语言）；网页壁纸没有阶段，只显示不确定的进度条与「加载中」。从挂上就显示（不走
  `useLoadingDelay` 的 300 ms 延迟，底下有缩略图，不怕闪）。
- **状态**（新增 `wallpaperState`：`loading` / `live` / `fallback`）：
  - `live`：`WpeWallpaperContent` 报实时（场景首帧、网页 load），且距加载开始已满 300 ms → 揭开壁纸层、覆盖层淡出。
  - `fallback`：报退回（场景不能渲染、超时）→ 相当于原图层死亡：壁纸层保持隐藏（不卸载，之后改属性能渲染了照样揭开），覆盖层
    走满后淡出，显示缩略层；缩略链也死了 → 丢失态（同图片 `thumbSlot.dead && origSlot.dead`）。
  - 致命错误（目标取不到）照旧进丢失态。
- **修改** `emit("ready")` 的时机：缩略层加载完就发（同图片），供预览弹窗结束切图等待；「画面在实时渲染」另由新 emit
  `wallpaperLive(boolean)` 给出（取代现在的 `sceneLive`，网页也走它），预览弹窗的 `previewRendering`（暂停、设为封面的置灰）改看它。
- **修改** `WpeWallpaperContent.vue`：向上转发 `progress`、`live`、`fallback`；给 `WallpaperStage` 传 `fallbackPreview: false`。
- **修改** `WallpaperStage.vue`：新增 prop `fallbackPreview`（缺省 true，桌面照旧）；为 false 时退回不加载 `previewPath`、直接 emit
  `fallback(reasons)`，`ready` 只在实时时发；新增 emit `progress`。
- **显示的地方**（用户定「所有场景都显示」）：图库预览、应用背景都经 `ImageContent`，同一套；桌面见待定 1。网格是缩略形态，不实时渲染，不涉及。

## 点 4 — 超时（待定 2）

- **修改** `WallpaperStage.vue`：`SCENE_RESULT_TIMEOUT_MS` 从「10 s 内没有结果就退回」改成「10 s 内没有新的进度才退回」，每收到
  一条进度重置计时；大场景慢慢加载但一直在动时不再被提前判成退回。

## 附：加载期间左上角的破图（已修）

切到场景时 `WallpaperStage` 的图片层要等场景层淡入后才被 `updateModeDisplay` 隐藏；加载期间两张没有 `src`、带 `alt`、撑满画布的
`<img>` 让 Chromium 在左上角画破图图标与 alt 文字。修法：`img.wallpaper-img:not([src]) { visibility: hidden; }`（只加样式，不改切换逻辑）。

## 已定（2026-11-15 用户）

- 加载底图用预览图（缩略层），同图片「原图出来之前缩略图能看」；进度与加载状态由 `ImageContent` 按 `WpeWallpaperContent` 的事件管；
  退回即原图失败，走图片的回退链；加载态至少 300 ms。
- 进度条下显示阶段文字；所有场景都显示。

## 待定问题

1. **桌面要不要显示进度？** 壁纸窗口不经 `ImageContent`，现在是「新场景出首帧前保留上一张壁纸，出来再淡入」。显示进度就要在桌面
   上叠一层进度条（盖在上一张壁纸上，或者先换成新壁纸的预览图再叠进度）。我理解的「所有场景」是图库预览与应用背景，桌面保持现状——
   对吗？
2. 超时改成「10 s 没有进度才退回」？（建议改）
3. 「开始渲染」日志加分阶段用时？（建议加，用来按实测调权重）

## 验证

- 单测：`wpeSceneProgress.ts` 的换算与单调；Worker 协议的 `progress` 分支（`client.ts` 不再把它当读文件）；宿主只在首次加载上报、
  被取代的加载不发；`WpeSceneView` 只认自己的 iframe。
- 真机（kabegame-dev MCP 屏外宿主）：收集一次加载的全部进度消息，核对阶段顺序、单调、首帧前最后一条是 `frame`；大场景（粒子预热、
  4K 纹理、视频）看各阶段用时与权重是否合理，按实测调权重。
- 预览里的观感要打开预览，由用户看。
