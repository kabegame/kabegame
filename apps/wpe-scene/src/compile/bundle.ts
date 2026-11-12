import { compileBloom, type SceneBloom } from "./bloom";
import {
  BindingCollector,
  GENERAL_FIELDS,
  generalDefaults,
  generalValue,
  isScriptValue,
  isUserBinding,
  type BindingTarget,
  type GeneralKey,
  type GeneralValues,
  type LayerField,
  type RecompileReason,
  type SceneBinding,
  type TargetKey,
} from "./bindings";
import { conditionsHold, removedFbos } from "./conditions";
import { normalizeScenePath, SceneFs, type ResourceScope, type SceneReader } from "./fs";
import { resolveParents } from "./hierarchy";
import { meshDrawOrder, meshSkin, parseMdl, type MdlFile, type MdlMesh } from "./mdl";
import { constantTargetFields, materialSlots } from "./materialValues";
import { bindingReader, engineDefines, lightConfigIssues, lightCounts, lightUniforms, litDefines } from "./lights";
import {
  checkEffectFeatures,
  checkInstanceFeatures,
  checkMdlFeatures,
  checkMeshAttributes,
  checkModelFeatures,
  checkParticleFeatures,
  checkParticleInstance,
  checkParticleProgram,
  checkPassFeatures,
  checkProgramFeatures,
  checkSceneFeatures,
  checkScriptFeatures,
  EFFECT_UNIFORMS,
  effectNeedsFramebuffer,
  GROUP_CHILD_FRAMEBUFFER,
  groupChildIssues,
  isSoundObject,
  isTextObject,
  modelFlag,
  objectKind,
  PARTICLE_UNIFORMS,
  TEXT_UNIFORMS,
  usesLighting,
} from "./features";
import {
  currentProperties,
  numbers,
  parseEffect,
  parseMaterial,
  parseModel,
  parseProject,
  parseScene,
  parseWpeJson,
  textureName,
  type EffectFboJson,
  type JsonObject,
  type MaterialPass,
  type ModelJson,
  type SceneEffectInstance,
  type SceneObject,
  type SceneScalar,
  type SceneValue,
} from "./model";
import {
  isOrthographic,
  isRopeRenderer,
  MAX_CHILD_DEPTH,
  parseParticle,
  parseParticleChildEntry,
  particleFov,
  readParticleSystem,
  sceneVersionOf,
  type InstanceKey,
  type ParticleRenderer,
  type RopeRenderer,
  type RopeTrailRenderer,
  type SceneParticle,
} from "./particles";
import {
  bloomParams,
  flagValue,
  readWpePostprocessing,
  resolvePostprocessLevel,
  scenePostprocessState,
  type BloomParams,
  type ScenePostprocessSetting,
  type ScenePostprocessState,
} from "./postprocess";
import { ShaderCompiler, shaderUniforms, type ShaderTextureSlot } from "./shader";
import { collectScripts, type SceneScripts } from "./scripts";
import { compileSound, type SceneSound } from "./sounds";
import { compileText, type HostPassCompiler, type SceneText } from "./texts";
import { ANIMATION_ISSUE, FBO_FORMATS, freeImageTextureSize, parseTex, TEX_FLAGS, type TexResult } from "./tex";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";
import { particleUsesAudio } from "../particles/audio";

export interface SceneGeneral {
  width: number;
  height: number;
  /** `GENERAL_FIELDS` 的生效值，`SceneState.general` 的起始值。 */
  fields: GeneralValues;
  /** 清屏当前关着，或绑了属性、挂了脚本：加载就建第二张场景目标（L11）。 */
  clearVariable: boolean;
  /** 本次编译解析出的后处理档位与场景实际的泛光 / HDR 状态（`postprocess.ts`）。 */
  postprocess: ScenePostprocessState;
  /** 场景的泛光参数（缺键已补 WPE 默认值，原值未换算）；泛光关着时也给出，渲染器只在 `bundle.bloom` 存在时用。 */
  bloom: BloomParams;
  /**
   * 透视粒子（系统 `flags & 4`）的 fov，弧度：`general.perspectiveoverridefov` 缺省 95 度、钳到 [0.1, 179.9] 度
   * （`rea-p4a.md` C4，实测核对过）。P4a 步骤 4 用。
   */
  perspectiveOverrideFov: number;
}
export interface SceneMip {
  width: number;
  height: number;
  /** 原始像素或 BC 块（Worker 解出）。 */
  bytes?: Uint8Array;
  /** FreeImage 形态由主线程解码（`decode.ts`），跨重新编译缓存。 */
  bitmap?: ImageBitmap;
}
export interface SceneTexture {
  path: string;
  source: string;
  format: number;
  /** 图像尺寸（头里的 `width` / `height`）。 */
  width: number;
  height: number;
  /** 纹理尺寸：`g_Texture<n>Resolution.xy`、UV 上界的分母，渲染器按它建 GPU 纹理（FreeImage 见 `freeImageTextureSize`）。 */
  textureWidth: number;
  textureHeight: number;
  flags: number;
  clampUVs: boolean;
  noInterpolation: boolean;
  /** unsupported 非空时可能为空：编译器只读头部，不解码 mip；FreeImage 形态在主线程解码后才填。 */
  mips: SceneMip[];
  /** FreeImage 形态的 mip 位置（PNG / JPG 原文件），见 `TexResult.encoded`。 */
  encoded?: TexResult["encoded"];
  videoRange?: { start: number; end: number };
  /** 头标志 bit2（帧表）置位、帧表非空时有（`spriteSheet`）。只有粒子材质的槽 0 用它（P4b 步骤 2）。 */
  sheet?: SceneSpriteSheet;
}
/**
 * 粒子帧表（rea-p4b-render.md 2.2，`FUN_1402366f0`）：粒子路径只用第 0 帧的宽、高和帧数，`x`、`y`、`frametime`、`imageId`
 * 都不读；帧号的网格换算在着色器里（`ComputeSpriteFrame`）。渲染器原样写进 `g_RenderVar1`。
 */
export interface SceneSpriteSheet {
  /**
   * `(帧宽 / W, 帧高 / H, 帧数, (纹理高 / 纹理宽) · ((帧高 / H) / (帧宽 / W)))`，W、H 是第 0 帧所在图像的第 0 级 mip，
   * 纹理宽高是 `SceneTexture.textureWidth / textureHeight`。float32。
   */
  renderVar1: [number, number, number, number];
  /** 图像宽 < 纹理宽（只比宽度，WPE 同）→ `SPRITESHEETBLENDNPOT`。 */
  npot: boolean;
}

/**
 * 帧表纹理的 `SceneSpriteSheet`；不是帧表或帧表为空时为 undefined（空帧表由 `parseTex` 报 `tex:animation:empty`）。
 * `textureWidth` / `textureHeight` 是 bundle 里的纹理尺寸（FreeImage 形态已按 `freeImageTextureSize` 改成图像尺寸，
 * 同 WPE 在解码前改头字段）。
 */
export function spriteSheet(
  tex: Pick<TexResult, "frames" | "width">,
  textureWidth: number,
  textureHeight: number,
): SceneSpriteSheet | undefined {
  const first = tex.frames?.[0];
  if (!first) return undefined;
  const f32 = Math.fround;
  const ratio = f32(f32(textureHeight) / f32(textureWidth));
  return {
    renderVar1: [first.width, first.height, f32(tex.frames!.length), f32(ratio * f32(first.height / first.width))],
    npot: tex.width < textureWidth,
  };
}

/** 粒子材质宏要的系统描述（`readParticleSystem` 的两项，加上绘制用的 renderer）。 */
export interface ParticleSheetSystem {
  flags: number;
  animationMode: "sequence" | "randomframe";
  /**
   * 系统的 renderer（`SceneParticle.renderer` 的种类与朝向模式，P4c 步骤 5）：拖尾写 `THICKFORMAT`、`TRAILRENDERER`
   * （`particleRendererDefines`），非厚格式 sprite 的非 screen 朝向决定 `TEX0FORMAT`（`particleTex0Format`）。缺省是 screen 朝向的 sprite。
   * rope（P4d 步骤 1）另带 `subdivision`（`TRAILSUBDIVISION`），着色器换成 `ROPE_SHADER`。ropetrail（P4d 步骤 2）同样换着色器，
   * 另带细分与三个开关（`TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE`）。
   */
  renderer?: {
    kind: ParticleRenderer["kind"];
    orientation: Pick<ParticleRenderer["orientation"], "mode">;
    rope?: Pick<RopeRenderer, "subdivision"> | null;
    ropetrail?: Pick<RopeTrailRenderer, "subdivision" | "scrolling" | "fadeAlpha" | "fadeSize"> | null;
  };
}

/**
 * rope 两类的着色器（rea-p4d-rope.md 第 6 节）：`FUN_140150110` 把 `{"shader": "genericropeparticle"}` 递归覆盖进材质 pass
 * （`0x1401505f4`–`0x14015068f`），所以材质写了别的着色器也换掉；blending、深度、纹理、常量照旧取材质，`combos` 合并、变体宏优先。
 * WPE 恒定义 `GS_ENABLED`，`.geom` 按同名另读（`0x140162cb7`）：翻译时带 `geometry`。
 */
export const ROPE_SHADER = "genericropeparticle";

/**
 * renderer 的宏（`FUN_1401d2340` 的 renderer 分发，`0x1401d2590`，rea-p4c-render.md 6.2）：`spritetrail` 分支
 * （`0x1401d2c02`–`0x1401d2f78`）写 `THICKFORMAT = 1`（`0x1401d2c6d`）、`TRAILRENDERER = 1`（`0x1401d2cf6`），有帧表时再照
 * sprite 厚格式的写法加 `SPRITESHEET*`（`particleSheetDefines`）。sprite 不写 renderer 宏（朝向不进宏，7.8）。只支持系统里一个
 * renderer（多个报 `particle:renderers`）。
 * rope 分支（`0x1401d29e1`–`0x1401d2bfd`，rea-p4d-rope.md 3.4）：无条件 `THICKFORMAT = 1`，`TRAILSUBDIVISION = subdivision`，
 * `ORIENTATION = 朝向模式`（`0x1401d2b3e`，值为 0 也写）；`TEX0FORMAT` 只在格式 8–11 时写（`particleTex0Format` 的厚格式一支），
 * 不写 `SPRITESHEET*`（`particleDefines` 跳过帧表宏）。
 * ropetrail 分支（`0x1401d25b7`–`0x1401d29dc`，同 3.4，P4d 步骤 2）：`TRAILSUBDIVISION = subdivision`、`ORIENTATION = 朝向模式`
 * （`0x1401d271b`）、`TRAILRENDERER = 1`；系统 flags `0x80000`（`uvscrolling`）时 `TRAILSCROLLALPHA = 1`，`rec+0x48` bit0 / bit1 时
 * `TRAILFADEALPHA = 1` / `TRAILFADESIZE = 1`（不看 `uvscrolling`，着色器只在滚动分支读，实测 T3）。**不写 `THICKFORMAT`**（非厚格式，
 * 76 字节一段）、不写 `SPRITESHEET*`；`TEX0FORMAT` 同 rope 只看 8–11。
 */
export function particleRendererDefines(system: ParticleSheetSystem): Record<string, string> {
  const renderer = system.renderer;
  if (renderer?.kind === "spritetrail") return { THICKFORMAT: "1", TRAILRENDERER: "1" };
  if (renderer?.kind === "rope")
    return {
      THICKFORMAT: "1",
      TRAILSUBDIVISION: String(renderer.rope?.subdivision ?? 0),
      ORIENTATION: String(renderer.orientation.mode),
    };
  if (renderer?.kind === "ropetrail") {
    const trail = renderer.ropetrail;
    return {
      TRAILSUBDIVISION: String(trail?.subdivision ?? 0),
      ORIENTATION: String(renderer.orientation.mode),
      TRAILRENDERER: "1",
      ...(trail?.scrolling ? { TRAILSCROLLALPHA: "1" } : {}),
      ...(trail?.fadeAlpha ? { TRAILFADEALPHA: "1" } : {}),
      ...(trail?.fadeSize ? { TRAILFADESIZE: "1" } : {}),
    };
  }
  return {};
}

