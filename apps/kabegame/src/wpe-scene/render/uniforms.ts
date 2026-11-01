/**
 * uniform 块打包与内置 uniform。
 *
 * 布局来自翻译器的反射结果（std140，见 `src-tauri/wpesl2wgsl/README.md`「uniform 打包」）：每个成员写在 `offset`；
 * 标量 / 二三分量向量的数组被补成 `vec4` 数组，第 i 个元素在 `offset + i * stride`，只用前几个分量；
 * 矩阵按列存，`mat3` / `mat4` 的列步长 16 字节。值一律是「声明类型的分量按顺序展平」的数组（矩阵按列主序）。
 *
 * 内置 uniform 的取值照 linux-wallpaperengine（GPLv3）`src/WallpaperEngine/Render/Objects/Effects/CPass.cpp`
 * 的 `setupUniforms` / `setupTextureUniforms`；材质常量与用户属性（`pass.uniforms`，编译期已解析）优先于内置值，
 * 与 WPE 着色器的写法一致（例如 `genericimage2` 同时用材质的 `g_UserAlpha` 和对象的 `g_Color4`）。
 */
import type { SceneLayer, SceneTexture } from "../compile/bundle";
import type { UniformLayout } from "../wpesl2wgsl";
import { normalMatrix, type Mat4 } from "./math";

/** 翻译器结果里还带 `declared`（WPESL 声明类型），胶水的类型定义没有列出。 */
export type UniformEntry = UniformLayout & { declared?: string };

type Scalar = "f32" | "i32" | "u32";
interface Shape {
  scalar: Scalar;
  /** 矩阵列数；向量 / 标量为 1。 */
  columns: number;
  /** 每列（向量）分量数。 */
  rows: number;
}

/** 解析 WGSL 类型名：`f32`、`vec3<f32>`、`vec2i`、`mat4x4<f32>`、`array<vec4<f32>, 16>`（取元素类型）。 */
export function parseShape(type: string): Shape {
  const array = /^array<\s*(.+?)\s*,\s*\d+\s*>$/.exec(type.trim());
  const t = (array ? array[1] : type).trim();
  const scalarOf = (s: string | undefined): Scalar =>
    s === "i32" || s === "i" ? "i32" : s === "u32" || s === "u" ? "u32" : "f32";
  let m = /^mat(\d)x(\d)(?:<\s*(\w+)\s*>|([fh]))?$/.exec(t);
  if (m) return { scalar: "f32", columns: Number(m[1]), rows: Number(m[2]) };
  m = /^vec(\d)(?:<\s*(\w+)\s*>|([fiuh]))?$/.exec(t);
  if (m) return { scalar: scalarOf(m[2] ?? m[3]), columns: 1, rows: Number(m[1]) };
  if (t === "bool") return { scalar: "u32", columns: 1, rows: 1 };
  return { scalar: scalarOf(t), columns: 1, rows: 1 };
}

/** WPESL 声明类型的分量数（每个数组元素）：`float` 1、`vec3` 3、`mat4` 16。未知时退回 WGSL 形状。 */
export function declaredComponents(declared: string | undefined, fallback: Shape): number {
  const m = /^(?:[biud]?vec(\d)|mat(\d)(?:x(\d))?|float|int|uint|bool)$/.exec((declared ?? "").trim());
  if (!m) return fallback.columns * fallback.rows;
  if (m[1]) return Number(m[1]);
  if (m[2]) return Number(m[2]) * Number(m[3] ?? m[2]);
  return 1;
}

interface Slot {
  offset: number;
  count: number;
  stride: number;
  shape: Shape;
  columnStride: number;
  components: number;
}

/** 一个 pass 的 uniform 块：按布局把值写进同一块 `ArrayBuffer`，整块交给 `queue.writeBuffer`。 */
export class UniformBlock {
  readonly data: ArrayBuffer;
  private readonly f32: Float32Array;
  private readonly i32: Int32Array;
  private readonly u32: Uint32Array;
  private readonly slots = new Map<string, Slot>();

  constructor(layout: readonly UniformEntry[], blockSize = 0) {
    let size = blockSize;
    for (const entry of layout) {
      const shape = parseShape(entry.type);
      const count = entry.array ?? 1;
      const stride = entry.stride ?? entry.size;
      const elementSize = count > 1 ? stride : entry.size;
      // mat2 在 std140 下列步长 16，WGSL 自然布局为 8：按元素大小判断
      const columnStride = shape.columns > 1 ? Math.max(4 * shape.rows, Math.floor(elementSize / shape.columns)) : 0;
      this.slots.set(entry.name, {
        offset: entry.offset,
        count,
        stride,
        shape,
        columnStride: shape.rows === 3 ? 16 : columnStride,
        components: declaredComponents(entry.declared, shape),
      });
      size = Math.max(size, entry.offset + (count > 1 ? stride * count : entry.size));
    }
    this.data = new ArrayBuffer(Math.max(16, Math.ceil(size / 16) * 16));
    this.f32 = new Float32Array(this.data);
    this.i32 = new Int32Array(this.data);
    this.u32 = new Uint32Array(this.data);
  }

