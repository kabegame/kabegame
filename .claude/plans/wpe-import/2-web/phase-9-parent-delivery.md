# 网页壁纸 / 场景宿主的属性改由父页面推送（不让 iframe 自己拉）

> 2026-11-21 用户批准。上级：[PLAN.md](PLAN.md) 决策 10。

## Context

3841846165（BD2，网页壁纸）的「重置场景」一打开就无限重载：页面在 `applyUserProperties` 里收到 `resetstate: true` 就 `location.reload()`，垫片在新文档 load 后又自己 `invoke("wpe_web_pull_state")` 拿全量、整份再投一遍，循环。WPE 实测（`ignore/p6/f5/proj/kbweb-reload`）：页面自己 reload 后 `applyUserProperties` / `applyGeneralProperties` 都不调，之后改属性照推增量——WPE 是宿主往页面里推，只有主程序的加载命令复位「就绪」标志（`2-web/API.md` §4.8）。

上一轮的临时修法（垫片看 `performance` 导航类型是 `reload` 就不投全量，未提交）能止住这张，但「是不是应用发起的加载」应当由发起加载的一方判断。用户的意见：把投递改到外层、不让 iframe 内部 invoke，这样最稳。本计划照此重做，并撤掉那条临时修法。

## 总体设计思路

属性从「iframe 拉」改成「父页面推」，对齐 WPE 的宿主推送模型。父页面（网页壁纸的 `WpeWallpaperContent`、场景宿主的 `WpeSceneView`）自己取状态、自己订阅变化，经已有的 `postMessage` 通道（今天已经在推音量、暂停、可交互、场景样式等）把属性推给 iframe 里的垫片；垫片退化成一个薄的「应用器」：只认父窗口发来的可信消息，把它交给 `wallpaperPropertyListener`，不再调 `wpe_web_pull_state`、不再监听 `setting-change` / `image-changed` / `images-change`。

「就绪标志」由父页面持有，语义照 WPE：父页面新建 iframe 并赋 `src` 之后，**第一次**真正的文档 `load` 把标志置真，并推一次全量；此后 iframe 再触发的 `load`（页面自己 reload、改 `location.href`、前进后退）一律不重推——父页面没有发起这些导航，WPE 的主程序也不会因此重推。标志置真之后到达的变化只推增量。增量由父页面按「上次推给这个 iframe 实例的状态」计算，这份基线跟着 iframe 实例走、跨页面自己的 reload 保留，正好对应 WPE 主程序那边的属性状态；换壁纸时 iframe 销毁重建，基线与标志一起清掉。这样上一轮的导航类型判断就不需要了，`location.href` 这种 `navigate` 类型的页面自导航也一并对齐 WPE。

关键决策：
- **差异计算放到父页面的 TS 里**（新模块 `wpeWebState.ts`，原垫片的 `changedUser` 等搬过去）。理由：基线必须跨页面自己的 reload 存活，只有父页面做得到；TS 侧可单测，垫片是不经打包的纯脚本、只能靠读源码的测试。
- **一个组合函数两处用**：`useWpeStateDelivery` 负责取状态（带序号丢弃乱序）、订阅三种事件、持标志与基线、算增量、发消息；`WpeWallpaperContent` 与 `WpeSceneView` 只在「iframe 新建」和「第一次真实 load」两处调它。场景宿主同一个垫片、同一条路，宿主里 `main.ts` 的 `wallpaperPropertyListener` 不用改。
- **后端换成给父页面的命令** `wpe_web_get_state(imageId)`：主窗口与壁纸窗口的应用页免 ACL，只注册不进任何 permission；内容与原 `wpe_web_pull_state` 相同（按调用方窗口取帧率设置，交出前覆盖这张的 `file:` 放行）。原命令删除，网页壁纸 capability 的 `listen` 只留 `wallpaper-ping` 与 `wpe-scene-clear-storage`：iframe 既拿不到状态，也收不到 `setting-change`（它原本会把任意设置项的变化带进页面），权限面变小。
- 留在 iframe 里不动的：`wallpaper_pong`、`wpe_web_media_subscribe`（Channel 按 frame 归属）、`attach_frame`、场景宿主的专用命令与 `wpe-scene-clear-storage` 监听、音量 / 暂停 / 右键 / 快捷方式消息。

## 现状锚点

