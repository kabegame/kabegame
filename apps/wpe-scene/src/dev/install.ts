/**
 * 安装场景宿主的 dev 探针：由 main.ts 的构建模式常量门控，release 构建会摇掉。
 */
import type { SceneHost } from "../host";
import { runBloomProbe } from "./bloomProbe";
import { fluidProbe } from "./fluidProbe";
import { particleCorners } from "./particleCorners";
import {
  hostParticles,
  hostRenderFrame,
  hostState,
  hostStats,
  hostTexts,
  particleTrackProbe,
  probeChunk,
  probeKeys,
  renderFrame,
} from "./probe";
import { realmCheck } from "./realmProbe";
import { scriptCorpus } from "./scriptCorpus";

export function installSceneDevProbe(host: SceneHost): void {
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
    /** P7d 步骤 3：流体 effect 的单步隔离（换 fbo 内容、逐帧完整编码、读回 fbo）与长程回放（读回画布）。 */
    fluid: fluidProbe,
    /** P3a：当前场景的状态、宿主计数与「按当前状态渲染一帧」的哈希。 */
    host: {
      state: () => hostState(host),
      stats: () => hostStats(host),
      renderFrame: (time: number) => hostRenderFrame(host, time),
      realmCheck: (extraSources?: string[]) => realmCheck(host, extraSources),
      scripts: () => host.scriptDiagnostics,
      clock: () => host.clock(),
      audio: () => host.audio(),
      /** P6a 步骤 1：每个声音对象的模式、当前文件、实例状态、`T`、`Rm`、`isPlaying`、增益，以及元素、Blob 与 AudioContext。 */
      sounds: () => host.sounds(),
      /** P9a 步骤 2：每段视频纹理的位置、`currentTime`、`paused`、`lastDrawn`、`fresh`、`failed`、尺寸与丢帧数、当前帧号。 */
      videos: () => host.videos(),
      /**
       * P11b 步骤 2：每个用户纹理属性来源（`scenetexture`）的当前值、状态（`ready` / `empty` / `failed` / `unsupported`…）、解码后的整张尺寸、
       * 最近一次解码用时与已登记的纹理名（`值x比例·10`）。
       */
      userTextures: () => host.userTextureProbe(),
      /**
       * P10a 步骤 3：每条关键帧动画的 `id`、时钟主人、`t`、`getFrame()`、`isPlaying()`、标志、最后写入的值，以及最近 600 帧 `frame()`
       * 的耗时（`frameMs`）。
       */
      animations: () => host.animations(),
      read: (path: string) => host.readTarget(path),
      /** P4a 步骤 5：粒子数量与分布、开销记录（`{ profile: true }` 开始，`false` 停止）、当前 instanceoverride。 */
      particles: (options?: { profile?: boolean }) => hostParticles(host, options),
      /** P6b 1e：文本层运行中重排的次数与用时（`GpuScene.textStats`），以及每个文本层当前的文字、字号与排版尺寸。 */
      texts: () => hostTexts(host),
    },
  };
}