/**
 * 粒子路径要写的 `TEX0FORMAT` 值（rea-p4b-render.md 2.4，`FUN_1401d2340`）；不写时为 undefined。
 * - 厚格式（拖尾，或槽 0 是帧表）：只在格式 8–11 时写（`particleWritesTex0Format`，拖尾分支 `0x1401d2ed1`）；
 * - 非厚格式的 sprite：格式 8–11，**或者朝向不是 screen**（`movzx eax, r8b; or eax, [rdi + 0xc]`，`0x1401d3189`）时写，值是格式本身
 *   （不在 8–11 的格式不影响画面：`ConvertTexture0Format` 只认 RG88、RG1616F、R8、R16F），否则直接用基础材质。
 * WPE 在槽 0 没有纹理时格式取 0（`0x1401d2513`），我们取不到格式（槽 0 是 `_rt_*`、注解也没有缺省）时不写，语料里没有这种写法。
 */
export function particleTex0Format(
  format: number | undefined,
  thick: boolean,
  system: ParticleSheetSystem,
): number | undefined {
  if (format === undefined) return undefined;
  const oriented = !thick && (system.renderer?.orientation.mode ?? 0) !== 0;
  return oriented || particleWritesTex0Format(format) ? format : undefined;
}

/**
 * 粒子材质槽 0 是帧表纹理时的宏（`FUN_1401d2340`，rea-p4b-render.md 2.4）：`SPRITESHEET` 只在厚格式分支写，一定伴随
 * `THICKFORMAT`；混帧在系统 `flags` 有 bit1 或 `randomframe`（WPE 解析时顺带置 bit1）时关；`SPRITESHEETBLENDNPOT` 只比宽度。
 * 值为 0 的宏也写键：`genericparticle` 全用 `#if`，结果相同；项目自定义着色器若用 `#ifdef`，照写才和 WPE 一致。
 * 没有帧表时返回空对象，粒子材质的宏与缓存键和步骤 1 逐字相同。
 */
export function particleSheetDefines(
  sheet: SceneSpriteSheet | undefined,
  system: ParticleSheetSystem,
): Record<string, string> {
  if (!sheet) return {};
  const blend = (system.flags & 2) === 0 && system.animationMode !== "randomframe";
  return {
    THICKFORMAT: "1",
    SPRITESHEET: "1",
    SPRITESHEETBLEND: blend ? "1" : "0",
    SPRITESHEETBLENDNPOT: sheet.npot ? "1" : "0",
  };
}
export interface ScenePass {
  /** 本 pass 的稳定键（基础材质 `objects/<i>/passes/<k>`、effect `objects/<i>/effects/<j>/passes/<k>`、`objects/<i>/passthrough`、`bloom/<pass>`）。 */
  key: TargetKey;
  program: number | null;
  blending: string;
  cullmode: string;
  depthtest: string;
  depthwrite: string;
  /** 槽位 → bundle 纹理。 */
  textures: Record<number, number>;
  /** 运行时提供的槽位：`_rt_FullFrameBuffer`（场景快照）或本 effect 的 fbo 名（材质 textures 或着色器注解默认值写的）。 */
  runtime: Record<number, string>;
  uniforms: Record<string, number[]>;
  /** 是否需要 `_rt_FullFrameBuffer` 快照（`needsFramebuffer`，决定快照时机）。 */
  framebuffer: boolean;
}
/** effect.json 的一张 fbo（B6）；尺寸由渲染图按图层合成 RT 算（`render/graph.ts` 的 `fboSize`）。 */
export interface SceneFbo {
  name: string;
  /** `FBO_FORMATS` 的键；`*_backbuffer` 已按 LDR / HDR 换算，不认识的按 `rgba8888`。 */
  format: string;
  scale: number;
  width?: number;
  height?: number;
  fit?: number;
  unique: boolean;
  /**
   * 创建后清成该色（`"r g b a"`，要解析出 4 个数才生效，rea-p7d-fluid 第 2 节第 5 条）；缺省为全 0（WebGPU 纹理本来就是 0）。
   */
  clear?: number[];
  repeat: boolean;
}
export type SceneEffectStep =
  | {
      kind: "draw";
      pass: ScenePass;
      /** 本 effect 的 fbo 名；null = 合成链。 */
      target: string | null;
      /** `compose: true`：写进合成 ping-pong（B6）。 */
      compose: boolean;
      /** `bind[]`；null 时槽 0 = 上一步输出。 */
      binds: { name: string; index: number }[] | null;
    }
  | { kind: "copy"; source: string; target: string }
  | { kind: "swap"; source: string; target: string };
