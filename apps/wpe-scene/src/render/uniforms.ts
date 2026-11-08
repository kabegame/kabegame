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
import type { DrawStep } from "./graph";
import { identity, invert, multiply, normalMatrix, orthographic, scaling, type Mat4 } from "./math";
import type { LayerState } from "./state";

/** 翻译器反射的一格 uniform（`declared` 已并入胶水的 `UniformLayout`，这个名字留作别名）。 */
export type UniformEntry = UniformLayout;

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
  /**
   * 效果矩阵（PLAN P2a「内置 uniform」，w、h 取图层 `size`）：效果 pass 画全屏四边形时
   * `g_EffectModelMatrix` = 图层世界矩阵 × scale(w/2, h/2)、`g_EffectModelViewProjectionMatrix` = 图层 MVP × 同一缩放，
   * 纹理投影与后者相同；上屏 pass 前两者不缩放，纹理投影 = MVP × scale(w/2, h/2)。缺省：前两者同 `model` / `modelViewProjection`，
   * 纹理投影为单位阵（基础 pass）。
   */
  effectModel?: Mat4;
  effectModelViewProjection?: Mat4;
  effectTextureProjection?: Mat4;
  layer: Pick<SceneLayer, "alpha" | "color">;
  /** 颜色系数 k：HDR 下为图层 `brightness`，否则 1（p2-REPORT B10，J5 抓帧证实）。缺省 1。 */
  colorScale?: number;
  /** 按槽位：该 pass 绑定的纹理（场景纹理或合成 RT / fbo / 快照的尺寸）；未绑定为 undefined。 */
  textures: readonly (TextureSize | undefined)[];
  /**
   * 屏幕尺寸：`g_TexelSize` / `g_TexelSizeHalf` / `g_Screen` 用。WPE 取窗口（后备缓冲）尺寸，画合成 RT、fbo 时也不随目标变；
   * 我们取场景目标尺寸，与窗口同分辨率时等价。
   */
  screenSize: [number, number];
  eye: readonly number[];
  ambient?: readonly number[];
  skylight?: readonly number[];
}

type TextureSize = Pick<SceneTexture, "width" | "height" | "textureWidth" | "textureHeight">;

/** 空纹理槽的 `g_Texture<n>Resolution` / `g_Texture<n>Texel`（WPE `FUN_1400d8300`）。 */
const EMPTY_RESOLUTION = [2, 2, 2, 2];
const EMPTY_TEXEL = [0.5, 0.5, 2, 2];

/** 屏幕尺寸相关的内置 uniform：WPE 取窗口尺寸，画合成 RT、fbo、泛光 pass 时也不随目标变（I4）。 */
export function screenBuiltins([width, height]: readonly [number, number]): Record<string, number[]> {
  return {
    g_TexelSize: [1 / width, 1 / height],
    g_TexelSizeHalf: [0.5 / width, 0.5 / height],
    g_Screen: [width, height, width / height],
  };
}

/** 每个槽位的 `g_Texture<n>Resolution` / `g_Texture<n>Texel`；未绑定的槽取空槽值。 */
export function textureBuiltins(textures: readonly (TextureSize | undefined)[]): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  textures.forEach((texture, slot) => {
    values[`g_Texture${slot}Resolution`] = texture
      ? [texture.textureWidth, texture.textureHeight, texture.width, texture.height]
      : EMPTY_RESOLUTION;
    values[`g_Texture${slot}Texel`] = texture
      ? [1 / texture.textureWidth, 1 / texture.textureHeight, texture.textureWidth, texture.textureHeight]
      : EMPTY_TEXEL;
  });
  return values;
}

