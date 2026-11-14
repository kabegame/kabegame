import { collectAnimations, settleConstantAnimation } from "./animations";
import { alignmentIndex } from "./alignment";
import { compileBloom, type SceneBloom } from "./bloom";
import {
  BindingCollector,
  CAMERA_DEFAULTS,
  cameraValue,
  GENERAL_FIELDS,
  generalDefaults,
  generalValue,
  isScriptValue,
  isUserBinding,
  layerVectorValue,
  type BindingTarget,
  type GeneralKey,
  type GeneralValues,
  type LayerField,
  type LayerVectorField,
  type RecompileReason,
  type SceneBinding,
  type TargetKey,
} from "./bindings";
import { conditionsHold, removedFbos } from "./conditions";
import { checkerTexture, dependencyIds, LAYER_COMPOSITE_PREFIX, layerCompositeName } from "./dependencies";
import { normalizeScenePath, SceneFs, type ResourceScope, type SceneReader } from "./fs";
import { resolveParents } from "./hierarchy";
import { meshDrawOrder, meshSkin, parseMdl, type MdlFile, type MdlMesh } from "./mdl";
import { buildPuppet, type ScenePuppet } from "./puppet";
import { constantTargetFields, materialSlots, unwrapValue } from "./materialValues";
import {
  bindingReader,
  engineDefines,
  legacyLightUniforms,
  lightConfigIssues,
  lightCounts,
  lightUniforms,
  litDefines,
  readsLegacyLights,
} from "./lights";
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
  cursorPickKind,
  EFFECT_UNIFORMS,
  effectNeedsFramebuffer,
  GROUP_CHILD_FRAMEBUFFER,
  groupChildIssues,
  isCameraObject,
  isMixedCameraObject,
  isShapeObject,
  isSoundObject,
  isTextObject,
  modelFlag,
  normalizeDepthKeys,
  objectKind,
  PARTICLE_UNIFORMS,
  PUPPET_COMBOS,
  PUPPET_UNIFORMS,
  readsAudioUniforms,
  shapeIssues,
  TEXT_UNIFORMS,
  usesLighting,
  usesPerspectiveParticles,
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
  resolveValue,
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
  hasSpriteTrail,
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
  readWpeReflection,
  resolvePostprocessLevel,
  resolveReflection,
  scenePostprocessState,
  type BloomParams,
  type SceneReflectionSetting,
  type ScenePostprocessSetting,
  type ScenePostprocessState,
} from "./postprocess";
import { ShaderCompiler, shaderUniforms, type ShaderTextureSlot } from "./shader";
import { collectScripts, type SceneScripts } from "./scripts";
import { checkCameraObjectPath, compileCamera, type SceneCameraJson } from "./camera";
import { compileSound, type SceneSound } from "./sounds";
import { compileText, type HostPassCompiler, type SceneText } from "./texts";
import { ANIMATION_ISSUE, FBO_FORMATS, freeImageTextureSize, parseTex, TEX_FLAGS, type TexResult } from "./tex";
import { materialCombos, passAlphaWriting, type AlphaWriting } from "./writeState";
import {
  defaultOfTexture,
  instanceReferenceSize,
  mergeUserTextures,
  parseUserTextures,
  type UserTextureDefault,
  type UserTextureSlot,
  type UserTextureSource,
} from "./usertextures";
import type { SceneVideoSource } from "../video/player";
import type { SceneAnimation } from "../animation/types";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";
import { particleUsesAudio } from "../particles/audio";

