# P3-0b — 渲染器迁进宿主

> 上级：[phase-3-0-scene-host.md](phase-3-0-scene-host.md)。前置：[phase-3-0a-host-channel.md](phase-3-0a-host-channel.md) 的通路已验收。

## 总体设计思路

应用页的 `WpeSceneView` 不再编译、渲染，只剩一个 iframe 外壳；它的外部契约（props `target / paused / interactive`，emit `ready / fallback`）不变，`WallpaperStage` 的 loading → live / fallback、10 s 超时、预览 / 应用背景 / 桌面三处同档都不动。

**搬进 `apps/wpe-scene` 的部分**：
- 编译管线：Worker、主线程代读文件、wasm 翻译器；
- 渲染器、FreeImage 解码缓存、设备丢失重建；
- `WpeSceneView` 的加载状态机，改成无 Vue 的 `SceneHost`。

**宿主的数据来源**，全部用 3-0a 的通路：
- 用户属性：垫片的 `applyUserProperties`；
- 场景目录：`wpe_scene_target`；
- 后处理档位：照旧 `get_wpe_scene_postprocess` 并监听 `setting-change`；
- 暂停与音量：`WpeSceneView` 回应自己那个宿主 iframe 的音量请求（带 `paused`），垫片转成 `setPaused`；
- 状态与日志：`wpe_scene_report`。

壁纸窗口的 ping 在 `WpeSceneView` 收到宿主的第一个音量请求后才交给宿主：这说明垫片已经在跑，而 ping 正是垫片应答的。宿主卡死（P3 脚本死循环）就整窗重载，与网页壁纸一致；宿主没起来（没构建、加载失败）时应用页继续应答，不会陷入重载循环。

宿主单测与 kabegame 前端测试一起跑：`deno task test -c kabegame` 的前端部分依次跑两个目录（用户定）。

## 现状锚点

**a. 编译与渲染在应用页**（`apps/kabegame/src/components/wallpaper/WpeSceneView.vue`）
```ts
// 现状：应用页主 frame 自己读属性与档位、在 Worker 里编译、建 WebGPU 渲染器，并订阅本张的 metadataId 补丁
async function reload() {
  const [properties, setting] = await Promise.all([readProperties(target.id), readPostprocess()]);
  const bundle = await compileSceneInWorker({ projectDir: target.path, sceneAssets: target.sceneAssets,
    userProperties: properties.values, postprocess: setting, force, textureCache, reader, signal });
  const current = await ensureRenderer();          // SceneRenderer.create(canvas, …)
  await current.load(bundle, { ignoreUnsupported: force });
  current.setPaused(props.paused);
  if (state !== "ready") { state = "ready"; emit("ready"); }
}
```

**b. ping 只在网页壁纸显示期间交出去**（`WallpaperStage.vue`、`views/WallpaperWindow.vue`）
```ts
function isShowingWeb(): boolean {
  return !!webFrameEl;                     // 现状：不认场景
}
// WallpaperWindow.vue
if (stage.value?.isShowingWeb()) return;   // 现状：网页壁纸显示期间由 iframe 应答
invoke("wallpaper_pong", { seq: event.payload.seq }).catch(() => {});
```

**c. wasm 与前端测试只认 `apps/kabegame`**（`scripts/paths.ts`、`scripts/plugins/component-plugin.ts`）
```ts
export const WPESL2WGSL_FE_WASM = /* 现状：apps/kabegame/src/wpe-scene/wpesl2wgsl/wpesl2wgsl.wasm */;
static feTestDir(comp: string): string | null {
  switch (comp) {
    case this.MAIN: return this.appFeDir(comp);   // 现状：只跑 apps/kabegame 的 vitest
    default: return null;
  }
}
```

**d. 场景探针装在应用页**（`apps/kabegame/src/bootstrap/app.ts` 的 `installSceneDevProbe`，`window.__kabegameSceneProbe`）。

## 点 1 — 场景代码搬进 `apps/wpe-scene`
- **新增**：`apps/kabegame/src/wpe-scene/` 下的 `compile/`、`render/`、`wpesl2wgsl/`、`dev/` 及单测，用 `git mv` 搬到 `apps/wpe-scene/src/`。
- **新增** `src/fileUrl.ts`：本地路径 → `file:///` 地址，替换 `@/utils/fileUrl`，不跨项目 import。
- **新增** `vitest.config.ts`（`environment: "node"`，`include: ["src/**/*.test.ts"]`）；`package.json` 加 `test: vitest run`。
- **修改** `vite.config.ts`：
  - Worker 产物自包含：补丁 07 关掉了 Worker 的 `file:` 工厂，Worker 不能再 import 别的 chunk，所以设 `worker: { format: "iife" }`，构建后检查产物里没有 `import`；
  - wasm 照旧由主线程 `fetch` 后编译成 `WebAssembly.Module` 交给 Worker（现状已是这样）。
- **删除** `apps/kabegame/src/wpe-scene/`（含 `render/webgpu.d.ts`）、`apps/kabegame/package.json` 的 `@webgpu/types`，以及 `deno.lock` 里对应的成员记录。

## 点 2 — 宿主入口与加载状态机（`main.ts`、`host.ts`、`report.ts`）
- **新增** `SceneHost`：`WpeSceneView` 的这些逻辑原样搬来，Vue 的 props、emit 换成方法调用与 `report`：
  - `reload` / `ensureRenderer` / `fallback`；
  - 设备丢失一分钟内重建一次；
  - 档位变化重判。
- **数据时序**：
  - 首次 `applyUserProperties` 到达后才开始首次加载；
  - 之后每次合并变了的键再 `reload()`；
  - 不再订阅图片事件，`metadataId` 的比对与重拉顺序都由垫片负责。