/** 每帧不变的内置 uniform（变换、纹理分辨率、对象颜色等），取值照 WPE `FUN_1400d8300`（PLAN P2a「内置 uniform」）。 */
export function staticBuiltins(input: StaticBuiltinInput): Record<string, number[]> {
  // g_Color4 = (color · k, alpha)：k 在 HDR 下是 brightness，否则 1（B10）
  const k = input.colorScale ?? 1;
  const color = [(input.layer.color[0] ?? 1) * k, (input.layer.color[1] ?? 1) * k, (input.layer.color[2] ?? 1) * k];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const inverse = (m: Mat4) => Array.from(invert(m) ?? identity);
  const effectModel = input.effectModel ?? input.model;
  const effectMvp = input.effectModelViewProjection ?? input.modelViewProjection;
  const values: Record<string, number[]> = {
    g_ModelViewProjectionMatrix: Array.from(input.modelViewProjection),
    g_ModelViewProjectionMatrixInverse: Array.from(input.modelViewProjectionInverse ?? identity),
    g_ModelMatrix: Array.from(input.model),
    g_ModelMatrixInverse: inverse(input.model),
    g_NormalModelMatrix: normalMatrix(input.model),
    g_ViewProjectionMatrix: Array.from(input.viewProjection),
    g_EffectModelMatrix: Array.from(effectModel),
    g_EffectModelMatrixInverse: inverse(effectModel),
    g_EffectModelViewProjectionMatrix: Array.from(effectMvp),
    g_EffectModelViewProjectionMatrixInverse: inverse(effectMvp),
    g_EffectTextureProjectionMatrix: input.effectTextureProjection
      ? Array.from(input.effectTextureProjection)
      : identity,
    g_EffectTextureProjectionMatrixInverse: input.effectTextureProjection
      ? inverse(input.effectTextureProjection)
      : identity,
    g_EyePosition: [input.eye[0] ?? 0, input.eye[1] ?? 0, input.eye[2] ?? 0],
    g_Brightness: [1],
    g_UserAlpha: [input.layer.alpha],
    g_Alpha: [input.layer.alpha],
    g_Color: color,
    g_Color4: [...color, input.layer.alpha],
    // 没逆向到来源（I4 表里没有），保持 P2a 的取值：对象颜色，不乘 k
    g_CompositeColor: [input.layer.color[0] ?? 1, input.layer.color[1] ?? 1, input.layer.color[2] ?? 1],
    ...screenBuiltins(input.screenSize),
    g_TextureReductionScale: [1],
    // 非 spritesheet 时的恒等帧变换：v = translation + u * rotation.xy + v * rotation.zw
    g_Texture0Rotation: [1, 0, 0, 1],
    g_Texture0Translation: [0, 0],
  };
  if (input.ambient) values.g_LightAmbientColor = [...input.ambient];
  if (input.skylight) values.g_LightSkylightColor = [...input.skylight];
  Object.assign(values, textureBuiltins(input.textures));
  return values;
}

/** `g_Time` 超过 5 天（432000 s）归零（p2-REPORT C「时间」）。 */
export const TIME_WRAP_SECONDS = 432000;

/**
 * 由图层状态算出的内置 uniform：就地刷新时只重写这一组，`pass.uniforms` 里有的名字（材质值，例如 passthrough 的
 * `g_Color4 = (1, 1, 1, 1)`、材质自带的 `g_UserAlpha`）一律不动。
 */
export const LAYER_UNIFORMS: ReadonlySet<string> = new Set([
  "g_ModelViewProjectionMatrix",
  "g_ModelViewProjectionMatrixInverse",
  "g_ModelMatrix",
  "g_ModelMatrixInverse",
  "g_EffectModelMatrix",
  "g_EffectModelMatrixInverse",
  "g_NormalModelMatrix",
  "g_ViewProjectionMatrix",
  "g_EffectModelViewProjectionMatrix",
  "g_EffectModelViewProjectionMatrixInverse",
  "g_EffectTextureProjectionMatrix",
  "g_EffectTextureProjectionMatrixInverse",
  "g_UserAlpha",
  "g_Alpha",
  "g_Color",
  "g_Color4",
  "g_CompositeColor",
]);

/** 环境光 uniform → `GENERAL_FIELDS` 的键：就是字段的原值，没有转换，灯光图层也不改它（L5）。 */
export const LIGHT_UNIFORMS = {
  g_LightAmbientColor: "ambientcolor",
  g_LightSkylightColor: "skylightcolor",
} as const;

/**
 * 各角色的变换（PLAN P2a「内置 uniform」，w、h 取图层 `size`）：作用于 P1 的 `direct` 与合成链的三种角色。
 * `world` 是图层的世界矩阵（`layout.ts` 的 `worldMatrixOf`，沿父链累乘，P4a 步骤 1），下文的「模型矩阵」都是它。
 * - `direct`：P1 原样，`g_ModelViewProjectionMatrix` = 场景视图投影 × 图层世界矩阵；
 * - `base`：正交投影把图层四边形画满合成 RT，单位模型矩阵（B7）；
 * - `effect`：NDC 全屏四边形、MVP 为单位阵；`g_EffectModelMatrix` = 图层世界矩阵 × scale(w/2, h/2)，
 *   `g_EffectModelViewProjectionMatrix` = 图层 MVP × 同一缩放，纹理投影与后者相同；
 * - `final` / `passthrough`：图层四边形用图层 MVP 上屏；效果矩阵不缩放，纹理投影 = MVP × scale(w/2, h/2)。
 */