export interface SceneGeneral {
  /**
   * 正交投影的宽高 W、H（`orthogonalprojection` 的 `width` / `height`；`auto: true` 没写宽高时是占位 1920×1080）。透视场景是 WPE 的
   * 值 0（rea-p5-camera 2.1【确】：W、H 只由 `orthogonalprojection` 写），场景目标改按画布尺寸（P5d 步骤 2，`GpuScene.build` 的
   * `size`）。
   */
  width: number;
  height: number;
  /**
   * 透视场景（P5d 步骤 2）：`isOrthographic` 不成立（rea-p4a「基础」【确】：`orthogonalprojection` 是对象，且 `auto: true` 或宽高都
   * 非 0 才是正交）。能力表、`SCENE_ORTHO` 宏、粒子缺省值、渲染器都读这一处。缺省（手写的 bundle）为正交。
   */
  perspective?: boolean;
  /** 透视场景的基准相机与路径（`compile/camera.ts`）；正交场景为 null 或缺省（视图恒为单位阵，L2）。 */
  camera?: SceneCameraJson | null;
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
  /**
   * 透明排序（P5d 步骤 4）：`general.transparentsorting` 是 JSON `true`。只在透视场景起作用（WPE `+0xe0 & 0x1008 == 0x1000`，
   * rea-p5-mesh 4.2，p5-REPORT `p5d-sort-ortho`），渲染器按它重排顶层绘制顺序（`render/sortOrder.ts`）。绑属性、挂脚本等别的写法这里
   * 为 false，能力表照报 `general:transparentsorting`（WPE 每帧读这一位，运行中改没实测，语料 0）。缺省（手写的 bundle）为 false。
   */
  transparentSorting?: boolean;
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
  /**
   * 视频纹理（P9a）：视频在磁盘上的绝对区间（`TexResult.video`）。没有 mip，渲染器建一张初值全 0 的 `rgba8unorm`，画到它时由
   * 主线程的播放器交来帧（`render/textures.ts`、`GpuScene.copyVideo`）。
   */
  video?: SceneVideoSource;
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

/** 粒子材质宏要的系统描述（`readParticleSystem` 的两项，加上这一个变体的 renderer 与系统里有没有拖尾）。 */
export interface ParticleSheetSystem {
  flags: number;
  animationMode: "sequence" | "randomframe";
  /**
   * 这一个变体的 renderer（`SceneParticle.draws` 那一项的种类与朝向模式，P4c 步骤 5；P4f 步骤 4 起一条 renderer 一个变体）：拖尾写
   * `THICKFORMAT`、`TRAILRENDERER`（`particleRendererDefines`），非厚格式 sprite 的非 screen 朝向决定 `TEX0FORMAT`
   * （`particleTex0Format`）。缺省是 screen 朝向的 sprite。
   * rope（P4d 步骤 1）另带 `subdivision`（`TRAILSUBDIVISION`），着色器换成 `ROPE_SHADER`。ropetrail（P4d 步骤 2）同样换着色器，
   * 另带细分与三个开关（`TRAILSCROLLALPHA`、`TRAILFADEALPHA`、`TRAILFADESIZE`）。
   */
  renderer?: {
    kind: ParticleRenderer["kind"];
    orientation: Pick<ParticleRenderer["orientation"], "mode">;
    rope?: Pick<RopeRenderer, "subdivision"> | null;
    ropetrail?: Pick<RopeTrailRenderer, "subdivision" | "scrolling" | "fadeAlpha" | "fadeSize"> | null;
  };
  /**
   * 系统里有 spritetrail（`hasSpriteTrail`，P4f 步骤 4）：厚格式看整个系统（rea-p4f-script.md 8.1 的 `need & 2`，rea-p4b-render.md
   * 2.4），同系统的 sprite 变体也写 `THICKFORMAT`、`TEX0FORMAT` 按厚格式的规则。缺省 false（单 renderer 的 sprite 系统没有拖尾）。
   */
  trail?: boolean;
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
 * sprite 厚格式的写法加 `SPRITESHEET*`（`particleSheetDefines`）。sprite 不写 renderer 宏（朝向不进宏，7.8），只在厚格式时写
 * `THICKFORMAT = 1`（`0x1401d2f78` 分支，rea-p4f-script.md 8.1）：帧表的 `THICKFORMAT` 随 `particleSheetDefines` 写，同系统有
 * spritetrail 时（`system.trail`，P4f 步骤 4，T8：sprite 那次有 `THICKFORMAT`、没有 `TRAILRENDERER`）在这里写。一个系统几条 renderer
 * 就编几个变体，每个变体按自己那条调一次（`compileParticleMaterial`）。
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
  // 同系统有拖尾的 sprite（P4f 步骤 4）：顶点缓冲是厚格式，sprite 的变体也写 THICKFORMAT（帧表时 `particleSheetDefines` 再写一遍同值）
  if (system.trail) return { THICKFORMAT: "1" };
  return {};
}

/**
 * 粒子路径要写的 `TEX0FORMAT` 值（rea-p4b-render.md 2.4，`FUN_1401d2340`）；不写时为 undefined。
 * - 厚格式（拖尾，或槽 0 是帧表；P4f 步骤 4 起同系统有拖尾的 sprite 也是，rea-p4f-script.md 8.1）：只在格式 8–11 时写
 *   （`particleWritesTex0Format`，拖尾分支 `0x1401d2ed1`）；
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
  /**
   * 材质的 `alphawriting`（P8 步骤 5，`writeState.ts` 的 `passAlphaWriting`）：只在 `enabled` / `disabled` 时有；渲染器在按目标、组与上屏
   * 角色算出的缺省写掩码上叠它（`render/writeState.ts` 的 `writesAlpha`）。
   */
  alphaWriting?: AlphaWriting;
  /**
   * 深度 / 剔除三个键：编译期已按 WPE 规整（`features.ts` 的 `normalizeDepthKeys`，P5d 步骤 1），只会是 normal / nocull、enabled /
   * disabled；渲染器按它们给绘制步骤定光栅状态（`render/graph.ts` 的 `rasterState`）。
   */
  cullmode: string;
  depthtest: string;
  depthwrite: string;
  /** 槽位 → bundle 纹理。 */
  textures: Record<number, number>;
  /** 运行时提供的槽位：`_rt_FullFrameBuffer`（场景快照）或本 effect 的 fbo 名（材质 textures 或着色器注解默认值写的）。 */
  runtime: Record<number, string>;
  /**
   * 别的图层的独占 RT（P8 步骤 4，rea-p8-render 2.1）：槽位 → 被依赖图层的 `objects` 下标。材质 `textures` 或注解 `default` 写的
   * `_rt_imageLayerComposite_<id>_a` 指向被依赖的图像层时记在这里（不进 `runtime`），渲染图给出纹理来源 `{ kind: "layer", object }`。
   * 解析不到的名字绑棋盘格（`textures` 里的静态纹理，`compile/dependencies.ts` 的 `checkerTexture`）。没有这种槽时不写这个键。
   */
  layerComposites?: Record<number, number>;
  /**
   * 用户纹理槽（P11b，`compile/usertextures.ts`）：运行中可以换成场景外的图。缺省纹理照旧在 `textures` / `layerComposites` 里，没有图时用它。
   * 没有生效的槽时不写这个键。
   */
  userTextures?: UserTextureSlot[];
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
   * 光标命中（P6c，`render/cursor.ts`）：参与命中测试的对象类别。WPE 只对图像层（类型 1）与文本层（4）做射线对四边形的命中，粒子、
   * 形状、声音、分组节点、灯、相机都不参与（模型是类型 5，P6c 不做，照报 `cursor:model`）。不参与的图层没有这个字段。
   */
  pick?: "image" | "text";
  /**
   * 对象 `solid`（P6c，缺省真）：绑属性、挂脚本的取当时的值（运行时在 `LayerState.solid`，命中每帧现读）。`false` 的对象不收任何光标事件。
   * 只在 `false` 时写（缺省真不占字段）。
   */
  solid?: boolean;
  /**
   * 对象 `disablepropagation`（P6c，JSON 布尔，缺省假）：命中它、且它自身与父链都可见时，下面的对象这一帧不再处理（隐藏的不挡）。
   * 只在 `true` 时写。绑属性、挂脚本的取值照报（`checkObjectFeatures`）。
   */
  disablePropagation?: boolean;
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
   * `_rt_FullFrameBuffer`）或没有纹理时记 `"scene"`，渲染器建合成 RT 时取场景目标尺寸（WPE 取窗口尺寸，我们离屏渲染，对应的就是
   * 场景目标；p5-REPORT「`_rt_FullFrameBuffer` 的尺寸」）。P5d 步骤 2 起不在编译期取 `[general.width, general.height]`：透视场景的
   * 场景尺寸是 0、场景目标按画布定；正交场景两者相同（没超设备上限时字节不变）。不除纹理降级系数。非 fullscreen 为 null，合成 RT 照
   * `compositeSize` 的旧规则。
   */
  fullscreenSize: [number, number] | "scene" | null;
  /**
   * 对象 `copybackground`（缺省 true，只有 JSON false 才关，P5b 步骤 2）：组合层的基础 pass 用基础材质（composelayer 着色器）把层
   * 背后的快照铺进合成 RT；关掉时不画基础材质、合成 RT 0 清成 (0, 0, 0, 0)（`p5b-cl` 的 CL2）。只对组合层起作用，别的图层上中性。
   */
  copyBackground: boolean;
  /**
   * 对象 `clampuvs`（缺省 true，只有 JSON false 才关，P8 步骤 1，p8-REPORT「合成 RT 与基础纹理的采样」、rea-p8-layer §3）：合成 RT 的
   * 寻址，真时钳制、假时重复（`render/graph.ts` 的 `compositeSampling`）。WPE 图层 `+0x304` 的 bit15，基类构造缺省置位，只由对象 JSON
   * （和脚本）写；基础纹理 `.tex` 的 ClampUVs 不参与，它只管基础纹理自己的采样器。全部对象种类都填，没有合成 RT 的图层用不到。
   */
  clampUVs: boolean;
  /**
   * 对象 `nointerpolation`（缺省 false，只认 JSON true，P8 步骤 1，出处同上）：WPE 图层 `+0x304` 的 bit14。为真时合成 RT 用最近邻；
   * 基础纹理 `.tex` 的 NoInterpolation 同样让合成 RT 最近邻，两者取或（`compositeSampling`）。
   */
  noInterpolation: boolean;
  /** 基础材质的 pass。 */
  passes: ScenePass[];
  /** 0 普通；31 上屏改 additive；其它值走 passthrough（B7 / B8）。 */
  colorBlendMode: number;
  effects: SceneEffect[];
  /**
   * colorBlendMode ∉ {0, 31} 时的上屏 pass（`passthroughMaterial`，`BLENDMODE` = colorBlendMode）；被依赖的图层（P8 步骤 4，`dependedOn`）
   * 也编，colorBlendMode ∈ {0, 31} 时 `BLENDMODE` 0（rea-p8-render 第 1 节 `FUN_1401ebbc0`）。
   */
  passthrough: ScenePass | null;
  /**
   * 粒子对象解析出的粒子系统（`particles.ts`）；其它对象、或粒子 JSON 读不到时为 null。粒子材质的 pass 在
   * `particle.passes` 里，不在上面的 `passes`（步骤 4 才接绘制）；第 2 条起的 renderer 的变体在 `particle.draws`（P4f 步骤 4）。
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
   * `model.meshes[m].passes` 里，不在上面的 `passes`。渲染图排成每个网格一个 `mesh` 步骤（P5c 步骤 2，`render/graph.ts` 的
   * `planModelLayer`）。可选同 `text`：不动各处手写的测试图层，读的地方按 null 处理。
   */
  model?: SceneModel | null;
  /**
   * 形状对象（P8 步骤 2，`compileShape`）：`passes` 为空、没有合成 RT，渲染图只画最后一个 effect（`render/graph.ts` 的
   * `planShapeLayer`）。其它对象为 null。可选同 `text`：不动各处手写的测试图层，读的地方按 null 处理。
   */
  shape?: SceneShape | null;
  /**
   * 对象 `alignment`（P8 步骤 3，rea-p8-layer 2.1、2.2，p8-REPORT 结论 6）：`compile/alignment.ts` 的 `ALIGNMENTS` 下标，0 是 `center`。
   * 只有图像层（`compileImageModel`）填：对象 JSON 的值是字符串时查表，查不到或不是字符串（含 `{user, value}`）为 0，不登记绑定（WPE
   * 的 JSON setter 没有绑定分支）。它让图层画自己时多一段平移 `alignmentOffset(alignment, size)`（`render/state.ts` 写进
   * `LayerState.offset`，`render/layout.ts` 的 `drawMatrixOf`），子层不带。有值也是「图像层」的标记：脚本的 `alignment` 访问器只装在
   * 有值的图层上（`script/api.ts`）。其它对象不填；可选同 `text`：不动各处手写的测试图层。
   */
  alignment?: number;
  /**
   * 被依赖（P8 步骤 4，rea-p8-render 第 1、2 节，p8-REPORT 结论 7–9）：图像层（走到 `compileImageModel` 的对象）的 JSON `id` 在全部对象
   * `dependencies` 的并集里（`compile/dependencies.ts` 的 `dependencyIds`），即 WPE 的 `+0x304 |= 0x1010`。编译期定下、运行中不变：
   * - 渲染图（`render/graph.ts` 的 `planLayer`）：强制走合成路径，全部 effect 留在合成链，`passthrough` 上屏，最后一次写入落在合成 RT 0；
   * - 渲染器（`render/scene.ts`）：合成 RT 0 是本层独占、跨帧保留的 RT，引用方的 `{ kind: "layer" }` 解析到它；不可见（自身或祖先）
   *   也建资源、照画进 RT，只跳过画到场景的那一步上屏。
   * 只有图像层填；可选同 `alignment`：不动各处手写的测试图层。
   */
  dependedOn?: boolean;
  /**
   * puppet（P12a 步骤 3，rea-p12-mdl 第 9 节）：图像层的模型 JSON 带 `puppet`（字符串、不是 fullscreen、不是组合层）且 mdl 有网格时有；
   * 网格 0 代替上屏的四边形。`layer.passes` 保持不带 puppet 组合键（合成路径的基础 pass 画四边形进合成 RT，要用它）。读不到 mdl 或网格
   * 为空时为 null（WPE 销毁 P、照常画四边形，不报）。可选同 `alignment`：不动各处手写的测试图层。
   */
  puppet?: ScenePuppetLayer | null;
  /**
   * 相机对象（P5d 步骤 3，`isCameraObject`，rea-p5-camera 4.1、4.2）：`fov` / `zoom` 的编译期值（缺省 50 / 1，取值规则 `cameraValue`），
   * 绑属性或挂 `{script}` 时登记成就地目标 `{ kind: "camera" }`，运行中的值在 `SceneState.cameras`。图层本身没有 pass，变换、层级、可见性
   * 照分组节点；渲染器每帧按 `objects` 倒序选第一个自身与父链都可见的相机（`render/camera.ts` 的 `activeCameraObject`）。同时带别的内容
   * 的对象（`object:camera:mixed`）与其它图层为 null。可选同 `text`：不动各处手写的测试图层，读的地方按 null 处理。
   */
  camera?: { fov: number; zoom: number } | null;
  /**
   * 透明排序的类别（P5d 步骤 4，`SortClass`）：编译期照 WPE 加载时的规则定（对象 `+0x120` 的 bit8「进半透明名单」、bit9「键为 −∞」），
   * 之后不变（WPE 在加载末尾置位，运行中不改）。只在透视场景开了 `transparentsorting` 时被渲染器读（`render/sortOrder.ts`）。
   * - 粒子：`translucent`（构造即进名单，rea-p5-mesh 4.2）；
   * - 图像层（含组合层、fullscreen、instanced、被依赖的）：基础材质第一个 pass 的混合（`isOpaqueBlending`），带 effect、走 passthrough
   *   都只看它；半透明且模型标志 `fullscreen` / `projectlayer` 为 JSON true 时是 `last`（`imageSortClass`，rea-p5-modelflags 1.4、2.1）；
   * - 模型：任一网格第一个 pass 不透明就是 `opaque`，否则 `translucent`（rea-p5-mesh 2.4）；
   * - 文本：`translucent`（构造函数无条件置 bit8，rea-p6b-layout 1.1，不看材质）；
   * - 形状：`opaque`（工厂 `0x14019075e`–`0x1401907de` 只调基类构造，加载 `FUN_14025fac0` → `FUN_1401e6f50` → `FUN_1401de470` 都不置
   *   bit8，所以不进名单；形状在透视场景照报 `camera:perspective:shape`，只有强制渲染时用到）；
   * - 不画的对象（分组节点、灯、声音、相机）与读不到模型 / 材质的图层不填。
   * 可选同 `text`：不动各处手写的测试图层，缺省按不在半透明名单处理。
   */
  sortClass?: SortClass;
}
/**
 * 图层上的 puppet（P12a 步骤 3 点 1，rea-p12-mdl 9.2–9.4）：`compile/puppet.ts` 的 `ScenePuppet` 加上两条上屏路径的材质变体。路径在编译期
 * 定（WPE 加载时就置 `0x10`，之后不变）：
 * - `composite`：图层有 effect（`layer.effects` 非空，含运行时才打开的）、colorBlendMode ∉ {0, 31} 或被依赖。基础 pass 照旧（`layer.passes`，
 *   画四边形进合成 RT）、effect 全部留在合成链，最后用 `upload`（passthrough 材质 + puppet 组合键 + `BLENDMODE`）以 puppet 网格采样合成 RT
 *   上屏，UV 不缩放；
 * - 否则直接上屏：`passes` 是基础材质加 puppet 组合键的变体（稳定键同基础 pass，常量与绑定共用），画 puppet 网格，UV 乘「图像 / GPU 纹理」。
 * 静态 puppet（没有骨骼，`combos` 为空）也走这两条路径，只是材质不带组合键、不写 `g_Bones`。
 */