  has(name: string): boolean {
    return this.slots.has(name);
  }

  /** 写一个成员；值不足的分量保持原值（初始为 0），多余的忽略。 */
  set(name: string, values: ArrayLike<number>): void {
    const slot = this.slots.get(name);
    if (!slot) return;
    const { shape } = slot;
    const view = shape.scalar === "i32" ? this.i32 : shape.scalar === "u32" ? this.u32 : this.f32;
    const perElement = slot.components;
    for (let element = 0; element < slot.count; element++) {
      const base = slot.offset + element * slot.stride;
      const start = element * perElement;
      if (start >= values.length) break;
      if (shape.columns > 1) {
        for (let c = 0; c < shape.columns; c++)
          for (let r = 0; r < shape.rows; r++) {
            const value = values[start + c * shape.rows + r];
            if (value !== undefined) view[(base + c * slot.columnStride + r * 4) >> 2] = value;
          }
      } else {
        const n = Math.min(perElement, shape.rows);
        for (let k = 0; k < n; k++) {
          const value = values[start + k];
          if (value !== undefined) view[(base + k * 4) >> 2] = shape.scalar === "f32" ? value : Math.trunc(value);
        }
      }
    }
  }
}

export interface StaticBuiltinInput {
  modelViewProjection: Mat4;
  modelViewProjectionInverse: Mat4 | null;
  model: Mat4;
  viewProjection: Mat4;
  layer: Pick<SceneLayer, "alpha" | "color">;
  /** 按槽位：该 pass 绑定的场景纹理；未绑定为 undefined。 */
  textures: readonly (Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight"> | undefined)[];
  sceneSize: [number, number];
  eye: readonly number[];
  ambient?: readonly number[];
  skylight?: readonly number[];
}

/** 每帧不变的内置 uniform（变换、纹理分辨率、对象颜色等）。 */
export function staticBuiltins(input: StaticBuiltinInput): Record<string, number[]> {
  const [width, height] = input.sceneSize;
  const color = [input.layer.color[0] ?? 1, input.layer.color[1] ?? 1, input.layer.color[2] ?? 1];
  const mvp = Array.from(input.modelViewProjection);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const values: Record<string, number[]> = {
    g_ModelViewProjectionMatrix: mvp,
    g_EffectModelViewProjectionMatrix: mvp,
    g_ModelViewProjectionMatrixInverse: Array.from(input.modelViewProjectionInverse ?? identity),
    g_ModelMatrix: Array.from(input.model),
    g_EffectModelMatrix: Array.from(input.model),
    g_NormalModelMatrix: normalMatrix(input.model),
    g_ViewProjectionMatrix: Array.from(input.viewProjection),
    g_EffectTextureProjectionMatrix: identity,
    g_EffectTextureProjectionMatrixInverse: identity,
    g_EyePosition: [input.eye[0] ?? 0, input.eye[1] ?? 0, input.eye[2] ?? 0],
    g_Brightness: [1],
    g_UserAlpha: [input.layer.alpha],
    g_Alpha: [input.layer.alpha],
    g_Color: color,
    g_Color4: [...color, input.layer.alpha],
    g_CompositeColor: color,
    g_TexelSize: [1 / width, 1 / height],
    g_TexelSizeHalf: [0.5 / width, 0.5 / height],
    g_TextureReductionScale: [1],
    // 非 spritesheet 时的恒等帧变换：v = translation + u * rotation.xy + v * rotation.zw
    g_Texture0Rotation: [1, 0, 0, 1],
    g_Texture0Translation: [0, 0],
  };
  if (input.ambient) values.g_LightAmbientColor = [...input.ambient];
  if (input.skylight) values.g_LightSkylightColor = [...input.skylight];
  input.textures.forEach((texture, slot) => {
    if (texture)
      values[`g_Texture${slot}Resolution`] = [
        texture.textureWidth,
        texture.textureHeight,
        texture.width,
        texture.height,
      ];
  });
  return values;
}

export interface FrameInput {
  /** 秒。 */
  time: number;
  /** 一天中的位置 0…1（LWE：`(时 * 60 + 分) / 1440`）。 */
  daytime: number;
  pointer: [number, number];
  pointerLast: [number, number];
}

/** 每帧变化的内置 uniform。 */
export function frameBuiltins(frame: FrameInput): Record<string, number[]> {
  return {
    g_Time: [frame.time],
    g_Daytime: [frame.daytime],
    g_PointerPosition: frame.pointer,
    g_PointerPositionLast: frame.pointerLast,
  };
}

export function daytimeOf(date: Date): number {
  return (date.getHours() * 60 + date.getMinutes()) / (24 * 60);
}