**a. 垫片自己拉、自己订阅**（`src-tauri/kabegame/src/webview_js/wpe_shim.js` 传输段）
```js
var transport = {
  pull: function () {
    var sceneImage = new URLSearchParams(location.search).get("kbScene");
    return internals.invoke("wpe_web_pull_state", sceneImage ? { imageId: sceneImage } : {});  // 现状：iframe 自己拉
  },
  subscribe: …,   // wpe_web_media_subscribe，Channel 回本 frame（不动）
  listen: …,      // plugin:event|listen
};
transport.listen(["wallpaper-ping"], …);                                   // 不动
transport.listen(["setting-change", "image-changed", "images-change"],    // 现状：语言 / wpeFps / 本张 metadataId 补丁触发重拉
  function (event) { if (shouldPull(event)) pull(); }).then(pull);
```
**b. 垫片的投递**（同文件「投递」段）：`receive(next)` 在 `load` 后首次 `deliverFull`，之后 `changedUser` 按键差异、`general` 整份、`deliverDirectories` 增删；`wallpaperPropertyListener` 的 setter 在投过之后补投全量；`deliverFull` 末尾 `if (hostPaused) call("setPaused", true)`。本轮未提交的改动在这里加了 `selfNavigated`（导航类型 `reload` / `back_forward` 不投全量）与 `deliverFirst` / `fullDelivered`。

**c. 后端**（`commands/wpe_web.rs:524`）
```rust
#[tauri::command]
pub async fn wpe_web_pull_state<R: tauri::Runtime>(webview: tauri::Webview<R>, caller: tauri::ipc::CallerOrigin,
    image_id: Option<String>) -> Result<WpeWebState, String> {
    let doc = caller_document(&caller.0).ok_or("caller is not a file: document")?;   // 现状：按 iframe 文档认图
    let source = WpeSettingsSource::of_label(webview.label());
    …build_wpe_web_state_with_raw(&id, source)… index.replace_grants(&id, user_file_grants(&raw));
}
```
`permissions/wpe-web.toml`：`commands.allow = ["wpe_web_pull_state", "wallpaper_pong", "wpe_web_media_subscribe"]`；`capabilities/wpe-web.json` 的 `allow-listen`：`wallpaper-ping`、`setting-change`、`image-changed`、`images-change`、`wpe-scene-clear-storage`。

**d. 父页面已有的消息通道**（`WpeWallpaperContent.vue`）
```ts
function postWebVolume() { target.postMessage(wpeVolumeMessage(…), "*"); }        // 父 → 垫片：音量 / 暂停 / 可交互
function onWindowMessage(event) { if (event.source !== webFrameEl?.contentWindow) return; … }
frame.addEventListener("load", () => {
  if (frame !== webFrameEl || result !== "loading") return;  // 现状：只处理第一次真实 load（初始空文档、被拦的另判）
  if (isInitialBlank(frame)) return;
  … setLive();
});
```
`WpeSceneView.vue`：`<iframe v-if="src" :src="src" @load="postPointer" />`，`postVolume()` 同上；`onWindowMessage` 只认 `event.source === frame.contentWindow` 且 `isTrusted`。

**e. 可复用**：`services/kbEvents/eventSource.ts` 的 `kbEvent$`；`composables/useWpeWebProperties.ts:191-207` 已经按「本张 `metadataId` 补丁 / `language`」订阅，判据可照抄；垫片测试环境 `components/wallpaper/wpeWebVolume.test.ts` 的 `createShimEnv`（读垫片源码执行）。

## 点 1 — 后端命令（`commands/wpe_web.rs`、`lib.rs`、`permissions/wpe-web.toml`、`capabilities/wpe-web.json`）

- **新增**
```rust
/// 父页面（主窗口 / 壁纸窗口的应用页，免 ACL，不进任何 permission）取一张网页 / 场景壁纸要推给 iframe 的状态。
/// 照 WPE 由宿主推送（2026-11-21 起，见 phase-9-parent-delivery）：iframe 不再自己拉。交出前用同一份 metadata 覆盖这张的
/// `file:` 放行，页面拿到新路径时闸门一定已经认它。`general.fps` 按调用方窗口取设置（`WpeSettingsSource`）。
/// 行不存在或不是 `x-wpe/web` / `x-wpe/scene` 返回 None。
#[tauri::command]
pub async fn wpe_web_get_state<R: tauri::Runtime>(webview: tauri::Webview<R>, image_id: String)
    -> Result<Option<WpeWebState>, String> {
    let source = WpeSettingsSource::of_label(webview.label());
    let Some((state, raw)) = build_wpe_web_state_with_raw(&image_id, source).await? else { return Ok(None) };
    WpeWebDirIndex::global().replace_grants(&image_id, user_file_grants(&raw));
    Ok(Some(state))
}
```
- **删除** `wpe_web_pull_state`（函数、`generate_handler!` 条目、`wpe-web.toml` 的 allow）；`caller_document` 仍被 `wpe_web_media_subscribe` 用，保留。
- **修改** `wpe-web.json`：`allow-listen` 去掉 `setting-change`、`image-changed`、`images-change`；`description` 改成「答 ping、订阅音频 / 媒体、登记原生鼠标、监听 `wallpaper-ping` 与 `wpe-scene-clear-storage`；属性由父页面推送」。