export interface ScenePuppetLayer extends ScenePuppet {
  composite: boolean;
  /** 直接上屏的 pass（基础材质 + puppet 组合键）；composite 时为空。 */
  passes: ScenePass[];
  /** 合成路径的上屏 pass（passthrough 材质 + puppet 组合键 + `BLENDMODE`）；直接上屏时为 null。 */
  upload: ScenePass | null;
}
/**
 * 透明排序的类别（P5d 步骤 4，rea-p5-mesh 4.2）：`opaque` 在第一遍按 `objects` 顺序画；`translucent` 在第二遍按「局部 origin · 前向」从大到小
 * 画；`last` 也在第二遍、键是 −∞（排在最后）。
 */
export type SortClass = "opaque" | "translucent" | "last";

/** 不透明的混合（WPE 的 0 normal、3 alphatocoverage）：透明排序的类别与模型的网格顺序（`meshDrawOrder`）共用这一个判定。 */
export function isOpaqueBlending(blending: string | undefined): boolean {
  return blending === "normal" || blending === "alphatocoverage";
}
/**
 * 图像层的透明排序类别（P5d 步骤 4，rea-p5-modelflags 2.1、1.4）：基础材质不透明为 `opaque`；否则带模型标志 `fullscreen` / `projectlayer`
 * （`sortLast`）时为 `last`，不带为 `translucent`。标志只在半透明时起作用：不透明的图层不进名单，键用不到。
 */
