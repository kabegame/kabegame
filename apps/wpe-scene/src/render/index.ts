/**
 * WPE 场景壁纸的 WebGPU 渲染器。唯一输入是编译管线产出的 `SceneBundle`（`../compile`）；
 * 加载状态机在 `../host.ts`，应用页的 WpeSceneView 只承载 iframe。
 */
export { SceneRenderer, type SceneLoadOptions, type SceneRendererOptions } from "./renderer";
export { SceneRenderError, reasonsOf } from "./errors";
export { checkRenderable } from "./scene";
export type { GpuAdapterInfo } from "./device";