## 点 2 — 协议与差异（`components/wallpaper/wpeWebState.ts`，新增）

```ts
/** 父页面 → 垫片：属性。垫片只认 `isTrusted` 且来自父窗口的；垫片是纯脚本，字面量另写一份，测试比对。 */
export const WPE_STATE_MESSAGE = "kabegame:wpe-state";
export interface WpeWebState { imageId: string; user: Record<string, WpeUserProperty>; general: WpeWebGeneral; directories: Record<string, WpeWebDirectory>; }
export type WpeStateMessage =
  | { type: typeof WPE_STATE_MESSAGE; full: true; state: WpeWebState }      // 就绪后的第一次：整份
  | { type: typeof WPE_STATE_MESSAGE; full: false;                            // 之后：增量
      user: Record<string, WpeUserProperty> | null;                           // 值变了的键（无默认值的 file / directory 重置后补空路径）
      general: WpeWebGeneral | null;                                          // 有变化时整份
      directories: Record<string, WpeWebDirectory>;                           // 最新整份：垫片据此派发增删、回答随机文件
      directoryChanges: Record<string, { added: string[]; removed: string[] }> };
/** 搬自垫片的 changedUser / deliverDirectories 的判定（规则不变）；没有任何变化返回 null。 */
export function stateDelta(prev: WpeWebState, next: WpeWebState): WpeStateMessage | null;
```

## 点 3 — 组合函数（`composables/useWpeStateDelivery.ts`，新增）

```ts
/**
 * 父页面向一个壁纸 iframe 推属性（照 WPE 宿主推送）：
 * - 取状态 `wpe_web_get_state`，序号递增、丢弃更早发出更晚返回的；订阅 `setting-change`（language / wpeFps）与本张的
 *   `metadataId` 补丁（`image-changed` / `images-change`，判据同 useWpeWebProperties）时重取。
 * - 就绪标志：`arm()` 由调用方在这个 iframe 实例第一次真实文档 load 时调，置真并推整份；之后的 load（页面自己导航）不调。
 * - 置真后新状态按基线算 `stateDelta` 推增量；基线跟 iframe 实例走，跨页面自己的 reload 保留；`reset()`（iframe 重建）清掉。
 */
export function useWpeStateDelivery(options: { imageId: () => string | null; target: () => Window | null }): {
  arm(): void; reset(): void; };
```

## 点 4 — 两个父组件（`WpeWallpaperContent.vue`、`WpeSceneView.vue`）

- `WpeWallpaperContent`：`startWeb` 建 iframe 时 `delivery.reset()`；现有 load 处理里「第一次真实、未被拦的 load」分支调 `delivery.arm()`（这一支本来就只走一次，之后的 load 被 `result !== "loading"` 挡掉，正是想要的语义）。`imageId` 取 `resolved.value?.id`。
- `WpeSceneView`：换 `src`（新实例）时 `reset()`；`@load` 里 `src` 是当前实例、且这个实例还没 arm 时 `arm()`；原 `postPointer` 照调。
- 头注释各补一条「属性：由父页面推送，见 useWpeStateDelivery」。

## 点 5 — 垫片（`webview_js/wpe_shim.js`）

- **删除**：`transport.pull`、`setting-change` / `image-changed` / `images-change` 的监听、`pull` / `shouldPull` / `patchesOf` / `receive` / `changedUser`；本轮未提交的 `selfNavigated` / `deliverFirst` / `fullDelivered`。
- **新增** 消息接收（挂在已有的 `message` 处理旁，只认 `event.isTrusted && event.source === window.parent`）：
  - `full: true` → `deliverFull(state)`（`applyUserProperties` 再 `applyGeneralProperties`，键排序；目录全量当作新增派发；记 `delivered` 供换 listener 补投）；
  - `full: false` → 依次 `applyUserProperties(user)`、`applyGeneralProperties(general)`、目录增删；合进 `delivered`（若有）；
  - 两种都更新 `latestDirectories`（`wallpaperRequestRandomFileForProperty` 用）。
- **保留**：换 listener 补投全量（只在本文档收到过整份之后）、`setPaused` 补调规则、ping 应答、媒体订阅。
- **暂停**：页面自己 reload 出来的文档收不到整份；宿主已暂停时在 `load` 后照调一次 `setPaused(true)`（已定 2）。

## 点 6 — 文档与回归

