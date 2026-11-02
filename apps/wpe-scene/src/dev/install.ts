/**
 * 安装场景宿主的 dev 探针：由 main.ts 的构建模式常量门控，release 构建会摇掉。
 */
import { runBloomProbe } from "./bloomProbe";
import { probeChunk, probeKeys, renderFrame } from "./probe";

export function installSceneDevProbe(): void {
  (window as unknown as { __kabegameSceneProbe?: unknown }).__kabegameSceneProbe = {
    renderFrame,
    bloom: runBloomProbe,
    chunk: probeChunk,
    keys: probeKeys,
  };
}