/** 编进 bundle 的 effect：启用的，以及关着但可见性可能变的（`visibleBound`）。写死关闭、没有绑定的不进 bundle（B11）。 */
export interface SceneEffect {
  /** 图层 `effects[]` 里的下标（scene.json 的稳定坐标；bundle 下标会随不进 bundle 的 effect 移位）。 */
  source: number;
  id: number;
  name: string;
  file: string;
  fbos: SceneFbo[];
  steps: SceneEffectStep[];
  /** 当前是否启用。渲染图只看启用的 */
  enabled: boolean;
  /** `visible` 绑了用户属性或脚本：运行时可能变 */
  visibleBound: boolean;
  /** 本 effect 自己的不支持项：启用的已并入场景级，关着的打开时才生效 */
  unsupported: string[];
}
export interface SceneLayer {
  id: number;
  /** scene.json 的 `objects` 下标（稳定键；`layers` 下标会随被跳过的对象移位）。 */
  object: number;
  /**
   * 父对象的 `objects` 下标（`hierarchy.ts` 的 `resolveParents`）；根节点为 null。世界矩阵沿父链累乘、`visible` 沿父链继承
   * （`render/layout.ts`），`alpha`、`color`、`brightness` 不继承。父可能排在子后面。
   */
  parent: number | null;
  name: string;
  origin: number[];
  scale: number[];
  angles: number[];
  size: number[];
  alpha: number;
  color: number[];
  /** 对象 `brightness`（默认 1）：只在 HDR 下乘进 `g_Color4` / `g_Color`（B10），LDR 下不生效。 */
  brightness: number;
  visible: boolean;
  /** `visible` 绑了用户属性（含 condition）：运行时可能变，当前不可见也要建 GPU 资源（P3a）。 */
  visibleBound: boolean;
  /**
   * 视差深度（P5a 步骤 2），两个分量：缺键 (1, 1)（WPE 基础构造写 1.0，rea-p5-camera.md 6.3；`p5a-static` 不写该键的方块按 (1, 1)
   * 移动）。绘制时只用根对象的值（`render/parallax.ts`），子对象自己的不参与；只在 `general.cameraparallax` 打开时起作用。
   */
  parallaxDepth: number[];
  /**
   * 模型 `solidlayer`（只认 JSON true）：上屏（直接上屏与末 pass）不内缩（WPE `+0x304 & 0x200`）；不是 `instanced` 时合成 RT 还按
   * `size`、不看纹理（B5 `FUN_1402091e0`）。P5b 步骤 5 起不再排除 instanced（rea-p5-modelflags，p5-REPORT `p5b-inst2`）。
   */
  solidLayer: boolean;
  /**
   * 模型 `instanced`（只认 JSON true，P5b 步骤 5，p5-REPORT `p5b-inst`、`p5b-inst2`）：编辑器的「纯色图层」。对象的 `instance` 在编译材质
   * 前覆盖 pass 的 `combos` 与 `textures`；合成 RT 按槽 0 纹理的图像尺寸，不按 `size`（`render/graph.ts` 的 `compositeSize`）。
   * 没有图像模型的图层为 false。
   */
  instanced: boolean;
  /**
   * 模型 `nopadding`（只认 JSON true，P5b 步骤 1）：直接上屏的四边形不内缩，带 effect 时末 pass 照旧内缩（p5-REPORT `p5b-nopad`）。
   * 没有图像模型的图层为 false。
   */
  noPadding: boolean;
  /**
   * 对象 `perspective`（只认 JSON true，只在图像层上，P5b 步骤 1）：画到场景目标的绘制换成透视视图投影（`render/scene.ts`，
   * p5-REPORT `p5b-persp`）。模型对象同样取（P5c 步骤 1，`p5c-matrix` 实测和透视图层同一套，绘制在步骤 2）。粒子、分组、声音等
   * 图层为 false。
   */
  perspective: boolean;
  /**
   * 模型 `passthrough`（只认 JSON true，P5b 步骤 2）：组合层（composelayer、projectlayer 等）。基础 pass 见 `copyBackground`；
   * 合成 RT 按 `size`、上屏不内缩；没有启用的 effect、`colorBlendMode` 是 0 / 31、没有子层时整层不画（`render/graph.ts`，p5-REPORT
   * `p5b-cl`）。带子层的是「组」（步骤 4，`subtree` 非空）：子孙由它画进合成 RT。fullscreenlayer 同时是 `fullscreen`，基础 pass 换成
   * 拷贝（步骤 3）。没有图像模型的图层为 false。
   */
  passthroughModel: boolean;
  /**
   * 替它作画的组（P5b 步骤 4，p5-REPORT `p5b-grp-*`、`p5b-nest`、`p5b-grpptc`）：父链上最近的组合层祖先的 `objects` 下标，顶层图层为
   * null。非空时顶层循环跳过它，由组在 `subtree` 步骤里画进组的合成 RT（`render/scene.ts`）；画到「场景」的绘制改用组的局部正交。
   * 嵌套组自己也有 `group`（外层组）。`assignGroups` 在全部对象编完之后填。
   */
  group: number | null;
  /**
   * 组代画的图层（P5b 步骤 4，rea-p5-modelflags §2.2 `FUN_1401eca70` 的先序）：按先序展开子孙，每个节点的子层按 `objects` 下标
   * （WPE 的加载顺序）；遇到嵌套组只收这个组本身，它的子孙由它自己画。不是组（不是组合层或没有子层）时为空。含没有 pass 的对象
   * （分组节点、声音等），渲染器跳过没有资源的。`assignGroups` 填。
   */
  subtree: number[];
  /**
   * 组的上屏 pass（P5b 步骤 4，p5-REPORT `p5b-grp-nofx` / `nofx0`）：没有启用的 effect、colorBlendMode ∈ {0, 31} 时用它把合成 RT
   * 画到世界四边形上。材质是 WPE 的 `effectpassthrough`（`passthroughMaterial`，场景 `version` > 2 用 `_4`），`BLENDMODE` 0，槽 0
   * 由渲染图填合成 RT，`g_Color4` 置 (1, 1, 1, 1)（实测 `采样 × g_Color4`、`g_Color4` = 1）。有子层的组合层才编（effect 运行时
   * 可能全关），其余为 null。
   */
  groupUpload: ScenePass | null;
  /**
   * 模型 `fullscreen`（只认 JSON true，P5b 步骤 3，p5-REPORT `p5b-fs`、`p5b-fsnofx`、`p5b-fsmvp`）：几何一律是 2×2 的 NDC 四边形
   * （`size` 固定为 (2, 2)，排在 `imageLayerSize` 之前）。直接上屏时 MVP 照常（场景视图投影 · 视差 · W），着色器乘不乘 MVP 决定铺不铺满；
   * 走合成路径时不画基础材质、合成 RT 0 拷贝当前画面（快照），上屏与 effect pass 用单位阵加 NDC 正交，`origin` / `scale` / `angles`、
   * 视差、抖动都不起作用（`render/graph.ts`、`render/scene.ts`）。没有图像模型的图层为 false。
   */
  fullscreen: boolean;
  /**
   * fullscreen 图层的合成 RT 尺寸（P5b 步骤 3）：槽 0 是静态纹理时取它的图像尺寸；槽 0 是运行时 RT（fullscreenlayer 的
   * `_rt_FullFrameBuffer`）或没有纹理时取场景尺寸 `[general.width, general.height]`（WPE 取窗口尺寸，我们离屏按场景分辨率渲染，
   * 对应的就是场景目标；p5-REPORT「`_rt_FullFrameBuffer` 的尺寸」）。不除纹理降级系数。非 fullscreen 为 null，合成 RT 照
   * `compositeSize` 的旧规则。
   */
  fullscreenSize: [number, number] | null;
  /**
   * 对象 `copybackground`（缺省 true，只有 JSON false 才关，P5b 步骤 2）：组合层的基础 pass 用基础材质（composelayer 着色器）把层
   * 背后的快照铺进合成 RT；关掉时不画基础材质、合成 RT 0 清成 (0, 0, 0, 0)（`p5b-cl` 的 CL2）。只对组合层起作用，别的图层上中性。
   */
  copyBackground: boolean;
  /** 基础材质的 pass。 */
  passes: ScenePass[];
  /** 0 普通；31 上屏改 additive；其它值走 passthrough（B7 / B8）。 */
  colorBlendMode: number;
  effects: SceneEffect[];
  /** colorBlendMode ∉ {0, 31} 时的上屏 pass（`PASSTHROUGH_MATERIAL`）。 */
  passthrough: ScenePass | null;
  /**
   * 粒子对象解析出的粒子系统（`particles.ts`）；其它对象、或粒子 JSON 读不到时为 null。粒子材质的 pass 在
   * `particle.passes` 里，不在上面的 `passes`（步骤 4 才接绘制）。
   */
  particle: SceneParticle | null;
  /**
   * 文本对象的文本表（P6b 1d，`texts.ts`）：字段、主字体、四个宿主材质的 pass、背景色；排版在宿主主线程（`text/host.ts`）。文本图层的
   * `passes` 为空，基础 pass 由渲染图按文本表排（`render/graph.ts` 的 `text` 步骤），effect 与 passthrough 照图像层。其它对象，或
   * 读不到字体材质时为 null；可选只是为了不动各处手写的测试图层，读的地方按 null 处理。
   */
  text?: SceneText | null;
  /**
   * 模型对象的静态网格（P5c 步骤 1，`compileModel`）；其它对象、`model` 不是字符串或 mdl 读不到时为 null。网格材质的 pass 在
   * `model.meshes[m].passes` 里，不在上面的 `passes`。绘制在步骤 2 接上，之前另报 `model:pending`。可选同 `text`：不动各处手写的
   * 测试图层，读的地方按 null 处理。
   */
  model?: SceneModel | null;
}
/** 模型的一个网格（P5c 步骤 1）：mdl 里的顶点 / 索引字节原样交给渲染器，不在 CPU 上重排。 */
export interface SceneMesh {
  /** 顶点格式（`mdl.ts` 的 `MDL_ATTRIBUTES` 的位），属性的偏移按表序算（`meshAttributes`）。 */
  format: number;
  stride: number;
  /** mdl 文件缓冲上的视图（不拷贝；`transferableBuffers` 带上整个文件缓冲）。 */
  vertices: Uint8Array;
  indices: Uint8Array;
  vertexCount: number;
  indexFormat: "uint16" | "uint32";
  indexCount: number;
  /** 按 `skin` 选中的材质路径与它的 pass（语料都是一个 pass，多于一个报 `mdl:material-passes`）。 */
  material: string;
  passes: ScenePass[];
}
/** 模型对象（P5c 步骤 1，rea-p5-mesh 第 2 节）。 */
export interface SceneModel {
  /** 对象的 `model` 路径。 */
  path: string;
  version: number;
  meshes: SceneMesh[];
  /** 绘制顺序（网格下标，`meshDrawOrder`：不透明的在前，MSVC `std::sort`）。 */
  order: number[];
  /** 视锥剔除用的包围盒并集（`MdlFile.bounds`，min xyz、max xyz；v < 17 是 ±131072，等于不剔）。 */
  bounds: number[];
}
export interface SceneBundle {
  general: SceneGeneral;
  layers: SceneLayer[];
  programs: TranslateResult[];
  textures: SceneTexture[];
  /**
   * 泛光链（`bloom.ts`）；档位关闭、场景没有对象，或 `general.bloom` 写死 false（没绑属性、没挂脚本）时为 null，渲染路径与 P2a 相同。
   * 有链不等于开着：当前开不开看 `SceneState.bloomEnabled`，关着时渲染路径同样与 P2a 相同。
   */
  bloom: SceneBloom | null;
  /** 非空时渲染器必须回退预览图，不能用可能缺少 mip 的 textures 渲染。 */
  unsupported: string[];
  /**
   * 属性绑定表（P3a）：编译期每处解析 `{user}` 的地方登记一条，宿主按它把属性增量分成就地写与重编译。
   * 按登记顺序；同一属性可以有多条。
   */
  bindings: SceneBinding[];
  scripts: SceneScripts;
  /**
   * 声音表（P6a 步骤 1，`sounds.ts`）：每个声音对象一条，按 `objects` 顺序。声音对象在 `layers` 里另有一个没有 pass 的图层；
   * 播放由宿主按它排期（`audio/`），渲染器不读。`compileScene` 总会给出；可选只是为了不动各处手写的测试 bundle，读的地方按空表处理。
   */
  sounds?: SceneSound[];
  /**
   * 场景用音频（P4e 步骤 4）：`project.json` 的 `general.supportsaudioprocessing` 是 JSON `true`（WPE 只认 bool 真，`FUN_14010d100`，
   * rea-p4e-audio.md 4.1），且有粒子系统（含子系统）带 `audioprocessingmode ≠ 0` 的模块（`particleUsesAudio`）。为真时宿主加载就订阅
   * `WpeMediaHub`（脚本注册音频缓冲时另外照旧订阅）。`compileScene` 总会给出；可选只是为了不动各处手写的测试 bundle，缺省按 false。
   */
  audio?: boolean;
}
export interface CompileSceneInput {
  projectDir: string;
  sceneAssets: string[];
  userProperties?: Record<string, unknown>;
  /** 脚本写入的重编译目标，按 scene.json 坐标覆盖编译输入。 */
  scriptOverrides?: Record<string, number[] | boolean>;
  reader: SceneReader;
  translator: Wpesl2wgsl | null;
  /** 设置「场景后处理」；缺省跟随 WPE。 */
  postprocess?: ScenePostprocessSetting;
  /** dev 强制渲染：有不支持项也照常解码 mip，好让渲染器画出半成品（D4）。 */
  force?: boolean;
  /**
   * 列全所有不支持项（语料统计、诊断用）。缺省时一旦确定要退回预览图就不再编译后面的图层：退回的场景越早出结果，
   * 预览图越早显示（翻译工坊场景的几十个 effect 着色器要上百次读取和不少 wasm 时间），这时 `unsupported` 只是部分清单。
   */
  exhaustive?: boolean;
}

/** 场景目标的整帧快照（B8）。 */
export const FRAMEBUFFER_RT = "_rt_FullFrameBuffer";

/**
 * colorBlendMode ∉ {0, 31} 时的 passthrough 上屏材质（B8，`FUN_1401ecae0` → 0x1401853b0）：看场景 `scene.json` 顶层的
 * `version`（缺键按 0），与显卡、画质设置无关。`version > 2` 用 `effectpassthrough_4.json`（`genericimage4`），否则用
 * `effectpassthrough.json`（`genericimage3`）。本机默认样本都 ≤ 1；工坊样本多数 ≥ 3。`version` 的取值与粒子的 `0x200000`
 * 共用 `sceneVersionOf`。
 */
export function passthroughMaterial(sceneVersion: unknown): string {
  const version = sceneVersionOf(sceneVersion);
  return version > 2 ? "materials/util/effectpassthrough_4.json" : "materials/util/effectpassthrough.json";
}
/** passthrough 的 COMBO（B8）：`BLENDMODE = colorBlendMode`、`FOG_COMPUTED = 1`。组的上屏（P5b 步骤 4）用 `BLENDMODE` 0。 */
export function passthroughCombos(colorBlendMode: number): Record<string, number> {
  return { BLENDMODE: colorBlendMode, FOG_COMPUTED: 1 };
}

/**
 * 组的归属与子树（P5b 步骤 4，rea-p5-modelflags §2.2，p5-REPORT `p5b-grp-*`、`p5b-nest`）：就地填每个图层的 `group` 与 `subtree`。
 * - `group`：沿父链往上最近的组合层祖先（WPE 设父对象时，父层是组合层或在组合层子树里的，子孙都置 `0x2`、顶层不画）。
 * - `subtree`：组合层有子层时才是组。先序展开：每个节点的直接子层按 `objects` 下标排（WPE 子 vector 是加载顺序），先收子层自己，
 *   它不是组合层就接着收它的子树；是组合层（嵌套组）就停止下探，它的子孙由它自己画。
 * 父对象不在 `layers` 里（编译中途停下）时当根节点；环在 `resolveParents` 里已断开，这里按走过的节点兜底。
 */
export function assignGroups(
  layers: Pick<SceneLayer, "object" | "parent" | "passthroughModel" | "group" | "subtree">[],
): void {
  const byObject = new Map(layers.map((layer) => [layer.object, layer]));
  const children = new Map<number, number[]>();
  for (const layer of layers) {
    if (layer.parent === null || !byObject.has(layer.parent)) continue;
    const list = children.get(layer.parent);
    if (list) list.push(layer.object);
    else children.set(layer.parent, [layer.object]);
  }
  for (const list of children.values()) list.sort((a, b) => a - b);
  for (const layer of layers) {
    layer.group = null;
    layer.subtree = [];
    const seen = new Set([layer.object]);
    let current = layer.parent;
    while (current !== null && !seen.has(current)) {
      const parent = byObject.get(current);
      if (!parent) break;
      if (parent.passthroughModel) {
        layer.group = current;
        break;
      }
      seen.add(current);
      current = parent.parent;
    }
  }
  for (const layer of layers) {
    if (!layer.passthroughModel || !children.has(layer.object)) continue;
    const out: number[] = [];
    const seen = new Set([layer.object]);
    const visit = (object: number): void => {
      for (const child of children.get(object) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        if (!byObject.get(child)!.passthroughModel) visit(child);
      }
    };
    visit(layer.object);
    layer.subtree = out;
  }
}

/**
 * 图像层的尺寸（P5b 步骤 1；rea-p5-modelflags §7「尺寸的最终取值顺序」，p5-REPORT `p5b-autosize` 实测）：1×1 → 模型 `width` /
 * `height`（是数字才算，两个分量各自生效）→ 对象 `size`（`objectSize`，解析出的分量各自覆盖）→ `autosize` 时覆盖前面的值：
 * - `projectlayer`（P5b 步骤 2，rea §3.1，`p5b-proj` 实测）：正交投影宽高（`projection`，即 `SceneGeneral` 的 `width` / `height`），
 *   WPE 取整（`0x1401875eb`）。排在纹理之前，组合层的槽 0 是 `_rt_FullFrameBuffer`、本来就没有纹理；
 * - 否则槽 0 纹理的图像尺寸；没有纹理时不覆盖。
 * WPE 的 `autosize` 在纹理就绪时覆盖对象 `size`，我们没有异步的纹理就绪，编译期按同一顺序一次算完。精灵表的帧尺寸、用户纹理的参考
 * 尺寸不在这里：前者随图像层帧动画（`tex:animation`），后者照报（`material:usertextures`）。透视场景（正交投影为空）里 `projectlayer`
 * 的尺寸来源读码未知，那种场景整张报 `camera:perspective`，这里按渲染器的场景尺寸取。
 * `fullscreen` 模型也不在这里：WPE 在纹理就绪时先判它（几何 2×2，排在 `autosize` 之前），`compileScene` 在调本函数之前就定了
 * （`SceneLayer.fullscreen`，P5b 步骤 3）。
 */