- `cocs/wpe/WPE_IMPORT.md`「运行时垫片与宿主协议」：传输、投递语义、重拉触发改成父页面推送；本轮加的「页面自己 reload 不重推」一条改写为由父页面的就绪标志实现。
- `AGENTS.md`（文件类型段里「垫片…直接 `invoke("wpe_web_pull_state")` / `listen`」）、`cocs/README.md`（3 处）、`cocs/tauri/TAURI_ACL_PERMISSION_SYSTEM.md`（3 处，wpe-web 的命令与 listen 表）、`cocs/wpe/WPE_SCENE.md`（7 处，场景宿主属性拉取）同步。
- `2-web/API.md` §4.8 的「对 Kabegame 的含义」与 `2-web/PLAN.md` 决策 10 补注：改为父页面推送。
- `versions/latest/regression.md`：本轮那节改写成新方案的用例；`changelog.md` 那行措辞不变。

## 已定（2026-11-21 用户）

1. 场景宿主一起改：同一个垫片、同一条推送路径，`wpe_web_pull_state` 与三个事件监听整个删掉。
2. 页面自己 reload 出来的文档在宿主已暂停时，`load` 后照调一次 `setPaused(true)`（WPE 这种情况的行为未测，记为我们的规则）。

## 验证

**单测**（vitest 只跑相关文件，`cd /D/Codes/kabegame`、大写盘符 `--config`）
- `wpeWebState.test.ts`（新）：`stateDelta` 搬过来的规则（值变的键、file / directory 重置补空路径、`general` 整份、目录增删、无变化 null）。
- `useWpeStateDelivery.test.ts`（新，mock `invoke` 与 `kbEvent$`）：未 arm 只取不推；arm 推整份；之后事件重取推增量；乱序丢弃；`reset` 后再 arm 推整份；不相关图片的补丁不重取。
- `WpeWallpaperContent.test.ts` / `WpeSceneView.test.ts`：第一次真实 load 推整份；再触发 load（模拟页面 reload）不推；属性变化推增量；换目标重建后重新整份。
- `wpeWebVolume.test.ts` 的垫片环境：整份 / 增量消息交给 listener（键排序）；非父窗口或不可信的消息不理；没有消息时不调；换 listener 只在收过整份后补投；不再调 `wpe_web_pull_state`、不再 listen 三个事件；常量与 `wpeWebState.ts` 一致。
- 变异：去掉 arm 只一次的判断、去掉来源核对、增量不保留基线。

**检查**：`check-kabegame`（vue-tsc + cargo check；dev 开着时 cargo 可能被挡，见记忆）；Rust 单测 `commands::wpe_web`；Prettier；`node --check wpe_shim.js`。

**真机**（后端与垫片编进程序，要用户重开 dev）
- 用 `projects_import` 导入 `ignore/p6/f5/proj/kbweb-reload` 打开预览，截图应与 WPE 相同：第一份文档收到 `doreload=true` 后 reload，新文档 5 s 内 `userCalls=0 generalCalls=0`；面板改 `p_num` 后收到只含 `p_num` 的增量。用完 `projects_remove`。
- 3841846165 打开「重置场景」：只重载一次就正常显示。
- 一张带 `directory` / `file` 属性的网页壁纸：选文件后页面能读、目录回调照常；改语言后页面收到 `applyGeneralProperties`。
- 场景壁纸：首次加载正常、改属性就地生效（2974757317 / 3838286359 各一张）；桌面壁纸窗口（ping 不误判、属性到达）。
- `app_log` 里没有新的 ACL 拒绝。

**提交**：用户说提交再提，照旧临时索引按块挑。

## 实施补记（2026-11-21 真机）

- **dev 工具的屏外宿主**：`scripts/kabegame-dev/scene.ts` 的 `openHost` 开的屏外宿主是主窗口里的裸 iframe，没有 `WpeSceneView`。以前垫片自己拉属性，它也能加载；改成父页面推送后它等不到第一包属性，一直不加载（别的会话开的 16235 没有「开始渲染」）。修法：注入主窗口的脚本在宿主发来 `kabegame:wpe-scene-style-request`（宿主启动时发一次，说明文档与垫片都已就绪）时调 `wpe_web_get_state`、推整份。之后不跟库里的变化（探针接口自己带 `userProperties`），写进 `kabegame-chromium` skill。
- **网页测试工程**：`projects_import` 原来只在场景行里按目录找、`projects_remove` 用 `wpe_scene_target` 核对目录，网页测试工程导入后找不到行、也移除不了。改成导入时在场景与网页两类里找，移除用 `get_wallpaper_target_for_image` 核对类型与目录（守卫不变）。
- 真机结果见 `versions/latest/regression.md` 本节 T4–T9；测试工程 `ignore/p6/f5/proj/kbweb-props`（`file` / `directory` fetchall / ondemand）。