export function drawMatrices(step: Pick<DrawStep, "role">, world: Mat4, size: readonly number[], viewProjection: Mat4) {
  const model = world;
  const layerMvp = multiply(viewProjection, model);
  const hw = (size[0] ?? 0) / 2,
    hh = (size[1] ?? 0) / 2;
  const half = scaling(hw, hh, 1);
  switch (step.role) {
    case "base": {
      const fill = orthographic(-(hw || 1), hw || 1, -(hh || 1), hh || 1, -FILL_DEPTH, FILL_DEPTH);
      return { modelViewProjection: fill, model: identity(), viewProjection: fill };
    }
    case "effect": {
      const effectMvp = multiply(layerMvp, half);
      return {
        modelViewProjection: identity(),
        model: identity(),
        viewProjection,
        effectModel: multiply(model, half),
        effectModelViewProjection: effectMvp,
        effectTextureProjection: effectMvp,
      };
    }
    case "final":
    case "passthrough":
      return {
        modelViewProjection: layerMvp,
        model,
        viewProjection,
        effectModel: model,
        effectModelViewProjection: layerMvp,
        effectTextureProjection: multiply(layerMvp, half),
      };
    default:
      return { modelViewProjection: layerMvp, model, viewProjection };
  }
}

/** 画进合成 RT 的基础 pass 用的正交深度范围（图层 z 为 0）。 */
const FILL_DEPTH = 10000;

export interface DrawUniformInput {
  step: Pick<DrawStep, "role" | "inputs">;
  /** 图层的当前状态与尺寸（`size` 只在重编译时变）；颜色组取自身的值，不继承。 */
  layer: LayerState & { size: number[] };
  /** 图层的世界矩阵：按同一份状态沿父链算（`layout.ts` 的 `worldMatrixOf`）。 */
  world: Mat4;
  /** 本 pass 的材质常量（`SceneState.constants.get(pass.key)`）。 */
  constants: Record<string, number[]>;
  viewProjection: Mat4;
  /** 颜色系数：HDR 下是图层 `brightness`，否则 1（B10）。 */
  colorScale: number;
  screenSize: [number, number];
  /** 按槽位：该 pass 绑定的纹理尺寸；未绑定为 undefined。 */
  textures: readonly (TextureSize | undefined)[];
  eye: readonly number[];
  ambient?: readonly number[];
  skylight?: readonly number[];
}

/**
 * 图层就地刷新要重写的 uniform 名：由图层状态算出的那组；`pass.uniforms` 里有的一律不动
 * （材质值优先：passthrough 的 `g_Color4`、材质自带的 `g_UserAlpha` 等）。
 */
export function layerRefreshNames(passUniforms: Record<string, number[]>): string[] {
  return [...LAYER_UNIFORMS].filter((name) => !(name in passUniforms));
}

/**
 * 一个绘制步骤的全部静态 uniform：内置值（变换、颜色、纹理尺寸…）打底，材质常量覆盖。
 * `createDraw` 建 draw 与 `GpuScene.sync` 就地刷新共用同一个函数——两边逐字节一致由单测核对（P3a 验收 4）。
 */
export function drawUniformValues(input: DrawUniformInput): Record<string, number[]> {
  const matrices = drawMatrices(input.step, input.world, input.layer.size, input.viewProjection);
  const values = staticBuiltins({
    ...matrices,
    modelViewProjectionInverse: invert(matrices.modelViewProjection),
    layer: input.layer,
    colorScale: input.colorScale,
    textures: input.textures,
    screenSize: input.screenSize,
    eye: input.eye,
    ambient: input.ambient,
    skylight: input.skylight,
  });
  for (const [name, value] of Object.entries(input.constants)) values[name] = [...value];
  return values;
}