- **新增** `report.ts`：状态经 `wpe_scene_report` 上报；`log.info / warn / error` 打 console 的同时上报 `log`，`debug` 只打 console。
- **修改** `main.ts`（替换 3-0a 的验证版）：
```ts
const params = new URLSearchParams(location.search);
const instance = params.get("kbInstance") ?? "";
const host = new SceneHost(document.querySelector("#scene-canvas")!, {
  imageId: params.get("kbScene"),
  report: createReporter(instance),
});
// WPE 网页 API：属性由垫片拉取后回调；暂停由垫片按父页面音量消息里的 paused 回调
window.wallpaperPropertyListener = {
  applyUserProperties: (changed) => host.applyUserProperties(changed),
  setPaused: (paused) => host.setPaused(paused),
};
document.addEventListener("pointermove", (event) =>
  host.setPointer(event.clientX / innerWidth, event.clientY / innerHeight));
```
- **修改** dev 探针：`window.__kabegameSceneProbe` 改装在宿主里，只在 dev 构建里有；CDP 脚本按 frame URL 含 `/wpe-scene/index.html` 找到宿主 frame 再调用。

## 点 3 — 应用页（`WpeSceneView.vue`、`WallpaperStage.vue`、`WallpaperWindow.vue`）
- **修改** `WpeSceneView.vue` 改成 iframe 外壳。props 加 `volume`，emit 加 `alive`：
```vue
<script setup lang="ts">
// 挂载与换目标：取宿主地址，生成新实例号，src = `${url}?kbScene=<id>&kbInstance=<实例号>`；取不到地址就 emit fallback(["host:unavailable"])
// listen("wpe-scene-status")，只认本实例号：ready / fallback → 照旧 emit
// window message：只认本 iframe 的音量请求（isTrusted、source 是本 iframe），回 { volume: webHostVolume(volume, paused), paused }；
//   第一次收到时 emit("alive")（垫片在跑，ping 由它应答）
// paused / volume 变化 → 主动推同一条消息
</script>
<template>
  <iframe v-if="src" :src="src" :sandbox="WEB_SANDBOX" class="block w-full h-full border-0"
    :class="interactive ? 'pointer-events-auto' : 'pointer-events-none'" />
</template>
```
  - `WEB_SANDBOX` 从 `WallpaperStage.vue` 挪到共享模块，两边共用；回应音量请求复用 `wpeWebVolume.ts` 的协议函数。
- **修改** `WallpaperStage.vue`：
  - 给 `WpeSceneView` 传 `volume`，监听 `alive`；
  - `isShowingWeb()` 改名 `delegatesPing()`：web 层 iframe 存在，或场景宿主已 `alive`；换场景、卸载时清零。
- **修改** `WallpaperWindow.vue` 改调 `delegatesPing()`。
- **删除** `bootstrap/app.ts` 的 `installSceneDevProbe`。
- `WallpaperStage.scene.test.ts`：替身补上 `alive`，加一条 `delegatesPing` 用例。

## 点 4 — 构建与测试（`scripts/`）
- **修改** `scripts/paths.ts` 的 `WPESL2WGSL_FE_WASM` 指向 `apps/wpe-scene/src/wpesl2wgsl/`，`.gitignore` 同步。
  - `Wpesl2wgslPlugin` 先于 `WpeSceneHostPlugin` 注册，wasm 在宿主构建前已拷好。
- **修改** `WpeSceneHostPlugin`：dev 用 `vite build --mode development` 构建（带 dev 探针），build 照旧 production。
- **修改** 前端测试一起跑：
  - `Component.feTestDir` 改为返回目录列表，`MAIN` 为 `[apps/kabegame, apps/wpe-scene]`；
  - `deno task test -c kabegame`（含 `--skip cargo`）依次跑两个目录的 vitest，任一失败即失败；
  - 语料测试的 `KABEGAME_WPE_ROOT` 照旧。

## 点 5 — 文档
- `cocs/wpe/WPE_SCENE.md`：渲染器位置、`SceneHost`、ping 归属、测试入口、探针用法。
- `scripts/AGENTS.md`：测试入口。
- `cocs/README.md` 摘要、回归表、changelog。

## 验收
- **画面一致**：P1 三张、vortex、bedroom（强制渲染；关闭 / 开启 / 超高三档）在固定 `g_Time` 下的场景目标，与迁移前的 SHA-256 相同。基准是 P2a / P2b 的哈希，经宿主里的探针取。
- **三处都能用**：
  - 预览、应用背景、桌面壁纸窗口都实时渲染，rAF 与迁移前相当；
  - 改属性只重编译、不重建设备；切档位、换场景、退回预览图、迟到的首帧都与迁移前一致；
  - 预览暂停时画面停住、`g_Time` 冻结，恢复后接着走。
- **ping**：
  - 桌面显示场景时由宿主的垫片应答；
  - 宿主人为死循环时，壁纸窗口约 30 s 后整窗重载；
  - 宿主产物缺失时显示预览图，壁纸窗口不重载。
  - 壁纸窗口不是窗口模式就记为未测，不改用户的壁纸设置。
- **日志**：宿主的开始渲染 / 退回 / 设备丢失记录出现在应用日志里，target 为 `kabegame::wpe_scene_host`。
- **测试**：`deno task test -c kabegame --skip cargo` 跑完两个前端目录，搬过去的单测全部通过。
- **清理**：`apps/kabegame` 里不再有 `wpe-scene/`、WebGPU 类型与场景探针；`check-kabegame` 0 error。
- **记录**：预览、应用背景、桌面同时开时，每个宿主进程的内存。
