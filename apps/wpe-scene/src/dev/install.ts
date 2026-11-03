/**
 * 安装场景宿主的 dev 探针：由 main.ts 的构建模式常量门控，release 构建会摇掉。
 */
import type { SceneHost } from "../host";
import { runBloomProbe } from "./bloomProbe";
import { hostRenderFrame, hostState, hostStats, probeChunk, probeKeys, renderFrame } from "./probe";

export function installSceneDevProbe(host: SceneHost): void {
  (window as unknown as { __kabegameSceneProbe?: unknown }).__kabegameSceneProbe = {
    renderFrame,
    bloom: runBloomProbe,
    chunk: probeChunk,
    keys: probeKeys,
    /** P3a：当前场景的状态、宿主计数与「按当前状态渲染一帧」的哈希。 */
    host: {
      state: () => hostState(host),
      stats: () => hostStats(host),
      renderFrame: (time: number) => hostRenderFrame(host, time),
    },
  };
}