export function imageSortClass(blending: string | undefined, sortLast: boolean): SortClass {
  if (isOpaqueBlending(blending)) return "opaque";
  return sortLast ? "last" : "translucent";
}
/** 形状对象（P8 步骤 2，rea-p8-layer §1，p8-REPORT 结论 4、5）：图层的 `passes` 为空，没有合成 RT，渲染图只画最后一个 effect（`planShapeLayer`）。 */
export interface SceneShape {
  /**
   * 第一个 effect 第一个绘制 pass 的材质常量 `point0`–`point3`（实例覆盖、注解缺省都算，按材质名从程序反射找，`size` 方块里的
   * 归一化坐标，y 向下）；四个找不全时 null，几何退回以原点为中心的 `size` 方块（`render/layout.ts` 的 `shapeQuad`）。编译期取一次
   * （WPE 改常量不重建四边形，rea-p8-layer 1.3，推断；我们的常量就地写也不碰顶点，语义相同）。
   */
  points: [number, number][] | null;
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
   * 用到的用户纹理来源（P11b）：全部 `ScenePass.userTextures` 的来源去重，按首次出现的顺序。宿主加载时对属性来源的当前值预先解码，
   * 第一帧就是用户图。缺省（测试夹具、旧 bundle）等于空。
   */
  userTextures?: UserTextureSource[];
  /**
   * 泛光链（`bloom.ts`）；档位关闭、场景没有对象，或 `general.bloom` 写死 false（没绑属性、没挂脚本）时为 null，渲染路径与 P2a 相同。
   * 有链不等于开着：当前开不开看 `SceneState.bloomEnabled`，关着时渲染路径同样与 P2a 相同。
   */
  bloom: SceneBloom | null;
  /**
   * 平面反射 RT（P13b1，`_rt_Reflection`）：只有模型的网格材质读它时 WPE 才建这张 RT，才有反射 pass（rea-p13-passes 1.1、1.4）；
   * 只有图像层 / 粒子读它时 WPE 不建，那一槽绑的是棋盘格占位（编译期已改成静态纹理，不记这个键）。`compileScene` 在有模型读时才写。
   */
  reflection?: { planar: boolean };
  /** `_rt_MipMappedFrameBuffer` 被任何对象读到（P13b1〔g1〕，rea-p13-passes 4.1）：渲染器建带 mip 的 RT，反射关时加载时清成 (0, 0, 0, 1)。 */
  mipFramebuffer?: boolean;
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
   * 属性关键帧动画（P10a 步骤 2，`animations.ts`）：`scene.json` 里每处没被丢弃、有就地目标的关键帧值一条，按登记顺序。材质常量的
   * 目标在编译 pass 时补 uniform（`settleConstantAnimation`）。`compileScene` 总会给出；可选只是为了不动各处手写的测试 bundle，
   * 读的地方按空表处理。
   */
  animations?: SceneAnimation[];
  /**
   * 场景用音频（P4e 步骤 4）：`project.json` 的 `general.supportsaudioprocessing` 是 JSON `true`（WPE 只认 bool 真，`FUN_14010d100`，
   * rea-p4e-audio.md 4.1），且有粒子系统（含子系统）带 `audioprocessingmode ≠ 0` 的模块（`particleUsesAudio`），或有程序读音频频谱
   * uniform（P11a，`readsAudioUniforms`）。为真时宿主加载就订阅 `WpeMediaHub`（脚本注册音频缓冲时另外照旧订阅）。`compileScene` 总会
   * 给出；可选只是为了不动各处手写的测试 bundle，缺省按 false。
   */
  audio?: boolean;
}
export interface CompileSceneInput {
  projectDir: string;
  sceneAssets: string[];
  userProperties?: Record<string, unknown>;
  /** 脚本写入的重编译目标，按 scene.json 坐标覆盖编译输入。 */
  scriptOverrides?: Record<string, number[] | boolean | string>;
  reader: SceneReader;
  translator: Wpesl2wgsl | null;
  /** 设置「场景后处理」；缺省跟随 WPE。 */
  postprocess?: ScenePostprocessSetting;
  /** 设置「场景反射」（P13b1）；缺省跟随 WPE 的 `general.user.reflection`（缺键当开）。 */
  reflection?: SceneReflectionSetting;
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
/** 平面反射 RT（P13b1）：反射关时每帧清成场景清屏色。 */
export const REFLECTION_RT = "_rt_Reflection";
/** 屏幕空间反射用的 mip 帧缓冲（P13b1〔g1〕）：反射关时加载时清成 (0, 0, 0, 1)、之后不更新。 */
export const MIP_FRAMEBUFFER_RT = "_rt_MipMappedFrameBuffer";

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
 * 尺寸不在这里：前者随图像层帧动画（`tex:animation`），后者照报（`material:usertextures`）。透视场景里正交投影宽高是 0，
 * `projectlayer` 没测过（语料 0），`compileImageModel` 报 `camera:perspective:projectlayer`，这里照算（0）。
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
 * 形状对象的尺寸 `Sx × Sy`（P8 步骤 2，rea-p8-layer 1.3，p8-REPORT `p8-shape` 的 S1、S10）：加载时先写 `(正交高, 正交高)`（不是宽 × 高，
 * 形状虚表 +0x40），对象 JSON 写了 `size` 再覆盖（基类的 setter `0x1401a3fc0`：字符串按空格拆两个 float、数字铺满两维、`null` 不写）。
 * `value` 是解析后的值（`{user}` 已换成属性值）；字符串里缺的分量保持正交高（推断：setter 只写读到的分量，语料 0 个形状写 `size`），
 * 别的类型不写。`orthographicHeight` 是 `SceneGeneral.height`（透视场景里 WPE 取 1，没测过、语料 0，能力表报
 * `camera:perspective:shape`，这里照算）。
 */
export function shapeLayerSize(value: SceneScalar | undefined, orthographicHeight: number): number[] {
  const h = orthographicHeight;
  if (typeof value === "number") return Number.isFinite(value) ? [value, value] : [h, h];
  const parsed = typeof value === "string" ? numbers(value) : [];
  return [parsed[0] ?? h, parsed[1] ?? h];
}

/** 形状四边形的四个点的材质常量名（`lightshafts` 的 `g_Point0`–`g_Point3` 的注解），按 p0–p3 的顺序。 */
export const SHAPE_POINT_CONSTANTS = ["point0", "point1", "point2", "point3"] as const;

/**
 * 形状四边形的点（P8 步骤 2，rea-p8-layer 1.3 `FUN_140260190`，p8-REPORT 结论 5 的 `p8-shape2`）：**第一个** effect 的第一个绘制 pass，
 * 在它的程序反射里按 `meta.material` 找 `point0`–`point3`，值取 `pass.uniforms[uniform 名]` 的前两项（实例覆盖、注解缺省都已在里面）。
 * 翻译器把两阶段同名的 uniform 拆成 `kb_vs_` / `kb_fs_` 两格时任取一个有值的（同一个键在 WPE 里只有一份存储）。四个找不全、第一个
 * effect 没有绘制 pass 或程序时返回 null（WPE 退回以原点为中心的方块）。画的却是**最后一个** effect（`render/graph.ts` 的
 * `planShapeLayer`），两者不是同一个时四边形和着色器里的 `g_Point*` 对不上，照 WPE。
 */
export function shapePoints(
  layer: Pick<SceneLayer, "effects">,
  programs: readonly Pick<TranslateResult, "uniforms">[],
): [number, number][] | null {
  const step = layer.effects[0]?.steps.find((item) => item.kind === "draw");
  if (step?.kind !== "draw") return null;
  const { pass } = step;
  if (pass.program === null) return null;
  const uniforms = programs[pass.program]?.uniforms ?? [];
  const points: [number, number][] = [];
  for (const material of SHAPE_POINT_CONSTANTS) {
    const value = uniforms
      .filter((uniform) => uniform.meta?.material === material)
      .map((uniform) => pass.uniforms[uniform.name])
      .find((values) => (values?.length ?? 0) >= 2);
    if (!value) return null;
    points.push([value[0], value[1]]);
  }
  return points;
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
/** 解析后的 `colorBlendMode` → 图层字段的值（缺省 0、取整）。图层字段与依赖的名字表（P8 步骤 4）共用。 */
const colorBlendModeOf = (value: SceneScalar | undefined): number => Math.trunc(asNumber(value, 0));

/**
 * 走到 `compileImageModel` 的对象（P8 步骤 4 的名字表用）：判定与 `compileScene` 的对象循环逐条一致——不是粒子、模型、声音、形状、文本，
 * 有 `image`。改循环的分派时这里跟着改。
 */
function isImageLayerObject(object: SceneObject): boolean {
  const kind = objectKind(object);
  return (
    kind !== "particle" &&
    kind !== "model" &&
    !isSoundObject(object) &&
    !isShapeObject(object) &&
    !isTextObject(object) &&
    !!object.image
  );
}

/** 对象 JSON 的 `id`（P8 步骤 4）：非负整数才算（WPE 的 id 是 64 位无符号整数，`dependencies` 也只收这种）；别的写法为 null。 */
function jsonId(object: SceneObject): number | null {
  const id: unknown = object.id;
  return typeof id === "number" && Number.isInteger(id) && id >= 0 ? id : null;
}

/** pass 稳定键里的对象下标（`objects/<i>/…`）；不是对象的 pass（泛光等）为 null。依赖的 `dependency:self` 与格式规则用（P8 步骤 4）。 */
function passObject(key: TargetKey): number | null {
  const match = /^objects\/(\d+)\//.exec(key);
  return match ? Number(match[1]) : null;
}
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
/** 合并后的 `usertextures` 有就写进 pass，没有就不加这个键（`mergeUserTextures` 两边都不是数组时返回 undefined）。 */
function userTexturesOf(merged: unknown[] | undefined): { usertextures?: unknown[] } {
  return merged ? { usertextures: merged } : {};
}
/**
 * instanced 对象的 `instance`（P5b 步骤 5）里参与合并的两个键：`combos` 是对象才合并、`textures` 是数组才按槽合并；整个不是对象时
 * 为 null（不合并）。取值不合规的由 `checkInstanceFeatures` 照报。
 */
function instanceOverride(raw: unknown): Pick<MaterialPass, "combos" | "textures" | "usertextures"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { combos, textures, usertextures } = raw as Record<string, unknown>;
  return {
    combos:
      combos && typeof combos === "object" && !Array.isArray(combos)
        ? (combos as Record<string, number | boolean>)
        : undefined,
    textures: Array.isArray(textures) ? textures : undefined,
    usertextures: Array.isArray(usertextures) ? usertextures : undefined,
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
   * effect 实例从 `scene.json` 覆盖进来的常量（`passes[k].constantshadervalues`）：它们上面的关键帧由 `collectAnimations` 处理，
   * 能力检查只扫材质 JSON 自己的（`checkPassFeatures` 的 `sceneConstants`，P10a 步骤 2）。
   */
  sceneConstants?: Readonly<Record<string, unknown>>;
  /** 模型的网格材质（P13b1）：只有它读 `_rt_Reflection` 才算 WPE 建了那张 RT。 */
  model?: boolean;
  /** instanced 图层（P11b）：对象 `size` 解析出的用户纹理参考尺寸；非 instanced 不传（`parseUserTextures` 的 `options.instanceSize`）。 */
  instanceSize?: { width: number; height: number } | null;
  /** puppet 的 pass（P12a）：程序检查放行 `SKINNING` 组合键与 `g_Bones`（`PUPPET_UNIFORMS`）。 */
  puppet?: boolean;
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
  // 属性关键帧（P10a 步骤 2）：没有就地目标的照报细分键（`value:animation:light` / `camera` / `other`）；其余进 bundle，
  // 由宿主每帧写（P10a 步骤 3，`animation/player.ts`）
  const animations = collectAnimations(scene);
  for (const key of animations.unsupported) unsupported.add(key);
  checkScriptFeatures(scripts.list, unsupported, scene.objects);
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
  /** 投影类型只在这里判一次（P5d 步骤 2）：能力表、`SCENE_ORTHO`、粒子缺省值、渲染器都读 `general.perspective`。 */
  const orthographic = isOrthographic(general);
  const bundle: SceneBundle = {
    general: {
      // 透视场景是 WPE 的 0（rea-p5-camera 2.1）；`auto: true` 的正交场景没写宽高时仍是占位 1920×1080（`q4-eye-auto`，本机 0 张）
      width: orthographic ? (projection.width ?? 1920) : 0,
      height: orthographic ? (projection.height ?? 1080) : 0,
      perspective: !orthographic,
      camera: orthographic ? null : await compileCamera(scene, fs, unsupported),
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
      // 只认 JSON 布尔（P5d 步骤 4）：绑属性、挂脚本由能力表照报，这里不登记绑定。正交场景也照记，渲染器只在透视场景读
      transparentSorting: general.transparentsorting === true,
    },
    layers: [],
    programs: [],
    textures: [],
    userTextures: [],
    bloom: null,
    unsupported: [],
    // 同一个数组随编译继续填充，最后就是全部登记项
    bindings: bindings.list,
    scripts,
    sounds,
    animations: animations.list,
  };
  const counts = lightCounts(general);
  for (const issue of lightConfigIssues(general)) unsupported.add(issue);
  const shader = new ShaderCompiler(
    fs,
    input.translator,
    unsupported,
    litDefines(counts),
    engineDefines(postprocess.hdr, orthographic),
  );
  /** 开了光照的程序才读；没人用时不解析灯对象，也不登记它们的绑定。 */
  let lights: Record<string, number[]> | null = null;
  const sceneLights = () =>
    (lights ??= lightUniforms(
      scene.objects,
      counts,
      bindingReader(bindings, properties, (path) => recompile("layer-structure", path)),
    ));
  /** 遗留灯（P13a）：程序读到三个数组之一才算；同 `sceneLights` 只解析一次。 */
  let legacy: Record<string, number[]> | null = null;
  const legacyLights = () =>
    (legacy ??= legacyLightUniforms(
      scene.objects,
      bindingReader(bindings, properties, (path) => recompile("layer-structure", path)),
    ));
  // 父对象下标；环已断开，`object:parent-cycle` 由能力表报
  const { parents } = resolveParents(scene.objects);
  // 图层依赖（P8 步骤 4，rea-p8-render 第 1、2 节）：WPE 在全部对象加载完之后才按并集给图像层置 `0x1010`、建独占 RT，材质却在创建时就按
  // 名字绑纹理表里的对象（RT 建立时接管同名对象），所以引用方排在被依赖者前后都绑得上。我们在开头一次定下并集与名字表，编到哪个 pass 都查得到
  const dependedIds = dependencyIds(scene.objects);
  const isDepended = (object: SceneObject): boolean => {
    const id = jsonId(object);
    return id !== null && dependedIds.has(id);
  };
  /**
   * 名字表：每个图像层（`isImageLayerObject`）的 `_rt_imageLayerComposite_<id>_a` → `objects` 下标、是否被依赖、自己有没有 `0x10`
   * （`ownComposite`：colorBlendMode ∉ {0, 31}，按属性当前值求、不登记绑定——字段本身在对象循环里已登记成重编译）。id 重复时后面的胜出
   * （WPE 后建的 RT 再次接管同名对象，rea-p8-render 2.1）。
   */
  const layerComposites = new Map<string, { object: number; depended: boolean; ownComposite: boolean }>();
  scene.objects.forEach((object, index) => {
    const id = jsonId(object);
    if (id === null || !isImageLayerObject(object)) return;
    const cbm = colorBlendModeOf(resolveValue(object.colorBlendMode as SceneValue, properties));
    layerComposites.set(layerCompositeName(id), {
      object: index,
      depended: dependedIds.has(id),
      ownComposite: cbm !== 0 && cbm !== 31,
    });
  });
  /** 棋盘格（`checkerTexture`）在 `bundle.textures` 里的下标：第一次用到时加，各处共用。 */
  let checker: number | null = null;
  const checkerIndex = (): number => {
    if (checker === null) {
      checker = bundle.textures.length;
      bundle.textures.push(checkerTexture());
    }
    return checker;
  };
  /**
   * 读 `_rt_Reflection` 的 pass 槽（P13b1，rea-p13-passes 1.1）：全部对象编完之后看有没有模型的网格读它；没有就把别的读者那一槽
   * 改绑棋盘格。记的是 pass 自己的 `runtime` / `textures` 对象，回改直接作用在已编好的 pass 上。
   */
  const reflectionReaders: {
    runtime: Record<number, string>;
    slots: Record<number, number>;
    slot: number;
    model: boolean;
  }[] = [];
  /** 有 pass 读 `_rt_MipMappedFrameBuffer`（P13b1〔g1〕）。 */
  let mipReaders = false;
  // 粒子字段的缺省值按正交 / 透视选两套（`rea-p4a.md`「基础」），读上面的 `orthographic`
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
      video: tex.video,
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
   * 拖尾另写 `THICKFORMAT`、`TRAILRENDERER`（`particleRendererDefines`，P4c 步骤 5），同系统有拖尾的 sprite 另写 `THICKFORMAT`
   * （P4f 步骤 4）。
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
    // 拖尾一定走厚格式（`need |= 2`），帧表的 sprite 也是（rea-p4b-render.md 2.4）；厚格式看整个系统，同系统有拖尾的 sprite 也是
    // （`system.trail`，P4f 步骤 4，rea-p4f-script.md 8.1）。rope 两类的 `TEX0FORMAT` 同样只看 8–11（rea-p4d-rope.md 3.4：不像非厚格式
    // sprite 那样也看朝向；ropetrail 虽是非厚格式，也只看格式）
    const thick = rope || system.renderer?.kind === "spritetrail" || !!system.trail || !!texture?.sheet;
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
    // 透视场景里的透视粒子（`flags & 4`）：读码说 W = H = 0 时覆盖的 fov 退化（rea-p5-camera 7.2），步骤 0 只测了 MVP，照报
    if (bundle.general.perspective && usesPerspectiveParticles(layer.particle))
      unsupported.add("camera:perspective:particle");
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
   *   JSON `children` 里的下标（不认识的类型丢掉之后也不移位）。第 r 条 renderer（r ≥ 1）的变体在系统键后接 `renderers/<r>`
   *   （P4f 步骤 4，`compileParticleMaterial`）。
   * - `instanceoverride`：只有顶层登记绑定（就地目标是对象的）；子系统按缺省值解析，实例值由模拟器从对象上传下去（`ParticleSystem`
   *   的 `link`，rea-p4e-children 3.4）。能力上子系统按自己的 `flags` 再查一遍对象的 `instanceoverride`（`color`、`colorn` 的照报项
   *   看各自的 bit3）。
   * - 场景 HDR（`postprocess.hdr`）顶层与子系统都写进 `SceneParticle.hdr`（P4f 步骤 2）：`brightness` 是否乘颜色初值由模拟器按各自的
   *   `flags & 8` 定（rea-p4f-script.md 第 7 节）。
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
    // `instanceoverride` 的标量键与 `colorn` 登记成就地目标（P4a 步骤 5、P4b 步骤 6）。`brightness` 也是（P4f 步骤 2）：HDR 只在
    // 加载时判定，改值和别的系数一样置脏、下一帧重算颜色初值（rea-p4f-script.md 第 7 节）；LDR 或 bit3 时模拟器不乘，同样中性
    const { flags } = readParticleSystem(system);
    const instanceTarget = (field: InstanceKey): BindingTarget => ({ kind: "particle-instance", object: index, field });
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
      // 场景加载时判定的 HDR（P4f 步骤 2）：顶层与子系统都写
      hdr: postprocess.hdr,
    });
    checkParticleInstance(object.instanceoverride, { flags }, unsupported);
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

