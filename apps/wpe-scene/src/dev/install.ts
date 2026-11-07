/**
 * 安装场景宿主的 dev 探针：由 main.ts 的构建模式常量门控，release 构建会摇掉。
 */
import type { SceneHost } from "../host";
import { runBloomProbe } from "./bloomProbe";
import { particleCorners } from "./particleCorners";
import {
  hostParticles,
  hostRenderFrame,
  hostState,
  hostStats,
  particleTrackProbe,
  probeChunk,
  probeKeys,
  renderFrame,
} from "./probe";
import { realmCheck } from "./realmProbe";
import { scriptCorpus } from "./scriptCorpus";

/** 预览属性面板的 dev 按钮发来的消息（`WpeWebPropertiesPanel.vue`）。 */
const DEV_SCENE_MESSAGE = "kabegame:dev-scene";

/** 观察 3c 风险用：整场重新加载（对比就地切换）。 */
function listenDevButtons(host: SceneHost): void {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const { kind, action } = (event.data ?? {}) as { kind?: unknown; action?: unknown };
    if (kind !== DEV_SCENE_MESSAGE) return;
    if (action === "reload") {
      host.stats.recompiled.push({ reason: "dev-reload", keys: [] });
      void (host as unknown as { reload(): Promise<void> }).reload();
    }
  });
}

export function installSceneDevProbe(host: SceneHost): void {
  listenDevButtons(host);
  (window as unknown as { __kabegameSceneProbe?: unknown }).__kabegameSceneProbe = {
    renderFrame,
    bloom: runBloomProbe,
    chunk: probeChunk,
    keys: probeKeys,
    scriptCorpus,
    /** P4a 步骤 3：按 dt 序列步进粒子模拟器，输出 RenderDoc 轨迹同格式的数据。 */
    particleTrack: particleTrackProbe,
    /** P4a 步骤 4（风险 7）：翻译出的粒子顶点着色器对当前粒子算出的四角裁剪坐标。 */
    particleCorners,
    /** P3a：当前场景的状态、宿主计数与「按当前状态渲染一帧」的哈希。 */
    host: {
      state: () => hostState(host),
      stats: () => hostStats(host),
      renderFrame: (time: number) => hostRenderFrame(host, time),
      realmCheck: (extraSources?: string[]) => realmCheck(host, extraSources),
      scripts: () => host.scriptDiagnostics,
      clock: () => host.clock(),
      audio: () => host.audio(),
      read: (path: string) => host.readTarget(path),
      /** P4a 步骤 5：粒子数量与分布、开销记录（`{ profile: true }` 开始，`false` 停止）、当前 instanceoverride。 */
      particles: (options?: { profile?: boolean }) => hostParticles(host, options),
    },
  };
}
