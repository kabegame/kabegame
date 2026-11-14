/**
 * sprite 对象（P13c，`.claude/plans/wpe-import/3-scene/phase13/phase-13c-sprite.md`；读码 rea-p13-lights 第 4 节，实测 p13-REPORT「P13c 的
 * 实测」）：WPE 的「带遮挡测试的太阳光斑」。
 *
 * - 构造（`FUN_140256560`）：4 个顶点、6 个 u16 索引的常量网格，顶点格式 POSITION float3 + TEXCOORD float2（20 字节，mdl 格式 `0x9`）；
 *   四个顶点的位置都是 `(−1, 0, 1)`，uv 依次 `(0,0) (1,0) (1,1) (0,1)`，索引 `0,1,2, 0,2,3`（常量 `0x140492b60` 起）。另加载
 *   `materials/util/occlusiontest.json` 做遮挡测试。对象自己的 `origin` / `angles` / `scale` / `parent` 不参与（S5）。
 * - 我们把它编成一个两网格的「模型」挂在图层上（`layer.model`），复用模型的网格绘制路径（顶点布局、管线、深度、刷新）：网格 0 是光斑
 *   （sprite 材质），网格 1 是遮挡方块（occlusiontest），按这个顺序画（`order: [0, 1]`，不按不透明排序）。`layer.sprite` 标明这个模型是
 *   sprite，渲染器据此写 sprite 的 uniform（`render/sprite.ts`）并在遮挡方块前插计数 pass。
 */
import type { SceneMesh, SceneModel, ScenePass } from "./bundle";

/** 遮挡测试的材质（WPE 写死的路径，在 WPE `assets` 里）。 */
export const OCCLUSION_MATERIAL = "materials/util/occlusiontest.json";
/** 两个网格在 `layer.model.meshes` 里的下标。 */
export const SPRITE_BODY = 0;
export const SPRITE_OCCLUSION = 1;
/** 顶点格式：POSITION（`0x1`）+ TEXCOORD0 vec2（`0x8`），步长 20（`mdl.ts` 的 `MDL_ATTRIBUTES`）。 */
export const SPRITE_FORMAT = 0x9;

/** sprite 对象：光斑材质的路径（对象 `sprite` 键）。几何与两份 pass 在 `layer.model` 里。 */
export interface SceneSprite {
  material: string;
}

/** 常量网格的顶点字节（每次新建：bundle 交给主线程时会转移网格的缓冲，`transferableBuffers`）。 */
function spriteVertices(): Uint8Array {
  const uvs = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const data = new Float32Array(uvs.flatMap(([u, v]) => [-1, 0, 1, u, v]));
  return new Uint8Array(data.buffer);
}

function spriteIndices(): Uint8Array {
  return new Uint8Array(new Uint16Array([0, 1, 2, 0, 2, 3]).buffer);
}

function spriteMesh(material: string, passes: ScenePass[]): SceneMesh {
  return {
    format: SPRITE_FORMAT,
    stride: 20,
    vertices: spriteVertices(),
    indices: spriteIndices(),
    vertexCount: 4,
    indexFormat: "uint16",
    indexCount: 6,
    material,
    passes,
  };
}

/**
 * sprite 的两网格模型：网格 0 光斑（`body`，sprite 材质的 pass），网格 1 遮挡方块（`occlusion`，occlusiontest 的 pass）。包围盒为空：
 * sprite 不做视锥剔除（WPE 的绘制函数直接画，`FUN_140256780`）。
 */
export function spriteModel(material: string, body: ScenePass[], occlusion: ScenePass[]): SceneModel {
  return {
    path: material,
    version: 0,
    meshes: [spriteMesh(material, body), spriteMesh(OCCLUSION_MATERIAL, occlusion)],
    order: [SPRITE_BODY, SPRITE_OCCLUSION],
    bounds: [],
  };
}