export function imageLayerSize(
  model: ModelJson,
  objectSize: readonly number[],
  texture: Pick<SceneTexture, "width" | "height"> | undefined,
  projection: readonly [number, number],
): number[] {
  if (modelFlag(model, "autosize")) {
    if (modelFlag(model, "projectlayer")) return [Math.trunc(projection[0]), Math.trunc(projection[1])];
    if (texture) return [texture.width, texture.height];
  }
  const fromModel = [model.width, model.height];
  return [0, 1].map((axis) => {
    const value = fromModel[axis];
    return objectSize[axis] ?? (typeof value === "number" ? value : 1);
  });
}

/**
 * 材质是否「需要帧缓冲」（WPE 材质 +0x1fc bit1，材质创建时由 `FUN_1401515b0` 算出，决定 `_rt_FullFrameBuffer` 的拷贝时机，B8）：
 * 某个纹理槽最终解析到的名字是 `_rt_FullFrameBuffer`。每个槽的解析顺序是材质 `textures` 里给的名字，没给取着色器注解的
 * `default`，都没有为 `error`。effect 里任一 pass 的材质需要，该 effect 就需要（`FUN_1401e7170`，见 `render/graph.ts`）。
 */
export function needsFramebuffer(slots: readonly (string | null)[], result: TranslateResult | null): boolean {
  const resolved = new Map<number, string>();
  for (const texture of result?.textures ?? [])
    if (typeof texture.meta?.default === "string") resolved.set(texture.slot, texture.meta.default);
  slots.forEach((name, slot) => {
    if (name) resolved.set(slot, name);
  });
  return [...resolved.values()].includes(FRAMEBUFFER_RT);
}

/** fbo 的 `format` → `FBO_FORMATS` 的键（B6）：`rgba_backbuffer` / `rgb_backbuffer` 随 HDR 变化，不认识的按 rgba8888。 */
export function fboFormat(format: string | undefined, hdr: boolean): string {
  if (format === "rgba_backbuffer") return hdr ? "rgba16161616f" : "rgba8888";
  if (format === "rgb_backbuffer") return hdr ? "rgb161616f" : "rgb888";
  return format && FBO_FORMATS[format] ? format : "rgba8888";
}

function parseFbo(raw: EffectFboJson, hdr: boolean): SceneFbo {
  const limit = (value: unknown) =>
    typeof value === "number" && value > 0 && value <= 4096 ? Math.round(value) : undefined;
  const clear = typeof raw.clear === "string" ? numbers(raw.clear) : [];
  return {
    name: String(raw.name ?? ""),
    format: fboFormat(raw.format, hdr),
    scale: typeof raw.scale === "number" && raw.scale >= 1 ? Math.floor(raw.scale) : 1,
    width: limit(raw.width),
    height: limit(raw.height),
    fit: limit(raw.fit),
    unique: raw.unique === true,
    // WPE 解析出 4 个数才置清除位；只写 3 个时颜色存了、标志位不置，创建与重建时都不清（rea-p7d-fluid 第 2 节第 5 条）
    clear: clear.length >= 4 ? [clear[0], clear[1], clear[2], clear[3]] : undefined,
    repeat: raw.uvs === "repeat",
  };
}

const asNumber = (value: SceneScalar | undefined, fallback: number): number => {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
function texturePath(name: string): string {
  if (name.startsWith("_rt_")) return name;
  const path = name.endsWith(".tex") ? name : `${name}.tex`;
  return path.startsWith("materials/") ? path : `materials/${path}`;
}
/** effect 实例的 `textures` 只覆盖写了名字的槽位，null 保留材质自己的值。 */
function mergeTextures(base: unknown[] | undefined, override: unknown[] | undefined): (string | null)[] {
  const slots = (base ?? []).map(textureName);
  for (const [slot, raw] of (override ?? []).entries()) {
    const name = textureName(raw);
    if (name) slots[slot] = name;
  }
  return slots;
}
/**
 * instanced 对象的 `instance`（P5b 步骤 5）里参与合并的两个键：`combos` 是对象才合并、`textures` 是数组才按槽合并；整个不是对象时
 * 为 null（不合并）。取值不合规的由 `checkInstanceFeatures` 照报。
 */
function instanceOverride(raw: unknown): Pick<MaterialPass, "combos" | "textures"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { combos, textures } = raw as Record<string, unknown>;
  return {
    combos:
      combos && typeof combos === "object" && !Array.isArray(combos)
        ? (combos as Record<string, number | boolean>)
        : undefined,
    textures: Array.isArray(textures) ? textures : undefined,
  };
}
export { shaderUniforms };

/** 编译一个材质 pass 的上下文：稳定键、effect 目录（资源查找）、本 effect 的 fbo，以及由渲染图填的槽位及其格式。 */
interface PassContext {
  /** 本 pass 的稳定键（绑定表的目标键），见 `bindings.ts`。 */
  key: TargetKey;
  scope?: ResourceScope | null;
  /** 本 effect 的 fbo 表：只有 effect 的绘制 pass 带它（可能为空表），基础 pass、passthrough、组上屏、粒子都没有。 */
  fbos?: ReadonlyMap<string, SceneFbo>;
  /** 渲染图运行时填的槽位（effect 无 bind 时的槽 0、bind 的各槽、passthrough 的槽 0）：不带格式，WPE 不给 `previous` 与 `bind` 定义 `TEX<n>FORMAT`。 */
  planned?: ShaderTextureSlot[];
  /** 本 pass 不支持项的上报目标；缺省为场景级。 */
  unsupported?: Set<string>;
  /**
   * 粒子材质（P4b 步骤 2 起带系统描述）：按 renderer 与槽 0 格式写 `TEX0FORMAT`（`particleTex0Format`），槽 0 是帧表纹理时
   * 写帧表宏（`particleSheetDefines`），拖尾写 `THICKFORMAT`、`TRAILRENDERER`（`particleRendererDefines`，P4c 步骤 5）；
   * rope 两类换着色器（`ROPE_SHADER`，带 `.geom`）、写各自的宏、不写帧表宏（P4d 步骤 1、2）；
   * 任何槽位的帧表纹理都不报 `tex:animation`（步骤 5，帧表语义只按槽 0）；程序检查带 `PARTICLE_UNIFORMS` 与 `checkParticleProgram`。
   */
  particle?: ParticleSheetSystem;
  /** 字体着色器的 pass（P6b 1d）：程序检查放行 `TEXT_UNIFORMS`（MSDF 才读的 `g_RenderVar0–3`）。 */
  text?: boolean;
  /**
   * 模型网格的材质（P5c 步骤 1）：深度 / 剔除按 WPE 的缺省推（缺 `cullmode` 为 normal、缺 `depthtest` / `depthwrite` 为 enabled），
   * 推出的值写进 `ScenePass`，能力检查走模型规则（`checkPassFeatures` 的 `model`）。静态网格不追加任何引擎 COMBO（rea-p5-mesh 2.4），
   * 全局宏（`HDR`、`SCENE_ORTHO`）照常，所以着色器的编译和图像层同一条路。
   */
  model?: boolean;
}

/**
 * 粒子材质的槽 0 格式在 8–11 吗：WPE 的条件是 `(fmt - 8) <= 3`（无符号比较），即 8–11（RG88、R8、RG1616F、R16F；
 * rea-p4b-render.md 2.4）。非厚格式 sprite 的非 `screen` 朝向那一支在 `particleTex0Format`。
 */
export function particleWritesTex0Format(format: number): boolean {
  return format >= 8 && format <= 11;
}

/**
 * `GENERAL_FIELDS` 的生效值，每个字段登记成就地目标。bool 走 `flagValue`（`{value: false}` 也算），其余走绑定解析；
 * 不合法时取缺省值，同 WPE 不改字段。`camera` 不在表里：WPE 加载时硬读字符串，绑不了属性（L2）。
 */
function generalFields(
  general: Record<string, unknown>,
  properties: Record<string, SceneScalar>,
  bindings: BindingCollector,
): GeneralValues {
  let fields = generalDefaults();
  for (const key of Object.keys(GENERAL_FIELDS) as GeneralKey[]) {
    const target: BindingTarget = { kind: "general", key };
    const raw =
      GENERAL_FIELDS[key].type === "bool"
        ? flagValue(general[key], properties, bindings, target)
        : bindings.bind(general[key] as SceneValue | undefined, properties, target);
    const value = generalValue(key, raw);
    if (value !== undefined) fields = { ...fields, [key]: value };
  }
  return fields;
}

/** 一个 effect 的不支持项。启用的 effect 同步写给场景级：快速退回与解码判断仍能实时看到。 */
class EffectIssues extends Set<string> {
  constructor(private readonly scene: Set<string> | null) {
    super();
  }
  override add(key: string): this {
    this.scene?.add(key);
    return super.add(key);
  }
}

