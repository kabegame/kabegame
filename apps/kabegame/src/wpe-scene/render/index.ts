/**
 * WPE 场景壁纸的 WebGPU 渲染器。唯一输入是编译管线产出的 `SceneBundle`（`../compile`）；
 * 组件侧见 `components/wallpaper/WpeSceneView.vue`，文档见 `cocs/wpe/WPE_SCENE.md`「渲染器」。
 */
export { SceneRenderer, type SceneLoadOptions, type SceneRendererOptions } from "./renderer";
export { SceneRenderError, reasonsOf } from "./errors";
export { checkRenderable } from "./scene";
export type { GpuAdapterInfo } from "./device";