/**
 * 粒子路径才写的引擎 uniform（`common_particles.h`，P4a 步骤 4），2026-11-07 RenderDoc 实测，正交与透视场景相同：
 * - 朝向是单位基：`g_OrientationUp (0,1,0)`、`g_OrientationRight (1,0,0)`、`g_OrientationForward (0,0,1)`；
 * - `g_ViewUp`、`g_ViewRight`、`g_RenderVar0/1` 在档 1 的两个着色器（内置 `genericparticle`、`shimmering_particles` 的
 *   项目 `particle`）里都没被读取（`referenced: false`，抓帧里是垃圾值），照语义给。`g_RenderVar0/1` 是帧表、拖尾用的，
 *   属 P4b / P4c，先写 0。
 * `g_EyePosition`、`g_Texture0Resolution`（纹理尺寸，32×32 的 `util/white` 为 `(32, 32, 32, 32)`）走通用的 `staticBuiltins`。
 * 名字与 `compile/features.ts` 的 `PARTICLE_UNIFORMS` 一一对应，单测核对。
 */
export function particleBuiltins(): Record<string, number[]> {
  return {
    g_OrientationUp: [0, 1, 0],
    g_OrientationRight: [1, 0, 0],
    g_OrientationForward: [0, 0, 1],
    g_ViewUp: [0, 1, 0],
    g_ViewRight: [1, 0, 0],
    g_RenderVar0: [0, 0, 0, 0],
    g_RenderVar1: [0, 0, 0, 0],
  };
}

export interface ParticleUniformInput {
  /** 粒子对象的当前状态（颜色组取自身的值，不继承）。 */
  layer: LayerState;
  /** 对象的世界矩阵（`layout.ts` 的 `worldMatrixOf`，沿父链累乘）。 */
  world: Mat4;
  /** 粒子材质 pass 的材质常量（`SceneState.constants.get(pass.key)`）。 */
  constants: Record<string, number[]>;
  /** 正交场景的视图投影，或透视粒子（`flags & 4`）的 `particleViewProjection`。 */
  viewProjection: Mat4;
  colorScale: number;
  screenSize: [number, number];
  textures: readonly (TextureSize | undefined)[];
  eye: readonly number[];
  ambient?: readonly number[];
  skylight?: readonly number[];
}

/**
 * 粒子绘制的全部静态 uniform：`g_ModelViewProjectionMatrix` = 视图投影 × 对象世界矩阵，`g_ModelMatrix` 是世界矩阵
 * （粒子位置在对象空间里）；粒子专用的见 `particleBuiltins`；材质常量覆盖。建 draw 与就地刷新共用，同 `drawUniformValues`。
 */
export function particleUniformValues(input: ParticleUniformInput): Record<string, number[]> {
  const modelViewProjection = multiply(input.viewProjection, input.world);
  const values = staticBuiltins({
    modelViewProjection,
    modelViewProjectionInverse: invert(modelViewProjection),
    model: input.world,
    viewProjection: input.viewProjection,
    layer: input.layer,
    colorScale: input.colorScale,
    textures: input.textures,
    screenSize: input.screenSize,
    eye: input.eye,
    ambient: input.ambient,
    skylight: input.skylight,
  });
  Object.assign(values, particleBuiltins());
  for (const [name, value] of Object.entries(input.constants)) values[name] = [...value];
  return values;
}

export interface FrameInput {
  /** 秒：累加钳过的帧时间（T2，`clock.ts` 的 `FrameClock`），已按 `TIME_WRAP_SECONDS` 回绕。 */
  time: number;
  /** 与上一帧的间隔（秒）：实时帧钳到 `[0.0001, 0.25]`（T2），补画帧为 0。粒子按它步进（P4a 步骤 4）。 */
  frametime: number;
  /** 本地时间在一天中的占比 [0, 1)（`daytimeOf`）。 */
  daytime: number;
  /** 光标在画布上的归一化坐标：原点左上、y 向下。 */
  pointer: [number, number];
  pointerLast: [number, number];
}

/**
 * 每帧变化的内置 uniform。`g_PointerState` = (按下, 按下, 本帧刚按下, 0)：渲染器还不跟踪按键（P6 接输入），恒为 0。
 */
export function frameBuiltins(frame: FrameInput): Record<string, number[]> {
  return {
    g_Time: [frame.time],
    g_Frametime: [frame.frametime],
    g_Daytime: [frame.daytime],
    g_PointerPosition: frame.pointer,
    g_PointerPositionLast: frame.pointerLast,
    g_PointerState: [0, 0, 0, 0],
  };
}

/** 本地时间的一天中占比：h/24 + m/1440 + s/86400 + ms/8.64e7，范围 [0, 1)。 */
export function daytimeOf(date: Date): number {
  return date.getHours() / 24 + date.getMinutes() / 1440 + date.getSeconds() / 86400 + date.getMilliseconds() / 8.64e7;
}