  /**
   * 粒子系统的材质（P4a 步骤 2）：pass 放进 `particle.passes`，稳定键 `<key>/passes/<k>`；帧表纹理定 `spriteSheet`。
   * 一个系统多条 renderer（P4f 步骤 4，rea-p4f-script.md 8.1）：WPE 对 renderer 流逐条用同一个基础材质按类型加宏建一个变体，这里同样
   * 每个 `draws` 项编一份，放进那一项的 `passes`。第 0 项就是 `particle.passes`、沿用 `<key>/passes/<k>`（单 renderer 系统的键、宏、程序、
   * 常量、管线缓存都不变）；第 r 项（r ≥ 1）是 `<key>/renderers/<r>/passes/<k>`（子系统的 `key` 已带自己的 `children/<n>`）。材质常量的
   * 用户属性按 pass 键登记（`shaderUniforms`），每个变体各登记一份，改值时都写到。`renderer: []`（`draws` 为空）时照旧按缺省 sprite 编一份
   * 放进 `passes`，只给「有没有材质」「要不要帧缓冲」用。厚格式看整个系统（`hasSpriteTrail`）。
   */
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
    const trail = hasSpriteTrail(particle);
    const variants = particle.draws.length
      ? particle.draws
      : [{ renderer: particle.renderer, passes: particle.passes }];
    for (const [r, draw] of variants.entries()) {
      const sheetSystem: ParticleSheetSystem = {
        flags,
        animationMode: particle.animationMode,
        renderer: draw.renderer,
        trail,
      };
      const base = r === 0 ? key : `${key}/renderers/${r}`;
      for (const [k, pass] of material.passes.entries())
        draw.passes.push(await compilePass(pass, { key: `${base}/passes/${k}`, particle: sheetSystem }));
    }
    // 基础材质槽 0 的纹理带帧表：WPE 置系统的 `0x1000000`，模拟器据此每帧算 frame（rea-p4b-render.md 2.3、2.5）
    const slot0 = particle.passes[0]?.textures[0];
    particle.spriteSheet = slot0 !== undefined && !!bundle.textures[slot0].sheet;
  }

  /** puppet 图层的基础材质 pass（实例覆盖之后，`compileImageModel` 记、`finalizePuppet` 用），按 `objects` 下标。 */
  const puppetMaterials = new Map<
    number,
    { passes: MaterialPass[]; instanceSize: { width: number; height: number } | null }
  >();
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
   * 材质（`meshSkin`），走图像层同一条 `compilePass`（深度 / 剔除和别的 pass 一样按 `normalizeDepthKeys` 规整；静态网格不追加
   * 引擎 COMBO，rea-p5-mesh 2.4）；稳定键 `objects/<i>/meshes/<m>/passes/<k>`。网格的顶点 / 索引字节是文件缓冲的视图，材质按对象
   * 各编一份（`skin` 可能不同）。
   * 绘制顺序在这里排好（`meshDrawOrder`，看每个网格第一个 pass 的 blending）。绘制在 P5c 步骤 2 接上（`render/graph.ts` 的
   * `planModelLayer`），步骤 1 的过渡键 `model:pending` 已去掉。
   */
  async function compileModel(index: number, object: SceneObject, layer: SceneLayer): Promise<void> {
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
    const opaque = meshes.map((mesh) => isOpaqueBlending(mesh.passes[0]?.blending));
    layer.model = { path, version: file.version, meshes, order: meshDrawOrder(opaque), bounds: file.bounds };
    // 透明排序（P5d 步骤 4，rea-p5-mesh 2.4）：WPE 先置「半透明」，任一网格的材质不透明就改回不透明，所以只有网格全半透明的模型进名单
    // （`p5d-sort-a` 的 M1 / M2）。没有网格时保持半透明，同 WPE（反正不画）
    layer.sortClass = opaque.some(Boolean) ? "opaque" : "translucent";
  }

  /**
   * 模型的一个网格：编选中的材质，按网格格式查程序读到的属性（`checkMeshAttributes`）。材质读 `_rt_FullFrameBuffer` 报
   * `mdl:framebuffer`（P5c 步骤 2）：WPE 的模型绘制不拷快照（rea-p5-mesh 2.6 没有拷贝这一步），读到的是什么没测，语料 0 个。
   */
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
      const compiled = await compilePass(pass, {
        key: `objects/${index}/meshes/${m}/passes/${k}`,
        model: true,
      });
      if (compiled.program !== null) checkMeshAttributes(bundle.programs[compiled.program], mesh.format, unsupported);
      if (compiled.framebuffer) unsupported.add("mdl:framebuffer");
      out.passes.push(compiled);
    }
    return out;
  }

  /** 编译一个材质 pass：纹理（含 `_rt_*` 与着色器注解默认值）、着色器、uniform、能力检查。 */
  async function compilePass(pass: MaterialPass, context: PassContext): Promise<ScenePass> {
    const issues = context.unsupported ?? unsupported;
    checkPassFeatures(pass, issues, { sceneConstants: context.sceneConstants });
    const scope = context.scope ?? null;
    const names = (pass.textures ?? []).map(textureName);
    const slots: Record<number, number> = {};
    const runtime: Record<number, string> = {};
    const formats: ShaderTextureSlot[] = [...(context.planned ?? [])];
    const planned = new Set(formats.map((item) => item.slot));
    const bindRuntime = (slot: number, name: string): boolean => {
      if (name === FRAMEBUFFER_RT) runtime[slot] = name;
      else if (context.fbos?.has(name)) runtime[slot] = name;
      else if (name === REFLECTION_RT) {
        runtime[slot] = name;
        reflectionReaders.push({ runtime, slots, slot, model: !!context.model });
      } else if (name === MIP_FRAMEBUFFER_RT) {
        runtime[slot] = name;
        mipReaders = true;
      } else return false;
      return true;
    };
    /** 运行时 RT 的格式（着色器的 `TEX<n>FORMAT`）：反射图是 RGBA8，mip 帧缓冲跟场景目标，其余按 effect 的 fbo。 */
    const runtimeFormat = (name: string): number =>
      name === MIP_FRAMEBUFFER_RT && postprocess.hdr
        ? FBO_FORMATS.rgba16161616f.tex
        : FBO_FORMATS[context.fbos?.get(name)?.format ?? "rgba8888"].tex;
    /** 别的图层的独占 RT（P8 步骤 4）：槽位 → 被依赖图层的 `objects` 下标。 */
    const composites: Record<number, number> = {};
    /** 绑了棋盘格占位的槽（`_rt_imageLayerComposite_*` 没被依赖）：用户纹理的缺省是占位时照报（P11b）。 */
    const placeholders = new Set<number>();
    const owner = passObject(context.key);
    /**
     * `_rt_imageLayerComposite_*`（P8 步骤 4，rea-p8-render 2.1、2.6，p8-REPORT 结论 7、8、12）：返回 false 表示不是这种名字。
     * - 名字表里有、被依赖：记进 `layerComposites`，渲染器绑那张独占 RT；被依赖者就是本 pass 所属的对象时照报 `dependency:self`
     *   （读写同一张，WPE 怎么处理没测，语料 0 处）；
     * - 其余（没被依赖、id 不存在、不是图像层、`_b`）：绑棋盘格（WPE 的占位文件纹理）；名字表里有、没被依赖、自己却有 `0x10` 时照报
     *   `dependency:passthrough-undeclared`（WPE 绑得上它自己的 `_a`，我们只给独占 RT 给被依赖的图层，语料 0 处）。
     * `TEX<n>FORMAT`（只在 `formatcombo` 槽上起作用，`withFormat` 为假时不加，同注解缺省的静态纹理）：取材质创建那一刻纹理表里那个对象的格式。
     * 经 `dependencies` 置位的 RT 在全部材质之后才建，那一刻是占位的 0；被依赖者自己就有 `0x10` 且排在本对象前面时 RT 已经建好，HDR 下是
     * RGBA16F 的 14、LDR 是 0（核对表最后一行，语料都是 0）。棋盘格是 0。
     */
    const bindLayerComposite = (slot: number, name: string, withFormat: boolean): boolean => {
      if (!name.startsWith(LAYER_COMPOSITE_PREFIX)) return false;
      const entry = layerComposites.get(name);
      let format = FBO_FORMATS.rgba8888.tex;
      if (entry?.depended) {
        composites[slot] = entry.object;
        if (entry.object === owner) issues.add("dependency:self");
        if (postprocess.hdr && entry.ownComposite && owner !== null && entry.object < owner)
          format = FBO_FORMATS.rgba16161616f.tex;
      } else {
        if (entry?.ownComposite) issues.add("dependency:passthrough-undeclared");
        slots[slot] = checkerIndex();
        placeholders.add(slot);
      }
      if (withFormat) formats.push({ slot, format });
      return true;
    };
    for (const [slot, name] of names.entries()) {
      if (!name || planned.has(slot)) continue;
      // 别的图层的合成 RT（P8 步骤 4）：排在 `_rt_*` 之前（前缀相同），`planned` 的槽（`bind` 胜出，rea-p8-render 第 3 节）上面已跳过
      if (bindLayerComposite(slot, name, true)) continue;
      if (name.startsWith("_rt_")) {
        if (bindRuntime(slot, name)) formats.push({ slot, format: runtimeFormat(name) });
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
    // 用户纹理（P11b 步骤 1）：缺省纹理解析完才能定参考尺寸。只有 `textures[slot]` 是非空字符串且这一槽由材质自己绑的才生效
    // （`planned` 的槽由渲染图填、`names` 为空的槽什么都不绑，`defaultOf` 都返回 undefined）
    const defaultOf = (slot: number): UserTextureDefault | undefined => {
      if (!names[slot] || planned.has(slot)) return undefined;
      if (slot in composites) return { kind: "layer", object: composites[slot] };
      if (placeholders.has(slot)) return { kind: "placeholder" };
      if (slot in runtime) return { kind: "runtime", name: runtime[slot] };
      const texture = slots[slot] === undefined ? undefined : bundle.textures[slots[slot]];
      return texture ? defaultOfTexture(texture) : undefined;
    };
    const userTextures = parseUserTextures(pass, defaultOf, {
      instanceSize: context.instanceSize,
      particle: !!context.particle,
    });
    for (const key of userTextures.issues) issues.add(key);
    for (const { source } of userTextures.slots) {
      if (!(bundle.userTextures ??= []).some((item) => item.kind === source.kind && item.name === source.name))
        bundle.userTextures.push({ ...source });
      if (source.kind === "property") bindings.bindUserTexture(source.name);
    }
    // rope 两类系统的 pass 无条件换成 `genericropeparticle`、带 `.geom` 翻译（P4d 步骤 1、2，rea-p4d-rope.md 第 6 节，见 `ROPE_SHADER`）
    const rope = isRopeRenderer(context.particle?.renderer?.kind);
    const shaderName = rope ? ROPE_SHADER : pass.shader;
    const defines =
      context.particle && shaderName
        ? await particleDefines(pass, shaderName, formats, slots, scope, context.particle)
        : {};
    const result = shaderName
      ? await shader.compile(shaderName, materialCombos(pass), formats, scope, issues, defines, rope)
      : null;
    if (result?.ok) {
      const slots = materialSlots(result.uniforms ?? []);
      for (const script of scripts.list) {
        if (script.owner.kind !== "material" || script.owner.pass !== context.key || script.target.kind !== "constant")
          continue;
        // 脚本写回走 WPE 的类型化 setter，类型是这个键 setter 的类型（主格的，vector-constant-REPORT.md 2.6）
        const material = script.target.material;
        const slot = slots.find((item) => item.material === material);
        if (slot) Object.assign(script.target, constantTargetFields(slot));
        else script.target.uniforms = [];
        script.valueType = script.target.type;
      }
      // 关键帧的常量目标（P10a 步骤 2）：同样补，补完按主格类型定写不写（关着的 effect 的常量动画同样每帧写）
      for (const animation of animations.list) {
        const target = animation.target;
        if (target.kind !== "constant" || target.pass !== context.key) continue;
        settleConstantAnimation(
          animation,
          slots.find((item) => item.material === target.material),
        );
      }
    }
    if (!shaderName) issues.add("shader:missing");
    if (context.particle) checkParticleProgram(pass, result?.ok ? result : null, issues);
    let program: number | null = null;
    if (result?.ok) {
      // 粒子 pass 带粒子路径写的 uniform；effect pass（有 fbo 表的上下文）带只在 effect pass 写的 `g_LayerModelMatrix`
      // （P7d 步骤 2），基础材质读到它照报
      // 绑 `_rt_MipMappedFrameBuffer` 的槽（材质 `textures`，或没写时着色器注解的缺省）：`g_Texture<n>MipMapInfo` 是引擎 uniform（P13b1）
      const mipSlots = new Set<number>();
      for (const binding of result.textures ?? []) {
        const bound = names[binding.slot] || binding.meta?.default;
        if (!planned.has(binding.slot) && bound === MIP_FRAMEBUFFER_RT) mipSlots.add(binding.slot);
      }
      for (const [slot, name] of names.entries())
        if (!planned.has(slot) && name === MIP_FRAMEBUFFER_RT) mipSlots.add(slot);
      checkProgramFeatures(
        result,
        issues,
        context.particle
          ? PARTICLE_UNIFORMS
          : context.text
            ? TEXT_UNIFORMS
            : context.fbos
              ? EFFECT_UNIFORMS
              : context.puppet
                ? PUPPET_UNIFORMS
                : undefined,
        context.puppet ? PUPPET_COMBOS : undefined,
        mipSlots,
      );
      // 着色器声明了、材质没给的槽位按注解 `default` 绑定（同 LWE `setupTextureUniforms` 先取着色器默认值）
      for (const binding of result.textures ?? []) {
        const fallback = binding.meta?.default;
        if (typeof fallback !== "string" || !fallback) continue;
        if (planned.has(binding.slot) || binding.slot in slots || binding.slot in runtime || binding.slot in composites)
          continue;
        // 注解缺省写的别的图层的合成 RT（P8 步骤 4）：同材质 `textures` 的规则；着色器已经编好，不再加格式（同下面的静态纹理）
        if (bindLayerComposite(binding.slot, fallback, false)) continue;
        if (fallback.startsWith("_rt_")) {
          if (!bindRuntime(binding.slot, fallback)) issues.add(`texture:rendertarget:${fallback}`);
          continue;
        }
        const texture = await getTexture(fallback, scope, issues, !!context.particle);
        if (texture) slots[binding.slot] = texture.index;
      }
      program = addProgram(result);
    }
    // 深度 / 剔除三个键照 WPE 规整（P5d 步骤 1）：缺键为开、非法值取表的第一项，所有 pass 一套规则
    return {
      key: context.key,
      program,
      blending: pass.blending ?? "normal",
      ...passAlphaWriting(pass),
      ...normalizeDepthKeys(pass),
      textures: slots,
      runtime,
      ...(Object.keys(composites).length ? { layerComposites: composites } : {}),
      ...(userTextures.slots.length ? { userTextures: userTextures.slots } : {}),
      uniforms: {
        ...shaderUniforms(result, pass, properties, context.key, bindings, issues),
        ...(result?.ok && usesLighting(result) ? sceneLights() : {}),
        ...(result?.ok && readsLegacyLights(result) ? legacyLights() : {}),
      },
      framebuffer: needsFramebuffer(names, result?.ok ? result : null),
    };
  }

  /**
   * 编译一个 effect 的 fbo 与步骤；effect.json 缺失时返回 null。不支持项写进 `issues`，抛错交给调用方按开关处理。
   * `options.shape`：形状对象的 effect（P8 步骤 2，`compileShape`），两处不同：
   * - 每个绘制 pass 的 `combos` 在实例覆盖之后写 `DIRECTDRAW = 1`（WPE 形状虚表 +0xc8 在建材质之前改 pass JSON，rea-p8-layer 1.7；
   *   p8-REPORT `p8-shape` 的 S9 实例写 0 也被改成 1）；
   * - 渲染图不填槽 0（形状没有当前合成 RT，`FUN_1401ebf60` 的 `compIndex = −1`，rea-p8-layer 1.5），bind 里只有本 effect 的 fbo 生效、
   *   `previous` 等跳过，所以只给这些 bind 预留槽位，其余槽（含槽 0）照常按材质的纹理与注解缺省编（WPE 保留材质自己的纹理）。
   */
  async function compileEffect(
    index: number,
    shell: SceneEffect,
    instance: SceneEffectInstance,
    issues: Set<string>,
    options: { shape?: boolean } = {},
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
      // 渲染图填的槽位：有 bind 时只按 bind；没有 bind 时槽 0 = 上一步输出（合成 RT）。形状（P8 步骤 2）只预留指向本 effect fbo 的 bind
      const planned: ShaderTextureSlot[] = options.shape
        ? (binds ?? []).filter((bind) => fbos.has(bind.name)).map((bind) => ({ slot: bind.index }))
        : binds
          ? binds.map((bind) => ({ slot: bind.index }))
          : [{ slot: 0 }];
      for (const materialPass of parseMaterial(passMaterialText).passes) {
        const merged: MaterialPass = {
          ...materialPass,
          // 形状（P8 步骤 2，rea-p8-layer 1.7）：`DIRECTDRAW` 强制为 1，写在实例覆盖之后
          combos: { ...materialPass.combos, ...override?.combos, ...(options.shape ? { DIRECTDRAW: 1 } : {}) },
          constantshadervalues: { ...materialPass.constantshadervalues, ...override?.constantshadervalues },
          textures: mergeTextures(materialPass.textures, override?.textures),
          // 实例 pass 的 `usertextures` 按槽覆盖材质的（P11b 步骤 1，rea-p11-textures 2.1：effect pass 也是材质对象、走同一套解析）
          ...userTexturesOf(mergeUserTextures(materialPass.usertextures, override?.usertextures)),
        };
        // 有 bind 时材质槽 0 的 null 不再自动填（B6）：不在 planned 里的 null 槽位就保持空
        const compiled = await compilePass(merged, {
          key: `objects/${index}/effects/${shell.source}/passes/${passIndex++}`,
          scope,
          fbos,
          planned,
          unsupported: issues,
          sceneConstants: override?.constantshadervalues,
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
    // 对齐（P8 步骤 3，rea-p8-layer 2.1）：字符串查表，别的写法（绑属性、数字）都是 center，不登记绑定。fullscreen 图层的末 pass 是
    // 单位矩阵，偏移落在哪里没有实测（语料 0 个），带非 center 的对齐照报
    layer.alignment = alignmentIndex(object.alignment);
    if (layer.fullscreen && layer.alignment !== 0) unsupported.add("object:alignment:fullscreen");
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
    /** puppet 的直接上屏变体要重编的材质 pass（实例覆盖之后的）；读不到 puppet 时不用。 */
    const merged: MaterialPass[] = [];
    for (const [k, raw] of material.passes.entries()) {
      const pass: MaterialPass = instance
        ? {
            ...raw,
            combos: { ...raw.combos, ...instance.combos },
            textures: mergeTextures(raw.textures, instance.textures),
            ...userTexturesOf(mergeUserTextures(raw.usertextures, instance.usertextures)),
          }
        : raw;
      merged.push(pass);
      layer.passes.push(
        await compilePass(pass, {
          key: `objects/${index}/passes/${k}`,
          // instanced 的参考尺寸取对象 `size`（P11b，WPE 把它写进 `instance.usertexturereference`，p11-REPORT M2）
          ...(instance ? { instanceSize: instanceReferenceSize(object.size) } : {}),
        }),
      );
    }
    // puppet（P12a 步骤 3 点 1，rea-p12-mdl 9.1）：模型 JSON 的 `puppet` 必须是字符串，且图层不是 fullscreen / 组合层（WPE `L+0x304 & 0x22`，
    // 两种都整段跳过）。mdl 读不到或网格为空时 P 销毁、照常画四边形（不报）。上屏路径与材质变体要等 effect 编完才能定（`finalizePuppet`）
    if (typeof model.puppet === "string" && !layer.fullscreen && !layer.passthroughModel) {
      layer.puppet = null;
      const file = await readMdl(model.puppet);
      if (file) {
        const built = buildPuppet(file, (object as Record<string, unknown>).animationlayers, model.puppet, properties);
        for (const key of built.issues) unsupported.add(key);
        if (built.puppet) {
          layer.puppet = { ...built.puppet, composite: false, passes: [], upload: null };
          puppetMaterials.set(index, {
            passes: merged,
            instanceSize: instance ? instanceReferenceSize(object.size) : null,
          });
          // 动画层的 `{user}` 绑定（步骤 3 点 3）：`rate` / `blend` / `visible` 就地写进 `SceneState.animationLayers`
          for (const [slot, def] of built.puppet.layers.entries())
            for (const { field, property, condition } of def.bindings)
              bindings.list.push({
                property,
                ...(condition === undefined ? {} : { condition }),
                target: { kind: "animation-layer", object: index, layer: slot, field },
              });
        }
      }
    }
    // 透明排序的类别（P5d 步骤 4，rea-p5-modelflags 2.1、1.4，`p5d-sort-a` / `-fs`）：只看基础材质（第一个 pass 的混合），effect、
    // colorBlendMode、`copybackground` 都不参与（WPE 在图像层构造时定，那时 `copybackground` 还是缺省值）。`projectlayer` 在这里单独读：
    // 它的另一个作用（尺寸）只在 `autosize` 时有（`imageLayerSize`）。材质没有 pass 的图层不画，不填
    if (layer.passes.length)
      layer.sortClass = imageSortClass(layer.passes[0].blending, layer.fullscreen || modelFlag(model, "projectlayer"));
    // 尺寸照 WPE 的顺序（P5b 步骤 1，`imageLayerSize`）：只有 `autosize` 才取槽 0 纹理的图像尺寸（`projectlayer` 取正交投影宽高，
    // 步骤 2）。deep_space 的 Background 模型写 1920×1080、没有 `autosize`，槽 0 是 480×270 的流向遮罩，按模型取，和 P1 相同
    const base = layer.passes[0]?.textures[0];
    const baseTexture = base === undefined ? undefined : bundle.textures[base];
    if (layer.fullscreen) {
      // fullscreen（P5b 步骤 3）排在 autosize 之前（rea-p5-modelflags §7：纹理就绪时 fullscreen 先判，取纹理图像尺寸、几何 2×2）。
      // 两份尺寸：几何是 2×2 的 NDC 四边形；合成 RT 取槽 0 静态纹理的图像尺寸，槽 0 是运行时 RT（fullscreenlayer 的
      // `_rt_FullFrameBuffer`，在 pass 的 `runtime` 里）或没有纹理时取场景目标尺寸（渲染时定，P5d 步骤 2）
      layer.size = [2, 2];
      layer.fullscreenSize = baseTexture ? [baseTexture.width, baseTexture.height] : "scene";
    } else {
      // 透视场景的正交投影宽高是 0，`projectlayer` 的 autosize 没测过（P5d 步骤 2，语料 0），照报
      if (bundle.general.perspective && modelFlag(model, "autosize") && modelFlag(model, "projectlayer"))
        unsupported.add("camera:perspective:projectlayer");
      layer.size = imageLayerSize(model, layer.size, baseTexture, [bundle.general.width, bundle.general.height]);
    }
    return true;
  }

  /**
   * puppet 的上屏路径与材质变体（P12a 步骤 3 点 1，rea-p12-mdl 9.3、9.4）。`composite` 在 effect 编完之后定：有 effect、colorBlendMode 混合或被依赖
   * 时 WPE 加载就置 `0x10`（`L+0x320 > 0` 也走合成，9.2），全部 effect 留在合成链：
   * - 合成：passthrough 材质（`passthroughMaterial`，P8 的那份）+ puppet 组合键 + `BLENDMODE` 编成 `upload`，`g_Color4` 置 1；skinned 时 cullmode
   *   取基础材质的（9.3「合成上屏用」一行）；
   * - 直接上屏：基础材质第一个 pass 加 puppet 组合键重编成 `passes`，稳定键同基础 pass（常量、属性绑定、关键帧共用，不重复登记）。
   * 版本条件 `ctx+0x1510` 没查清，先按 P8 的 `passthroughMaterial` 选（步骤 5 用 `p12-fx` 核对）。
   */
  async function finalizePuppet(
    index: number,
    layer: SceneLayer,
    composite: boolean,
    blendMode: number,
  ): Promise<void> {
    const puppet = layer.puppet!;
    puppet.composite = composite;
    const checkAttributes = (pass: ScenePass) => {
      if (pass.program !== null) checkMeshAttributes(bundle.programs[pass.program], puppet.mesh.format, unsupported);
    };
    if (composite) {
      const path = passthroughMaterial(scene.version);
      const text = await fs.text(path);
      const pass = text ? parseMaterial(text).passes[0] : undefined;
      if (!pass) {
        unsupported.add(`material:missing:${path}`);
        return;
      }
      const upload = await compilePass(
        { ...pass, combos: { ...pass.combos, ...passthroughCombos(blendMode), ...puppet.combos } },
        { key: `objects/${index}/puppetupload`, planned: [{ slot: 0 }], puppet: true },
      );
      upload.uniforms.g_Color4 = [1, 1, 1, 1];
      if (Object.keys(puppet.combos).length && layer.passes[0]) upload.cullmode = layer.passes[0].cullmode;
      checkAttributes(upload);
      puppet.upload = upload;
      return;
    }
    const source = puppetMaterials.get(index);
    const raw = source?.passes[0];
    if (!raw) return;
    // 同键重编：基础 pass 编译时已登记过同一批绑定，截掉重复的
    const before = bindings.list.length;
    const compiled = await compilePass(
      { ...raw, combos: { ...raw.combos, ...puppet.combos } },
      {
        key: `objects/${index}/passes/0`,
        puppet: true,
        ...(source.instanceSize ? { instanceSize: source.instanceSize } : {}),
      },
    );
    bindings.list.length = before;
    checkAttributes(compiled);
    puppet.passes = [compiled];
  }

  /**
   * 形状对象（P8 步骤 2，rea-p8-layer §1，p8-REPORT 结论 4、5）：没有模型和基础 pass（`passes` 留空、没有合成 RT），渲染图只画最后一个
   * effect（`render/graph.ts` 的 `planShapeLayer`）。
   * - 尺寸：`shapeLayerSize`（缺省正交高 × 正交高；对象 `size` 的绑定在建图层时已登记成重编译）；
   * - effect：每个都编、不看 `visible`（WPE 加载时全部进列表，形状绘制不读可见位，1.8；`p8-shape2` 实测写死不可见的最后一个照画）：
   *   `enabled` 恒真、`visibleBound` 为假，不登记 effect 开关的绑定（开关对形状中性；脚本写的开关照样落进状态，渲染图不看它、签名不变、
   *   不重建），也不预备变体（`variantPlans`）。不支持项一律并进整场，不分画不画（语料 24 个形状都只有一个 `lightshafts`，保守不丢东西）。
   *   编译时强制 `DIRECTDRAW = 1`、槽 0 不预留（`compileEffect` 的 `options.shape`）；
   * - 编完按 `shapeIssues` 报结构与程序的不支持项（编译中途停下时不查，那时整场已确定退回），按 `shapePoints` 取四个点。
   * `colorBlendMode`、`alpha`、`color`、`brightness` 对形状中性（1.9），不编 passthrough；`perspective` 只认图像层与模型，这里不取
   * （能力表照报 `object:perspective`）。
   */
  async function compileShape(index: number, object: SceneObject, layer: SceneLayer): Promise<void> {
    layer.size = shapeLayerSize(resolveValue(object.size, properties), bundle.general.height);
    let complete = true;
    for (const [source, raw] of (Array.isArray(object.effects) ? object.effects : []).entries()) {
      if (settled()) {
        complete = false;
        break;
      }
      const instance = (raw ?? {}) as SceneEffectInstance;
      const issues = new EffectIssues(unsupported);
      const shell: SceneEffect = {
        source,
        id: instance.id ?? layer.effects.length,
        name: instance.name ?? "",
        file: typeof instance.file === "string" ? instance.file : "",
        fbos: [],
        steps: [],
        enabled: true,
        visibleBound: false,
        unsupported: [],
      };
      // 缺文件时同图像层启用的 effect：不进 `layer.effects`（已报 `effect:missing:*`）
      const compiled = await compileEffect(index, shell, instance, issues, { shape: true });
      if (compiled) layer.effects.push({ ...compiled, unsupported: [...issues].sort() });
    }
    layer.shape = { points: shapePoints(layer, bundle.programs) };
    if (complete) for (const key of shapeIssues(layer, bundle.programs)) unsupported.add(key);
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
    // 图层的向量字段照 WPE 的向量 setter 取值（`layerVectorValue`：数字铺满、字符串少写的分量为 0，P6b 1e-3 复核）。绑定的属性值
    // 写不进（布尔、条件换成的布尔）时 WPE 不改字段，留着加载 JSON 时写进的 `value`；那个也写不进就是构造时的缺省
    const vector = (field: LayerVectorField, fallback: number[]): number[] => {
      const raw = object[field] as SceneValue | undefined;
      return (
        layerVectorValue(field, bindings.bind(raw, properties, at(field))) ??
        layerVectorValue(field, unwrapValue(raw)) ?? [...fallback]
      );
    };
    // 图层的标量字段（alpha / brightness）照 WPE 的 float setter：不收布尔（条件换成的、布尔属性本身、JSON 里直接写的布尔），写不进就留着
    // 加载 JSON 时写进的 `value`，那个也是布尔就是构造时的缺省 1（P3a 补测 NC1–NC5，`p3am-bright` R1–R8 / A1）。就地写同一规则
    // （`render/state.ts` 的 `SceneState.write`）
    const scalar = (field: "alpha" | "brightness"): number => {
      const raw = object[field] as SceneValue | undefined;
      const bound = bindings.bind(raw, properties, at(field));
      if (typeof bound !== "boolean") return asNumber(bound, 1);
      const own = unwrapValue(raw);
      return typeof own === "boolean" ? 1 : asNumber(own as SceneScalar | undefined, 1);
    };
    const layer: SceneLayer = {
      id: object.id ?? bundle.layers.length,
      object: index,
      parent: parents[index],
      name: object.name ?? "",
      origin: vector("origin", [0, 0, 0]),
      scale: vector("scale", [1, 1, 1]),
      angles: numbers(bindings.bind(object.angles, properties, at("angles")), [0, 0, 0]),
      size: numbers(bindings.bind(object.size, properties, recompile("layer-structure", `objects/${index}/size`))),
      alpha: scalar("alpha"),
      color: vector("color", [1, 1, 1]),
      brightness: scalar("brightness"),
      visible: bindings.bind(object.visible, properties, at("visible")) !== false,
      visibleBound: isUserBinding(object.visible),
      parallaxDepth: vector("parallaxDepth", [1, 1]),
      solidLayer: false,
      instanced: false,
      noPadding: false,
      perspective: false,
      passthroughModel: false,
      group: null,
      subtree: [],
      groupUpload: null,
      copyBackground: true,
      // 合成 RT 的采样（P8 步骤 1，p8-REPORT、rea-p8-layer §3）：图层 +0x304 的两位只由对象 JSON 写，构造时缺省 clampuvs 真、
      // nointerpolation 假；绑属性、挂脚本的由能力表照报，这里按缺省取
      clampUVs: object.clampuvs !== false,
      noInterpolation: object.nointerpolation === true,
      fullscreen: false,
      fullscreenSize: null,
      passes: [],
      colorBlendMode: colorBlendModeOf(
        bindings.bind(
          object.colorBlendMode as SceneValue,
          properties,
          recompile("layer-structure", `objects/${index}/colorBlendMode`),
        ),
      ),
      effects: [],
      passthrough: null,
      particle: null,
      text: null,
      model: null,
      shape: null,
      camera: null,
    };
    // 光标命中（P6c）：只写不是缺省的值（`solid` 缺省真、`disablepropagation` 缺省假），没有光标信息的图层字节不变；`solid` 绑了属性时登记就地目标
    const pick = cursorPickKind(object);
    if (pick) layer.pick = pick;
    if (bindings.bind(object.solid as SceneValue | undefined, properties, at("solid")) === false) layer.solid = false;
    if (object.disablepropagation === true) layer.disablePropagation = true;
    // 每个对象都进 `layers`（分组节点、灯、粒子是没有 pass 的图层），子孙算世界矩阵与可见性时父的状态都在
    bundle.layers.push(layer);
    // 相机对象（P5d 步骤 3）：`fov` / `zoom` 进图层并登记就地目标；`path` 的条目动画没做，读出非空 `paths` 或读不到报 `camera:path`。
    // 同时带别的内容的照报 `object:camera:mixed`、不当相机，按内容往下编
    if (isCameraObject(object)) {
      await checkCameraObjectPath(object.path, fs, unsupported);
      if (!isMixedCameraObject(object)) {
        const field = (key: "fov" | "zoom") =>
          cameraValue(
            bindings.bind(object[key] as SceneValue | undefined, properties, {
              kind: "camera",
              object: index,
              field: key,
            }),
          ) ?? CAMERA_DEFAULTS[key];
        layer.camera = { fov: field("fov"), zoom: field("zoom") };
        continue;
      }
    }
    if (objectKind(object) === "particle") {
      // 粒子构造即进半透明名单（P5d 步骤 4，rea-p5-mesh 4.2，`p5d-sort-a` 的粒子在第二遍）
      layer.sortClass = "translucent";
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
    // 形状对象（P8 步骤 2）：没有模型和基础 pass，effect 不看开关全编，渲染图只画最后一个（`planShapeLayer`）；colorBlendMode 中性，
    // 不编 passthrough
    if (isShapeObject(object)) {
      // 形状不进半透明名单（P5d 步骤 4，见 `SceneLayer.sortClass`）：只调基类构造，加载路径不置 bit8
      layer.sortClass = "opaque";
      await compileShape(index, object, layer);
      continue;
    }
    // 文本对象（P6b 1d）：没有模型，基础 pass 换成文本表里的宿主材质（排版在宿主主线程）；effect 与 colorBlendMode passthrough
    // 走下面图像层那段，文本表在它们之后编（`padding` 看启用的 effect 个数）
    const textObject = isTextObject(object);
    // 文本的构造函数无条件进半透明名单（P5d 步骤 4，rea-p6b-layout 1.1）：不看材质，没有模型标志，不会是 `last`
    if (textObject) layer.sortClass = "translucent";
    // 被依赖的文本层（P8 步骤 4）：WPE 同样置 `0x1010`（rea-p8-render 1.2 认类型 1 与 4），但文本层的合成 RT 随重排换尺寸，引用方的绑定要
    // 跟着换，没做（语料 0 个），照报
    if (textObject && isDepended(object)) unsupported.add("dependency:text");
    if (!textObject) {
      // 没有 image 的对象到这里为止：分组节点的 `effects` 不读、不编译（P4a 步骤 1）
      if (!object.image) continue;
      // 被依赖（P8 步骤 4）：图像层才填，判定同名字表（`isImageLayerObject`）
      layer.dependedOn = isDepended(object);
      if (!(await compileImageModel(index, object, layer))) continue;
    }
    // 组（P5b 步骤 4）：有对象的父指向这个组合层。子孙由它按局部正交画进合成 RT、不在顶层画（`assignGroups` 在全部对象之后定归属）
    const hasChildren = layer.passthroughModel && parents.includes(index);
    // 组的局部正交在透视场景里没测过（P5d 步骤 2），照报
    if (hasChildren && bundle.general.perspective) unsupported.add("camera:perspective:group");

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
    const blended = cbm !== 0 && cbm !== 31;
    // 被依赖（P8 步骤 4）：WPE 的 `0x10` 同 colorBlendMode 混合，全部 effect 留在合成链、passthrough 上屏
    const depended = !!layer.dependedOn;
    // 带 effect 或走 passthrough 时，WPE 把光照挪到基础 pass（PRELIGHTING=1，世界坐标改用 g_Alt*），上屏 pass 关光照（FUN_140209540）；
    // 被依赖的图层同样是 `0x10`（P8 步骤 4，rea-p8-render 第 1 节）
    const lit = layer.passes.some((pass) => pass.program !== null && usesLighting(bundle.programs[pass.program]));
    // TODO:[WPE_SCENE] PRELIGHTING 没实现，照报：要给基础 pass 加 `PRELIGHTING=1` 并写 `g_AltModelMatrix` / `g_AltNormalModelMatrix` /
    // `g_AltViewProjectionMatrix`（现在在 `features.ts` 的 `UNREAD_UNIFORMS` 里放行、渲染器不写），上屏 pass 关光照。语料 0 张，P13 总计划定为
    // 按需实现（phase13/phase-13-3d-lighting.md「决定」4）
    if (lit && (layer.effects.length > 0 || blended || depended)) unsupported.add("lighting:prelighting");
    // 被依赖的组（有子层的组合层，P8 步骤 4）：组隐藏时子层怎么画进它的 RT 没查（语料 0 个），照报
    if (depended && hasChildren) unsupported.add("dependency:group");
    // puppet 的上屏路径与材质变体（步骤 3 点 1）：composite 时 passthrough 上屏由 puppet 自己的 `upload` 承担，不再编 `layer.passthrough`
    if (layer.puppet)
      await finalizePuppet(index, layer, layer.effects.length > 0 || blended || depended, blended ? cbm : 0);
    if ((blended || depended) && !layer.puppet) {
      const path = passthroughMaterial(scene.version);
      const text = await fs.text(path);
      const pass = text ? parseMaterial(text).passes[0] : undefined;
      if (!pass) unsupported.add(`material:missing:${path}`);
      else {
        // `BLENDMODE` = colorBlendMode ∉ {0, 31} ? colorBlendMode : 0（rea-p8-render 第 1 节 `FUN_1401ebbc0`：被依赖、cbm 0 / 31 时编法同
        // 组的上屏 `groupUpload`）
        layer.passthrough = await compilePass(
          { ...pass, combos: { ...pass.combos, ...passthroughCombos(blended ? cbm : 0) } },
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
  // 反射（P13b1）。设置解析成「反射开」一个布尔：跟随时读 WPE `config.json` 的 `general.user.reflection`，只在有读者时才读
  if (reflectionReaders.length || mipReaders) {
    const reflectionSetting = input.reflection ?? "follow";
    const reflectionOn = resolveReflection(
      reflectionSetting,
      reflectionSetting === "follow" ? await readWpeReflection(input.reader, input.sceneAssets) : undefined,
    );
    if (reflectionReaders.some((reader) => reader.model)) {
      // 平面反射（rea-p13-passes 1.1、1.4）：只有模型的网格读 `_rt_Reflection` 时 WPE 才建这张 RT、才有反射 pass
      bundle.reflection = { planar: true };
      if (reflectionOn) unsupported.add("reflection:planar"); // 反射开：P13b2 再做，照报
    } else {
      // RT 不建：WPE 把那一槽绑 6×6 黄黑棋盘格占位（步骤 0 R3）
      for (const reader of reflectionReaders) {
        delete reader.runtime[reader.slot];
        reader.slots[reader.slot] = checkerIndex();
      }
    }
    if (mipReaders) {
      // 屏幕空间反射（rea-p13-passes 4.1）：任何对象读到就建
      bundle.mipFramebuffer = true;
      if (reflectionOn) unsupported.add("reflection:screen"); // 反射开：P13g 再做，照报
    }
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
  // 有音频粒子就自动开启（4.3）。读音频频谱 uniform 的程序同样要订阅才有数据（P11a）；读了却没声明开关时 uniform 全 0，同 WPE
  bundle.audio =
    project.general?.supportsaudioprocessing === true &&
    (bundle.layers.some((layer) => layer.particle !== null && particleUsesAudio(layer.particle)) ||
      bundle.programs.some(readsAudioUniforms));
  return bundle;
}

/** 交给主线程时转移的缓冲：纹理 mip 与 mdl 文件（网格与 puppet 的顶点 / 索引是它的视图，同一个 mdl 的对象共用一份）、puppet 的动画帧数据，去重。 */
export function transferableBuffers(bundle: SceneBundle): ArrayBuffer[] {
  const buffers = [
    ...bundle.textures.flatMap((texture) => texture.mips.map((mip) => mip.bytes?.buffer)),
    ...bundle.layers.flatMap(
      (layer) => layer.model?.meshes.flatMap((mesh) => [mesh.vertices.buffer, mesh.indices.buffer]) ?? [],
    ),
    // puppet（P12a）：网格 0 的顶点 / 索引也是 mdl 文件缓冲上的视图；动画帧数据是编译期转好的自有缓冲
    ...bundle.layers.flatMap((layer) =>
      layer.puppet
        ? [
            layer.puppet.mesh.vertices.buffer,
            layer.puppet.mesh.indices.buffer,
            ...layer.puppet.animations.map((animation) => animation.frames.buffer),
          ]
        : [],
    ),
  ];
  return [...new Set(buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer))];
}
