/**
 * 安装场景渲染器的 dev 探针：`window.__kabegameSceneProbe`（`bootstrap/app.ts` 里 `IS_DEV` 门控，release 里
 * `IS_DEV` 是编译期常量 false，调用与这几个模块一起被摇掉）。经 CDP（`kabegame-chromium` skill）在真 app 里调用。
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