export async function compileScene(input: CompileSceneInput): Promise<SceneBundle> {
  const fs = new SceneFs(input.projectDir, input.sceneAssets, input.reader);
  const unsupported = new Set<string>();
  /** 属性绑定表：每处解析 `{user}` 的地方登记一次（P3a）。 */
  const bindings = new BindingCollector();
  const recompile = (reason: RecompileReason, path: string): BindingTarget => ({
    kind: "recompile",
    reason,
    path,
  });
  const projectText = await fs.text("project.json");
  if (!projectText) throw new Error("缺少 project.json");
  const project = parseProject(projectText);
  const sceneText = await fs.text(project.file);
  if (!sceneText) throw new Error(`缺少场景入口：${project.file}`);
  const scene = parseScene(sceneText);
  // HDR 判定读文件里的 `general.bloom`（K3），脚本覆盖不算，要在套用之前取。缺键写成 null：undefined 会落到缺省参数，读到覆盖后的值
  const fileBloom = scene.general?.bloom ?? null;
  for (const [path, value] of Object.entries(input.scriptOverrides ?? {})) {
    const parts = path.split("/");
    let parent: unknown = scene;
    for (const part of parts.slice(0, -1)) parent = (parent as Record<string, unknown> | undefined)?.[part];
    if (!parent || typeof parent !== "object") continue;
    const key = parts.at(-1)!;
    const old = (parent as Record<string, unknown>)[key];
    const next = Array.isArray(value) ? value.join(" ") : value;
    (parent as Record<string, unknown>)[key] =
      old && typeof old === "object" && "value" in old ? { ...old, value: next } : next;
  }
  const properties = currentProperties(project, input.userProperties ?? {});
  const scripts = await collectScripts(scene, properties, bindings.list);
  // 有粒子层时，任意接收者上的播放控制都可能是粒子层的方法（P6a 步骤 2，P4f 实现后删掉）
  checkScriptFeatures(scripts.list, unsupported, {
    particleLayers: scene.objects.some((object) => objectKind(object) === "particle"),
  });
  checkSceneFeatures(scene, unsupported);
  const general = scene.general ?? {};
  // 后处理档位：每次加载都解析（设置变了由调用方重新编译）
  const setting = input.postprocess ?? "follow";
  const wpeSetting = setting === "follow" ? await readWpePostprocessing(input.reader, input.sceneAssets) : null;
  const postprocess = scenePostprocessState(
    resolvePostprocessLevel(setting, wpeSetting),
    general,
    properties,
    bindings,
    fileBloom,
  );
  const projection =
    general.orthogonalprojection && typeof general.orthogonalprojection === "object"
      ? (general.orthogonalprojection as { width?: number; height?: number })
      : {};
  const fields = generalFields(general, properties, bindings);
  /** 声音表（P6a 步骤 1）：对象循环里按 `objects` 顺序填。 */
  const sounds: SceneSound[] = [];
  const bundle: SceneBundle = {
    general: {
      width: projection.width ?? 1920,
      height: projection.height ?? 1080,
      fields,
      clearVariable: !fields.clearenabled || isUserBinding(general.clearenabled) || isScriptValue(general.clearenabled),
      postprocess,
      bloom: bloomParams(general, properties, bindings),
      // 绑了属性时重编译：步骤 4 只在编译期读它（语料里没有绑定）
      perspectiveOverrideFov: particleFov(
        bindings.bind(
          general.perspectiveoverridefov as SceneValue | undefined,
          properties,
          recompile("layer-structure", "general/perspectiveoverridefov"),
        ),
      ),
    },
    layers: [],
    programs: [],
    textures: [],
    bloom: null,
    unsupported: [],
    // 同一个数组随编译继续填充，最后就是全部登记项
    bindings: bindings.list,
    scripts,
    sounds,
  };
  const counts = lightCounts(general);
  for (const issue of lightConfigIssues(general)) unsupported.add(issue);
  const shader = new ShaderCompiler(
    fs,
    input.translator,
    unsupported,
    litDefines(counts),
    engineDefines(postprocess.hdr, !!general.orthogonalprojection),
  );
  /** 开了光照的程序才读；没人用时不解析灯对象，也不登记它们的绑定。 */
  let lights: Record<string, number[]> | null = null;
  const sceneLights = () =>
    (lights ??= lightUniforms(
      scene.objects,
      counts,
      bindingReader(bindings, properties, (path) => recompile("layer-structure", path)),
    ));
  // 父对象下标；环已断开，`object:parent-cycle` 由能力表报
  const { parents } = resolveParents(scene.objects);
  /** 粒子字段的缺省值按正交 / 透视选两套（`rea-p4a.md`「基础」）；透视场景另报 `camera:perspective`。 */
  const orthographic = isOrthographic(general);
  const textureIndex = new Map<string, number>();
  /** 纹理下标 → 它的不支持项：同一张可能被关着的 effect 与启用的 effect 共用，缓存命中时重新上报。 */
  const textureIssues = new Map<number, string[]>();
  const programIndex = new Map<TranslateResult, number>();
  /** 翻译结果 → `bundle.programs` 下标（同一份结果只放一次）。 */
  const addProgram = (result: TranslateResult): number => {
    let index = programIndex.get(result);
    if (index === undefined) {
      index = bundle.programs.length;
      programIndex.set(result, index);
      bundle.programs.push(result);
    }
    return index;
  };
  const shouldDecode = () => input.force === true || unsupported.size === 0;
  /** 已确定退回且不需要列全时，停止编译后面的图层 / effect。 */
  const settled = () => unsupported.size > 0 && !input.force && !input.exhaustive;

  /**
   * 一张纹理（按解析后的路径缓存）。`particleSlot`：本次是粒子材质的某个槽位，帧表是合法用法，这次上报的问题里去掉
   * `tex:animation`；`tex:animation:multi-image`、`tex:animation:empty` 照报。帧表纹理用在图像层、effect 时照报（图像层的
   * 帧动画属 P6）。缓存的 `textureIssues` 仍是纹理自己的全部问题，只在上报时按用途过滤。
   * 只有槽 0 带帧表语义：WPE 只看槽 0 纹理的头标志置系统的 `0x1000000`（rea-p4b-render.md 2.3），帧表宏与
   * `SceneParticle.spriteSheet` 也只按槽 0 定，和这个参数无关。其它槽（`REFRACT` 的槽 1 帧表法线图，P4b 步骤 5）
   * 只是一张普通纹理：绑定取第 0 张图像（2.7），片元用和槽 0 相同的 `v_TexCoord.xy` 采它，槽 0 是帧表时那已是帧内 UV，
   * 法线图和颜色图同样排帧就对得上（语料里的配对都是这样）。
   */
  async function getTexture(
    name: string,
    scope: ResourceScope | null,
    issues: Set<string> = unsupported,
    particleSlot = false,
  ): Promise<{ index: number; format: number } | null> {
    const path = texturePath(name);
    const file = await fs.resolveScoped(path, scope);
    if (!file) {
      issues.add(`texture:missing:${path}`);
      return null;
    }
    const report = (keys: readonly string[]) => {
      for (const key of keys) if (!(particleSlot && key === ANIMATION_ISSUE)) issues.add(key);
    };
    const existing = textureIndex.get(file.path);
    if (existing !== undefined) {
      report(textureIssues.get(existing) ?? []);
      return { index: existing, format: bundle.textures[existing].format };
    }
    let tex: TexResult;
    try {
      tex = await parseTex(file, shouldDecode());
    } catch (error) {
      issues.add(`tex:parse:${path}:${String(error)}`);
      return null;
    }
    report(tex.unsupported);
    const [textureWidth, textureHeight] = tex.encoded
      ? freeImageTextureSize(tex)
      : [tex.textureWidth, tex.textureHeight];
    const index = bundle.textures.length;
    textureIndex.set(file.path, index);
    textureIssues.set(index, tex.unsupported);
    bundle.textures.push({
      path,
      source: file.source,
      format: tex.format,
      width: tex.width,
      height: tex.height,
      textureWidth,
      textureHeight,
      flags: tex.flags,
      clampUVs: !!(tex.flags & TEX_FLAGS.clampUVs),
      noInterpolation: !!(tex.flags & TEX_FLAGS.noInterpolation),
      mips:
        tex.images[0]?.mips.flatMap((mip) =>
          mip.bytes ? [{ width: mip.width, height: mip.height, bytes: mip.bytes }] : [],
        ) ?? [],
      encoded: tex.encoded,
      videoRange: tex.videoRange,
    });
    const sheet = spriteSheet(tex, textureWidth, textureHeight);
    if (sheet) bundle.textures[index].sheet = sheet;
    return { index, format: tex.format };
  }

  /**
   * 粒子路径的宏 `TEX0FORMAT`（`FUN_1401d2340`，rea-p4b-render.md 2.4）：WPE 在槽 0 纹理的格式是 8–11（RG88、R8、
   * RG1616F、R16F）时写，值是格式本身，着色器据此做通道换算（`ConvertTexture0Format`）。另有一支在非厚格式 sprite 的非 `screen`
   * 朝向时对任何格式都写（P4c 步骤 5 起支持，`particleTex0Format`）。`hdr-macro-REPORT.md` 原说「无条件写」，按 rea-p4b-render 修正；
   * 格式 0、4 时着色器分支本来相同，收窄只让缓存键和 WPE 一致（不写时与图层材质同一条键规则）。
   * 格式取值规则同 `TEX<n>FORMAT`（`.tex` 格式枚举；`_rt_*` 按 RT 格式，`_rt_FullFrameBuffer` 为 0）。经 `defines` 传，进缓存键。
   * 图层材质不走这里，`TEX<n>FORMAT` 仍只按 `formatcombo` 由翻译器定。
   * 槽 0 没按名字写时取着色器注解的 `default`：先不带这个宏翻译一次读注解（结果进缓存，不上报，正式翻译会再报一遍），
   * 仍取不到时不写（语料里粒子材质的槽 0 都按名字写了）。
   * 槽 0 的纹理带帧表（`SceneTexture.sheet`，WPE 据此置系统的 `0x1000000`）时另写帧表宏（`particleSheetDefines`，P4b 步骤 2）；
   * 拖尾另写 `THICKFORMAT`、`TRAILRENDERER`（`particleRendererDefines`，P4c 步骤 5）。
   * 槽 0 的纹理按同一规则取：按名字写的（`slots[0]`），否则是注解的 `default`。
   * rope（P4d 步骤 1）：`shaderName` 是换过的 `ROPE_SHADER`，读注解的那次同样带 `.geom`；只写 rope 的宏与 8–11 的 `TEX0FORMAT`，
   * 不写帧表宏（rea-p4d-rope.md 3.4）。ropetrail（P4d 步骤 2）同一条路，宏换成 ropetrail 的（不写 `THICKFORMAT`）。
   */
  async function particleDefines(
    pass: MaterialPass,
    shaderName: string,
    formats: ShaderTextureSlot[],
    slots: Record<number, number>,
    scope: ResourceScope | null,
    system: ParticleSheetSystem,
  ): Promise<Record<string, string>> {
    const rope = isRopeRenderer(system.renderer?.kind);
    let format = formats.find((item) => item.slot === 0)?.format;
    let texture: SceneTexture | undefined = slots[0] === undefined ? undefined : bundle.textures[slots[0]];
    if (format === undefined) {
      const probe = await shader.compile(shaderName, pass.combos ?? {}, formats, scope, new Set(), {}, rope);
      const fallback = probe?.textures?.find((texture) => texture.slot === 0)?.meta?.default;
      if (fallback === FRAMEBUFFER_RT) format = FBO_FORMATS.rgba8888.tex;
      else if (typeof fallback === "string" && fallback && !fallback.startsWith("_rt_")) {
        const found = await getTexture(fallback, scope, new Set());
        format = found?.format;
        texture = found ? bundle.textures[found.index] : undefined;
      }
    }
    // 拖尾一定走厚格式（`need |= 2`），帧表的 sprite 也是（rea-p4b-render.md 2.4）；rope 两类的 `TEX0FORMAT` 同样只看 8–11
    // （rea-p4d-rope.md 3.4：不像非厚格式 sprite 那样也看朝向；ropetrail 虽是非厚格式，也只看格式）
    const thick = rope || system.renderer?.kind === "spritetrail" || !!texture?.sheet;
    const tex0 = particleTex0Format(format, thick, system);
    return {
      ...particleRendererDefines(system),
      ...(rope ? {} : particleSheetDefines(texture?.sheet, system)),
      ...(tex0 !== undefined ? { TEX0FORMAT: String(tex0) } : {}),
    };
  }

  /**
   * 粒子对象（P4a 步骤 2）：读粒子 JSON（按现有查找顺序：项目 → `scene.pkg` → assets），解析成 `layer.particle`，
   * 逐模块检查能力，再编粒子材质。材质的 pass 放进 `layer.particle.passes`，稳定键 `objects/<i>/particle/passes/<n>`。
   * 子系统（P4e 步骤 1）由 `compileParticleSystem` 沿 `children` 递归编进 `particle.children`。
   */
  async function compileParticle(index: number, object: SceneObject, layer: SceneLayer): Promise<void> {
    const system = await readParticleJson(object.particle);
    if (!system) return;
    layer.particle = await compileParticleSystem(index, object, system, object.particle as string, null, 0);
  }

  /** 读一个粒子 JSON；读不到报 `particle:missing:<文件>`，不是对象报 `particle:parse:<文件>`，都返回 null。 */
  async function readParticleJson(file: unknown): Promise<JsonObject | null> {
    const text = typeof file === "string" && file ? await fs.text(file) : null;
    if (!text) {
      unsupported.add(`particle:missing:${String(file)}`);
      return null;
    }
    let json: unknown;
    try {
      json = parseWpeJson(text);
    } catch {
      json = null;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      unsupported.add(`particle:parse:${file}`);
      return null;
    }
    return json as JsonObject;
  }

  /**
   * 一个粒子系统（顶层与子系统共用，P4e 步骤 1）：能力检查 → 解析 → 编材质的 pass → 递归 `children`。`root` 是顶层系统（顶层自己给
   * null），`depth` 是嵌套深度（顶层 0）。
   * - 稳定键：顶层 `objects/<i>/particle/passes/<k>`（不变），子系统 `objects/<i>/particle/children/<n>/…/passes/<k>`，`<n>` 是条目在
   *   JSON `children` 里的下标（不认识的类型丢掉之后也不移位）。
   * - `instanceoverride`：只有顶层登记绑定（就地目标是对象的）；子系统按缺省值解析，实例值由模拟器从对象上传下去（`ParticleSystem`
   *   的 `link`，rea-p4e-children 3.4）。能力上子系统按自己的 `flags` 再查一遍对象的 `instanceoverride`（`brightness`、`colorn` 的照报项
   *   看各自的 bit3）。
   * - `children`：深度 < `MAX_CHILD_DEPTH` 才读（1.6，自引用的文件到第 10 层停）。四种类型的子系统都编进来（事件实例共用它，P4e
   *   步骤 2、3），不认识的类型、读不到的文件不进。
   *   材质缺失时照样编子系统：WPE 这时整棵子树不画（`FUN_1402366f0` 基础材质为空直接返回），已由 `material:missing` 报。
   */
  async function compileParticleSystem(
    index: number,
    object: SceneObject,
    system: JsonObject,
    file: string,
    root: SceneParticle | null,
    depth: number,
    key = `objects/${index}/particle`,
  ): Promise<SceneParticle> {
    const nested = depth < MAX_CHILD_DEPTH;
    checkParticleFeatures(system, orthographic, unsupported, { children: nested });
    // `instanceoverride` 的标量键与 `colorn` 登记成就地目标（P4a 步骤 5、P4b 步骤 6）。`brightness` 只在 HDR 且系统 flags 没有
    // bit3 时生效（C5），这时没实现：绑了属性就登记成重编译，改成非默认值后由能力表报，否则（LDR 或 bit3）是中性的就地目标
    const { flags } = readParticleSystem(system);
    const brightnessActive = postprocess.hdr && (flags & 8) === 0;
    const instanceTarget = (field: InstanceKey): BindingTarget =>
      field === "brightness" && brightnessActive
        ? recompile("layer-structure", `objects/${index}/instanceoverride/brightness`)
        : { kind: "particle-instance", object: index, field };
    const particle = parseParticle(system, {
      file,
      orthographic,
      // 子系统不登记绑定（P4e 步骤 1）：实例值由模拟器从对象上传
      ...(root
        ? {}
        : {
            instanceoverride: object.instanceoverride,
            resolveInstance: (field: InstanceKey, raw: unknown) =>
              bindings.bind(raw as SceneValue | undefined, properties, instanceTarget(field)),
          }),
      // `0x200000` 看场景 `version`（rea-p4b-render.md 7.4），和 passthrough 材质同一个取值函数
      sceneVersion: sceneVersionOf(scene.version),
    });
    checkParticleInstance(
      object.instanceoverride,
      (root ?? particle).instance,
      { flags, hdr: postprocess.hdr },
      unsupported,
    );
    await compileParticleMaterial(system, particle, flags, key);
    if (!nested || !Array.isArray(system.children)) return particle;
    for (const [n, raw] of system.children.entries()) {
      if (settled()) break;
      const entry = parseParticleChildEntry(raw);
      if (!entry || entry.type === null) continue;
      const json = await readParticleJson(entry.name);
      if (!json) continue;
      const { name: childFile, type, ...fields } = entry;
      const child = await compileParticleSystem(
        index,
        object,
        json,
        childFile,
        root ?? particle,
        depth + 1,
        `${key}/children/${n}`,
      );
      particle.children.push({ type, ...fields, index: n, system: child });
    }
    return particle;
  }

  /** 粒子系统的材质（P4a 步骤 2）：pass 放进 `particle.passes`，稳定键 `<key>/passes/<k>`；帧表纹理定 `spriteSheet`。 */
  async function compileParticleMaterial(
    system: JsonObject,
    particle: SceneParticle,
    flags: number,
    key: string,
  ): Promise<void> {
    const materialPath = system.material;
    if (typeof materialPath !== "string" || !materialPath) {
      unsupported.add("material:missing");
      return;
    }
    const materialText = await fs.text(materialPath);
    if (!materialText) {
      unsupported.add(`material:missing:${materialPath}`);
      return;
    }
    const material = parseMaterial(materialText);
    // 语料里粒子材质都是 1 个 pass；多 pass 怎么画没读，保守报
    if (material.passes.length !== 1) unsupported.add("particle:material:passes");
    const sheetSystem: ParticleSheetSystem = {
      flags,
      animationMode: particle.animationMode,
      renderer: particle.renderer,
    };
    for (const [k, pass] of material.passes.entries())
      particle.passes.push(await compilePass(pass, { key: `${key}/passes/${k}`, particle: sheetSystem }));
    // 基础材质槽 0 的纹理带帧表：WPE 置系统的 `0x1000000`，模拟器据此每帧算 frame（rea-p4b-render.md 2.3、2.5）
    const slot0 = particle.passes[0]?.textures[0];
    particle.spriteSheet = slot0 !== undefined && !!bundle.textures[slot0].sheet;
  }

  /** 解析过的 mdl，按规范化后的路径；读不到为 null。同一个 mdl 被多个对象引用时只读、只解析一次（3354366708 的两个圆环）。 */
  const mdls = new Map<string, MdlFile | null>();
  async function readMdl(path: string): Promise<MdlFile | null> {
    const key = normalizeScenePath(path);
    let file = mdls.get(key);
    if (file === undefined) {
      const read = await fs.read(key);
      file = read && parseMdl(read.bytes);
      mdls.set(key, file);
    }
    return file;
  }

  /**
   * 模型对象（P5c 步骤 1，rea-p5-mesh 第 1、2 节，p5-REPORT「P5c 语义的实测核对」）：读 mdl、查能力，每个网格按对象的 `skin` 选一个
   * 材质（`meshSkin`），走图像层同一条 `compilePass`（`model: true`：深度 / 剔除按 WPE 缺省推，静态网格不追加引擎 COMBO）；稳定键
   * `objects/<i>/meshes/<m>/passes/<k>`。网格的顶点 / 索引字节是文件缓冲的视图，材质按对象各编一份（`skin` 可能不同）。
   * 绘制顺序在这里排好（`meshDrawOrder`，看每个网格第一个 pass 的 blending）。
   * 绘制没接上之前一律报过渡键 `model:pending`（`model` 不是字符串、mdl 读不到时也报），任何模型场景都不会因此解锁或改变画面。
   */
  async function compileModel(index: number, object: SceneObject, layer: SceneLayer): Promise<void> {
    unsupported.add("model:pending");
    // 只认 JSON true（P5b 透视图层那一套，`p5c-matrix` 实测模型相同）；绑属性等由能力表报 `object:perspective`
    layer.perspective = object.perspective === true;
    // 数字是脚本 `createModelData` 建的模型（rea 2.1），语料 0 个
    const path: unknown = object.model;
    if (typeof path !== "string") {
      unsupported.add("model:id");
      return;
    }
    const file = await readMdl(path);
    if (!file) {
      unsupported.add(`mdl:missing:${path}`);
      return;
    }
    checkMdlFeatures(file, unsupported);
    const skin = meshSkin(object.skin, file.skins);
    const meshes: SceneMesh[] = [];
    for (const [m, mesh] of file.meshes.entries()) {
      if (settled()) break;
      meshes.push(await compileMesh(index, m, mesh, mesh.materials[skin]));
    }
    const opaque = meshes.map((mesh) => ["normal", "alphatocoverage"].includes(mesh.passes[0]?.blending ?? ""));
    layer.model = { path, version: file.version, meshes, order: meshDrawOrder(opaque), bounds: file.bounds };
  }

  /** 模型的一个网格：编选中的材质，按网格格式查程序读到的属性（`checkMeshAttributes`）。 */
  async function compileMesh(
    index: number,
    m: number,
    mesh: MdlMesh,
    material: string | undefined,
  ): Promise<SceneMesh> {
    const out: SceneMesh = {
      format: mesh.format,
      stride: mesh.stride,
      vertices: mesh.vertices,
      indices: mesh.indices,
      vertexCount: mesh.vertexCount,
      indexFormat: mesh.indexFormat,
      indexCount: mesh.indexCount,
      material: material ?? "",
      passes: [],
    };
    if (!material) {
      unsupported.add("material:missing");
      return out;
    }
    const text = await fs.text(material);
    if (!text) {
      unsupported.add(`material:missing:${material}`);
      return out;
    }
    const { passes } = parseMaterial(text);
    // 语料的模型材质都是一个 pass；多 pass 的网格 WPE 怎么画没测
    if (passes.length > 1) unsupported.add("mdl:material-passes");
    for (const [k, pass] of passes.entries()) {
      const compiled = await compilePass(pass, { key: `objects/${index}/meshes/${m}/passes/${k}`, model: true });
      if (compiled.program !== null) checkMeshAttributes(bundle.programs[compiled.program], mesh.format, unsupported);
      out.passes.push(compiled);
    }
    return out;
  }

  /** 编译一个材质 pass：纹理（含 `_rt_*` 与着色器注解默认值）、着色器、uniform、能力检查。 */
  async function compilePass(pass: MaterialPass, context: PassContext): Promise<ScenePass> {
    const issues = context.unsupported ?? unsupported;
    checkPassFeatures(pass, issues, { model: context.model });
    const scope = context.scope ?? null;
    const names = (pass.textures ?? []).map(textureName);
    const slots: Record<number, number> = {};
    const runtime: Record<number, string> = {};
    const formats: ShaderTextureSlot[] = [...(context.planned ?? [])];
    const planned = new Set(formats.map((item) => item.slot));
    const bindRuntime = (slot: number, name: string): boolean => {
      if (name === FRAMEBUFFER_RT) runtime[slot] = name;
      else if (context.fbos?.has(name)) runtime[slot] = name;
      else return false;
      return true;
    };
    for (const [slot, name] of names.entries()) {
      if (!name || planned.has(slot)) continue;
      if (name.startsWith("_rt_")) {
        if (bindRuntime(slot, name))
          formats.push({ slot, format: FBO_FORMATS[context.fbos?.get(name)?.format ?? "rgba8888"].tex });
        else issues.add(`texture:rendertarget:${name}`);
        continue;
      }
      // 粒子材质的任何槽位都不报 `tex:animation`（帧表语义只按槽 0，见 `getTexture`）
      const texture = await getTexture(name, scope, issues, !!context.particle);
      if (texture) {
        slots[slot] = texture.index;
        formats.push({ slot, format: texture.format });
      }
    }
    // rope 两类系统的 pass 无条件换成 `genericropeparticle`、带 `.geom` 翻译（P4d 步骤 1、2，rea-p4d-rope.md 第 6 节，见 `ROPE_SHADER`）
    const rope = isRopeRenderer(context.particle?.renderer?.kind);
    const shaderName = rope ? ROPE_SHADER : pass.shader;
    const defines =
      context.particle && shaderName
        ? await particleDefines(pass, shaderName, formats, slots, scope, context.particle)
        : {};
    const result = shaderName
      ? await shader.compile(shaderName, pass.combos ?? {}, formats, scope, issues, defines, rope)
      : null;
    if (result?.ok) {
      for (const script of scripts.list) {
        if (script.owner.kind !== "material" || script.owner.pass !== context.key || script.target.kind !== "constant")
          continue;
        // 脚本写回走 WPE 的类型化 setter，类型是这个键 setter 的类型（主格的，vector-constant-REPORT.md 2.6）
        const material = script.target.material;
        const slot = materialSlots(result.uniforms ?? []).find((item) => item.material === material);
        if (slot) Object.assign(script.target, constantTargetFields(slot));
        else script.target.uniforms = [];
        script.valueType = script.target.type;
      }
    }
    if (!shaderName) issues.add("shader:missing");
    if (context.particle) checkParticleProgram(pass, result?.ok ? result : null, issues);
    let program: number | null = null;
    if (result?.ok) {
      // 粒子 pass 带粒子路径写的 uniform；effect pass（有 fbo 表的上下文）带只在 effect pass 写的 `g_LayerModelMatrix`
      // （P7d 步骤 2），基础材质读到它照报
      checkProgramFeatures(
        result,
        issues,
        context.particle
          ? PARTICLE_UNIFORMS
          : context.text
            ? TEXT_UNIFORMS
            : context.fbos
              ? EFFECT_UNIFORMS
              : undefined,
      );
      // 着色器声明了、材质没给的槽位按注解 `default` 绑定（同 LWE `setupTextureUniforms` 先取着色器默认值）
      for (const binding of result.textures ?? []) {
        const fallback = binding.meta?.default;
        if (typeof fallback !== "string" || !fallback) continue;
        if (planned.has(binding.slot) || binding.slot in slots || binding.slot in runtime) continue;
        if (fallback.startsWith("_rt_")) {
          if (!bindRuntime(binding.slot, fallback)) issues.add(`texture:rendertarget:${fallback}`);
          continue;
        }
        const texture = await getTexture(fallback, scope, issues, !!context.particle);
        if (texture) slots[binding.slot] = texture.index;
      }
      program = addProgram(result);
    }
    // 缺键：模型照 WPE 的缺省（材质 pass 字节缺省 0，rea-p5-mesh 3）；图像层、effect、粒子保持现状，P5d 和深度附件一起统一
    return {
      key: context.key,
      program,
      blending: pass.blending ?? "normal",
      cullmode: pass.cullmode ?? (context.model ? "normal" : "nocull"),
      depthtest: pass.depthtest ?? (context.model ? "enabled" : "disabled"),
      depthwrite: pass.depthwrite ?? (context.model ? "enabled" : "disabled"),
      textures: slots,
      runtime,
      uniforms: {
        ...shaderUniforms(result, pass, properties, context.key, bindings, issues),
        ...(result?.ok && usesLighting(result) ? sceneLights() : {}),
      },
      framebuffer: needsFramebuffer(names, result?.ok ? result : null),
    };
  }

  /** 编译一个 effect 的 fbo 与步骤；effect.json 缺失时返回 null。不支持项写进 `issues`，抛错交给调用方按开关处理。 */
  async function compileEffect(
    index: number,
    shell: SceneEffect,
    instance: SceneEffectInstance,
    issues: Set<string>,
  ): Promise<SceneEffect | null> {
    const { file } = shell;
    const label = file.split("/").at(-2) ?? "unknown";
    const effectFile = file ? await fs.read(file) : null;
    const effectText = effectFile ? new TextDecoder().decode(effectFile.bytes).replace(/^﻿/, "") : null;
    if (!effectFile || !effectText) {
      issues.add(`effect:missing:${file}`);
      return null;
    }
    const effect = parseEffect(effectText);
    // `conditions`（fbo、pass、bind）在编译期求一次，照 WPE 加载时的求值（rea-p7d-fluid 第 1 节）：求值用的 COMBO 只来自实例
    // **顶层** `combos`，它也只给条件用，不并进各 pass 的 COMBO（p7-REPORT「流体 effect 的条件」的 `ltop` / `r3top` 实测）。
    // 被去掉的 fbo、pass、bind 不进 bundle，渲染图不再看条件
    const holds = (conditions: unknown) => conditionsHold(conditions, instance.combos);
    checkEffectFeatures(instance, effect, label, issues, holds);
    // effect 资源的查找范围：effect.json 所在目录；它来自 assets 时内置资源也在那里，先查它
    const scope: ResourceScope | null = file.includes("/")
      ? { dir: file.slice(0, file.lastIndexOf("/")), first: effectFile.source === "assets" }
      : null;
    const fbos = new Map(
      (effect.fbos ?? [])
        .filter((item) => holds(item.conditions))
        .map((item) => parseFbo(item, postprocess.hdr))
        .filter((item) => item.name)
        .map((item) => [item.name, item]),
    );
    /** 被条件去掉的 fbo 名（同名还有留下的不算）：WPE 按名字查不到下标，记 −1。 */
    const removed = removedFbos(effect, holds);
    const steps: SceneEffectStep[] = [];
    let overrideIndex = 0;
    /** 本 effect 里已编译的绘制 pass 序号（本 effect 的 pass 稳定键用，材质多 pass 也各占一个）。 */
    let passIndex = 0;
    for (const pass of effect.passes ?? []) {
      if (pass.command === "copy" || pass.command === "swap") {
        // 命令 pass 同样先过条件（WPE 对每个 pass 都求）
        if (!holds(pass.conditions)) continue;
        if (typeof pass.source !== "string" || typeof pass.target !== "string") continue;
        // `swap` 的一端被条件去掉：WPE 要求两端下标都 ≥ 0，否则什么都不做，这里不收这条命令。
        // `copy` 的一端被去掉：语料 0 处，`checkEffectFeatures` 报 `command-operands`
        if (pass.command === "swap" && (removed.has(pass.source) || removed.has(pass.target))) continue;
        steps.push({ kind: pass.command, source: pass.source, target: pass.target });
        continue;
      }
      if (typeof pass.material !== "string") continue;
      // 实例的 passes 按顺序对应 effect.json 里的绘制 pass（命令 pass 不占位，同 LWE `CImage::setup`）。被条件去掉的
      // 绘制 pass 仍占它的位置（WPE 覆盖数组下标照常 +1；p7-REPORT：流体 normal 被去掉后 combine 拿到第 18 项）
      const override = instance.passes?.[overrideIndex++];
      if (!holds(pass.conditions)) {
        // 稳定键同样留出它的序号：键是 scene.json 坐标（`bindings.ts`），脚本写回按实例 `passes/<k>` 找已编译的 pass，
        // 不留的话后面 pass 的键整体前移，挂在被去掉的那项覆盖上的脚本会写到下一个 pass 上
        passIndex++;
        continue;
      }
      const passMaterialText = await fs.text(pass.material, scope);
      if (!passMaterialText) {
        issues.add(`material:missing:${pass.material}`);
        continue;
      }
      // bind 的条件不满足：整条不加，这个槽保持材质原来的纹理（rea-p7d-fluid 第 1 节第 8 条）。指向被条件去掉的 fbo 的
      // bind 保留名字：渲染图把不是本 effect 的 fbo 的名字解析成当前合成 RT（`graph.ts` 的 `resolveRef`），同 WPE 的 −1
      const binds = Array.isArray(pass.bind)
        ? pass.bind
            .filter((bind) => typeof bind?.name === "string" && Number.isInteger(bind?.index))
            .filter((bind) => holds(bind.conditions))
            .map((bind) => ({ name: String(bind.name), index: Number(bind.index) }))
        : null;
      // 渲染图填的槽位：有 bind 时只按 bind；没有 bind 时槽 0 = 上一步输出（合成 RT）
      const planned: ShaderTextureSlot[] = binds ? binds.map((bind) => ({ slot: bind.index })) : [{ slot: 0 }];
      for (const materialPass of parseMaterial(passMaterialText).passes) {
        const merged: MaterialPass = {
          ...materialPass,
          combos: { ...materialPass.combos, ...override?.combos },
          constantshadervalues: { ...materialPass.constantshadervalues, ...override?.constantshadervalues },
          textures: mergeTextures(materialPass.textures, override?.textures),
        };
        // 有 bind 时材质槽 0 的 null 不再自动填（B6）：不在 planned 里的 null 槽位就保持空
        const compiled = await compilePass(merged, {
          key: `objects/${index}/effects/${shell.source}/passes/${passIndex++}`,
          scope,
          fbos,
          planned,
          unsupported: issues,
        });
        // effect 自己开光照：WPE 里能跑，但世界坐标的取法没有和 WPE 对比过，不猜
        if (compiled.program !== null && usesLighting(bundle.programs[compiled.program])) issues.add("lighting:effect");
        steps.push({
          kind: "draw",
          pass: compiled,
          // 指向被条件去掉的 fbo 等于没写：WPE 查不到下标（−1），画回合成链
          target: typeof pass.target === "string" && !removed.has(pass.target) ? pass.target : null,
          compose: pass.compose === true,
          binds,
        });
      }
    }
    return { ...shell, fbos: [...fbos.values()], steps };
  }

  /**
   * 图像层的模型与基础材质（`object.image` 指向的模型 JSON）：模型标志、基础材质的 pass、图层尺寸。读不到模型或材质时报不支持、
   * 返回 false（图层到此为止，没有 effect）。文本对象没有模型，不走这里（P6b 1d）。
   */
  async function compileImageModel(index: number, object: SceneObject, layer: SceneLayer): Promise<boolean> {
    const image = object.image!;
    const modelText = await fs.text(image);
    if (!modelText) {
      unsupported.add(`model:missing:${image}`);
      return false;
    }
    const model = parseModel(modelText);
    checkModelFeatures(model, unsupported);
    // 两个标志分开（P5b 步骤 5，p5-REPORT `p5b-inst2`）：内缩只看 solidlayer，合成 RT 按 size 才排除 instanced（`compositeSize`）
    layer.solidLayer = modelFlag(model, "solidlayer");
    layer.instanced = modelFlag(model, "instanced");
    if (layer.instanced) checkInstanceFeatures(object, unsupported);
    layer.noPadding = modelFlag(model, "nopadding");
    // 只认 JSON true：绑属性、挂脚本等由能力表报 `object:perspective`
    layer.perspective = object.perspective === true;
    // 组合层（P5b 步骤 2，p5-REPORT `p5b-cl`）：`copybackground` 缺省 true（基类构造 `FUN_1401e6980` 给 `+0x304` 置 0x40，
    // rea-p5-modelflags 开头的标志表），只有 JSON false 才关
    layer.passthroughModel = modelFlag(model, "passthrough");
    layer.copyBackground = object.copybackground !== false;
    // fullscreen（P5b 步骤 3，p5-REPORT `p5b-fs`）：只认 JSON true（P5a 步骤 0 实测 `fullscreen: 1` 不生效）
    layer.fullscreen = modelFlag(model, "fullscreen");
    if (layer.passthroughModel) {
      // 组合层又 `perspective: true`：基础 pass 与上屏各用哪套相机没测过（语料 0 个），照报
      if (layer.perspective) unsupported.add("object:perspective");
      // fullscreenlayer 带子层：WPE 这时子层按场景相机画进全屏 RT（rea-p5-modelflags §2.5），没有实测，语料 0 个，照报
      if (layer.fullscreen && parents.includes(index)) unsupported.add("model:fullscreen:children");
    }
    if (!model.material) {
      unsupported.add("material:missing");
      return false;
    }
    const materialText = await fs.text(model.material);
    if (!materialText) {
      unsupported.add(`material:missing:${model.material}`);
      return false;
    }
    const material = parseMaterial(materialText);
    // instanced（P5b 步骤 5）：对象的 `instance` 覆盖材质 pass 的同名键（rea-p5-modelflags §6.2），规则同 effect 实例覆盖：`combos`
    // 合并、`textures` 按槽合并（null 与非字符串的槽保留材质自己的）。`instance` 不是对象时不合并（能力表报 `model:instanced:instance`）
    const instance = layer.instanced ? instanceOverride(object.instance) : null;
    for (const [k, raw] of material.passes.entries()) {
      const pass: MaterialPass = instance
        ? {
            ...raw,
            combos: { ...raw.combos, ...instance.combos },
            textures: mergeTextures(raw.textures, instance.textures),
          }
        : raw;
      layer.passes.push(await compilePass(pass, { key: `objects/${index}/passes/${k}` }));
    }
    // 尺寸照 WPE 的顺序（P5b 步骤 1，`imageLayerSize`）：只有 `autosize` 才取槽 0 纹理的图像尺寸（`projectlayer` 取正交投影宽高，
    // 步骤 2）。deep_space 的 Background 模型写 1920×1080、没有 `autosize`，槽 0 是 480×270 的流向遮罩，按模型取，和 P1 相同
    const base = layer.passes[0]?.textures[0];
    const baseTexture = base === undefined ? undefined : bundle.textures[base];
    if (layer.fullscreen) {
      // fullscreen（P5b 步骤 3）排在 autosize 之前（rea-p5-modelflags §7：纹理就绪时 fullscreen 先判，取纹理图像尺寸、几何 2×2）。
      // 两份尺寸：几何是 2×2 的 NDC 四边形；合成 RT 取槽 0 静态纹理的图像尺寸，槽 0 是运行时 RT（fullscreenlayer 的
      // `_rt_FullFrameBuffer`，在 pass 的 `runtime` 里）或没有纹理时取场景尺寸
      layer.size = [2, 2];
      layer.fullscreenSize = baseTexture
        ? [baseTexture.width, baseTexture.height]
        : [bundle.general.width, bundle.general.height];
    } else layer.size = imageLayerSize(model, layer.size, baseTexture, [bundle.general.width, bundle.general.height]);
    return true;
  }

  /**
   * 宿主指定材质的一个 pass（P6b 1d 的文本表用，`compile/texts.ts`）：读 WPE 自带的材质 JSON、取第一个 pass 编译；读不到时报
   * `material:missing:<路径>`、返回 null。`text`：字体着色器的 pass，程序检查放行 `TEXT_UNIFORMS`。
   */
  const compileHostPass: HostPassCompiler = async (path, key, planned, options = {}) => {
    const text = await fs.text(path);
    const pass = text ? parseMaterial(text).passes[0] : undefined;
    if (!pass) {
      unsupported.add(`material:missing:${path}`);
      return null;
    }
    return compilePass(pass, { key, planned, text: options.text });
  };

  for (const [index, object] of scene.objects.entries()) {
    if (settled()) break;
    /** 图层字段的就地目标（场景坐标里的 objects 下标，不随 bundle 下标变）。 */
    const at = (field: LayerField): BindingTarget => ({ kind: "layer", object: index, field });
    const layer: SceneLayer = {
      id: object.id ?? bundle.layers.length,
      object: index,
      parent: parents[index],
      name: object.name ?? "",
      origin: numbers(bindings.bind(object.origin, properties, at("origin")), [0, 0, 0]),
      scale: numbers(bindings.bind(object.scale, properties, at("scale")), [1, 1, 1]),
      angles: numbers(bindings.bind(object.angles, properties, at("angles")), [0, 0, 0]),
      size: numbers(bindings.bind(object.size, properties, recompile("layer-structure", `objects/${index}/size`))),
      alpha: asNumber(bindings.bind(object.alpha, properties, at("alpha")), 1),
      color: numbers(bindings.bind(object.color, properties, at("color")), [1, 1, 1]),
      brightness: asNumber(bindings.bind(object.brightness as SceneValue, properties, at("brightness")), 1),
      visible: bindings.bind(object.visible, properties, at("visible")) !== false,
      visibleBound: isUserBinding(object.visible),
      parallaxDepth: numbers(bindings.bind(object.parallaxDepth, properties, at("parallaxDepth")), [1, 1]),
      solidLayer: false,
      instanced: false,
      noPadding: false,
      perspective: false,
      passthroughModel: false,
      group: null,
      subtree: [],
      groupUpload: null,
      copyBackground: true,
      fullscreen: false,
      fullscreenSize: null,
      passes: [],
      colorBlendMode: Math.trunc(
        asNumber(
          bindings.bind(
            object.colorBlendMode as SceneValue,
            properties,
            recompile("layer-structure", `objects/${index}/colorBlendMode`),
          ),
          0,
        ),
      ),
      effects: [],
      passthrough: null,
      particle: null,
      text: null,
      model: null,
    };
    // 每个对象都进 `layers`（分组节点、灯、粒子是没有 pass 的图层），子孙算世界矩阵与可见性时父的状态都在
    bundle.layers.push(layer);
    if (objectKind(object) === "particle") {
      await compileParticle(index, object, layer);
      continue;
    }
    // 模型对象（P5c 步骤 1）：和粒子一样挂在图层上（`layer.model`），`effects` 不编译（能力表报 `model:effects`）
    if (objectKind(object) === "model") {
      await compileModel(index, object, layer);
      continue;
    }
    // 声音对象（P6a 步骤 1）：图层上只有变换，播放字段进声音表；可见性不影响播放（p6-REPORT `p6a-misc`）
    if (isSoundObject(object)) {
      sounds.push(await compileSound(index, object, fs, properties, bindings));
      continue;
    }
    // 文本对象（P6b 1d）：没有模型，基础 pass 换成文本表里的宿主材质（排版在宿主主线程）；effect 与 colorBlendMode passthrough
    // 走下面图像层那段，文本表在它们之后编（`padding` 看启用的 effect 个数）
    const textObject = isTextObject(object);
    if (!textObject) {
      // 没有 image 的对象到这里为止：分组节点的 `effects` 不读、不编译（P4a 步骤 1）
      if (!object.image) continue;
      if (!(await compileImageModel(index, object, layer))) continue;
    }
    // 组（P5b 步骤 4）：有对象的父指向这个组合层。子孙由它按局部正交画进合成 RT、不在顶层画（`assignGroups` 在全部对象之后定归属）
    const hasChildren = layer.passthroughModel && parents.includes(index);

    for (const [source, raw] of (Array.isArray(object.effects) ? object.effects : []).entries()) {
      if (settled()) break;
      const instance = (raw ?? {}) as SceneEffectInstance;
      const visibleBound = isUserBinding(instance.visible) || isScriptValue(instance.visible);
      const enabled =
        bindings.bind(instance.visible, properties, { kind: "effect", object: index, effect: source }) !== false;
      // 写死关闭、没有绑定的整步跳过（B11），也不检查它的能力
      if (!enabled && !visibleBound) continue;
      const issues = new EffectIssues(enabled ? unsupported : null);
      const shell: SceneEffect = {
        source,
        id: instance.id ?? layer.effects.length,
        name: instance.name ?? "",
        file: typeof instance.file === "string" ? instance.file : "",
        fbos: [],
        steps: [],
        enabled,
        visibleBound,
        unsupported: [],
      };
      let compiled: SceneEffect | null = null;
      try {
        compiled = await compileEffect(index, shell, instance, issues);
      } catch (error) {
        if (enabled) throw error;
        // 关着的 effect 以前不解析，它坏了不能让整场编译失败
        issues.add(`effect:error:${shell.file}`);
      }
      // 启用时缺文件维持现状（不进 layer.effects）；关着时进一个空 effect，打开时靠 `unsupported` 知道要整场重编译
      if (compiled || !enabled) layer.effects.push({ ...(compiled ?? shell), unsupported: [...issues].sort() });
    }

    const cbm = layer.colorBlendMode;
    // 带 effect 或走 passthrough 时，WPE 把光照挪到基础 pass（PRELIGHTING=1，世界坐标改用 g_Alt*），上屏 pass 关光照（FUN_140209540）
    const lit = layer.passes.some((pass) => pass.program !== null && usesLighting(bundle.programs[pass.program]));
    if (lit && (layer.effects.length > 0 || (cbm !== 0 && cbm !== 31))) unsupported.add("lighting:prelighting");
    if (cbm !== 0 && cbm !== 31) {
      const path = passthroughMaterial(scene.version);
      const text = await fs.text(path);
      const pass = text ? parseMaterial(text).passes[0] : undefined;
      if (!pass) unsupported.add(`material:missing:${path}`);
      else {
        layer.passthrough = await compilePass(
          { ...pass, combos: { ...pass.combos, ...passthroughCombos(cbm) } },
          { key: `objects/${index}/passthrough`, planned: [{ slot: 0 }] },
        );
        // passthrough 上屏颜色置 (1, 1, 1, 1)（B8 / B10）
        layer.passthrough.uniforms.g_Color4 = [1, 1, 1, 1];
      }
    }
    if (hasChildren) {
      // 组的上屏（P5b 步骤 4，p5-REPORT `p5b-grp-nofx` / `nofx0`）：无 effect、colorBlendMode ∈ {0, 31} 时用。effect 运行时可能全关，
      // 所以有子层就编。同 colorBlendMode 混合的 passthrough 材质，`BLENDMODE` 0（不读快照），槽 0 是合成 RT
      const path = passthroughMaterial(scene.version);
      const text = await fs.text(path);
      const pass = text ? parseMaterial(text).passes[0] : undefined;
      if (!pass) unsupported.add(`material:missing:${path}`);
      else {
        layer.groupUpload = await compilePass(
          { ...pass, combos: { ...pass.combos, ...passthroughCombos(0) } },
          { key: `objects/${index}/groupupload`, planned: [{ slot: 0 }] },
        );
        // 实测上屏颜色是 (1, 1, 1, 1)（`p5b-grp-nofx` 事件 125 的 g_Color4）
        layer.groupUpload.uniforms.g_Color4 = [1, 1, 1, 1];
      }
    }
    if (textObject && !settled())
      layer.text = await compileText(index, object, {
        fs,
        properties,
        bindings,
        hdr: postprocess.hdr,
        visibleEffects: layer.effects.filter((effect) => effect.enabled).length,
        colorBlendMode: cbm,
        mayComposite: layer.effects.length > 0 || (cbm !== 0 && cbm !== 31),
        hostPass: compileHostPass,
        unsupported,
      });
  }
  // 组（P5b 步骤 4）：全部对象编完之后定归属与子树（祖先可能排在子孙后面），再按子孙编好的模型、材质、effect、粒子查组里还不支持的用法
  assignGroups(bundle.layers);
  for (const layer of bundle.layers) {
    if (layer.group === null) continue;
    for (const key of groupChildIssues(layer)) unsupported.add(key);
    // 关着、运行时可能打开的 effect 读快照：记进它自己的不支持项，打开时整场重编译（`SceneState.needsRecompile`），重编译后按上面报
    for (const effect of layer.effects)
      if (!effect.enabled && effectNeedsFramebuffer(effect) && !effect.unsupported.includes(GROUP_CHILD_FRAMEBUFFER))
        effect.unsupported = [...effect.unsupported, GROUP_CHILD_FRAMEBUFFER].sort();
  }
  // 泛光链：每帧在全部对象画完之后跑，前提是允许泛光且对象列表非空（A1）。当前开着，或运行中可能打开（绑了属性或挂了脚本）才建；
  // 不按「场景有脚本」判定：`bloom: false` 的场景大多带脚本，会平白多占显存。别的写入打开时走整场重编译（`SceneState.needsRecompile`）。
  // 链的形态跟 HDR 判定走，和当前开不开无关（K3）：JSON 为 true、属性为 false 时建 HDR 链，运行中打开是 HDR 泛光
  const bloomVariable = isUserBinding(general.bloom) || isScriptValue(general.bloom);
  if (
    (postprocess.bloom || (bloomVariable && postprocess.level !== "disabled")) &&
    scene.objects.length > 0 &&
    !settled()
  )
    bundle.bloom = await compileBloom({ fs, shader, unsupported, addProgram }, postprocess.hdr);
  if (!input.sceneAssets.length) unsupported.add("assets:missing");
  bundle.unsupported = [...unsupported].sort();
  // 「场景用音频」位（P4e 步骤 4）：开关只看 `project.json`（`scene.json` 的同名键 WPE 不读，rea-p4e-audio.md 第 6 节），不会因为场景里
  // 有音频粒子就自动开启（4.3）
  bundle.audio =
    project.general?.supportsaudioprocessing === true &&
    bundle.layers.some((layer) => layer.particle !== null && particleUsesAudio(layer.particle));
  return bundle;
}

/** 交给主线程时转移的缓冲：纹理 mip 与 mdl 文件（网格的顶点 / 索引是它的视图，同一个 mdl 的对象共用一份），去重。 */
export function transferableBuffers(bundle: SceneBundle): ArrayBuffer[] {
  const buffers = [
    ...bundle.textures.flatMap((texture) => texture.mips.map((mip) => mip.bytes?.buffer)),
    ...bundle.layers.flatMap(
      (layer) => layer.model?.meshes.flatMap((mesh) => [mesh.vertices.buffer, mesh.indices.buffer]) ?? [],
    ),
  ];
  return [...new Set(buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer))];
}
