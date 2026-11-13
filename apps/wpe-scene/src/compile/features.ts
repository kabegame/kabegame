/**
 * 能力表：编译期找出场景用到、而渲染器还没实现的特性，记进 `unsupported`（非空时整张退回预览图）。
 *
 * 原则：**只报真正改变画面的特性**。中性字段逐项写明依据后放行，拿不准的继续报。依据多来自对 WPE 2.8.42 的只读逆向
 * （`.claude/plans/wpe-import/3-scene/p2-REPORT.md`，下文以 B / G 编号引用）。
 *
 * 着色器不再按名字白名单：翻译器把材质常量（带 `meta.material` 的 uniform）与 COMBO 都处理成普通输入，真正依赖引擎的
 * 只有没有 `meta.material` 的内置 uniform、引擎提供数据的 COMBO（光照、骨骼、精灵表……）和 `_rt_*` 默认纹理，
 * 这三类逐项核对（`checkProgramFeatures`，默认纹理在 `bundle.ts` 里随绑定一起核对）。
 */
import {
  numbers,
  resolveValue,
  staticCombos,
  type EffectJson,
  type JsonObject,
  type MaterialPass,
  type ModelJson,
  type SceneEffectInstance,
  type SceneJson,
  type SceneObject,
  type SceneValue,
} from "./model";
import { generalValue, isKeyframedValue, isScriptValue, isUserBinding, userBindingOf } from "./bindings";
import { conditionsHold, removedFbos } from "./conditions";
import { resolveParents } from "./hierarchy";
import {
  INSTANCE_FIELDS,
  PARTICLE_SYSTEM_KEYS,
  parseParticleChildEntry,
  particleModuleEntries,
  readParticleSystem,
  SCRIPT_INSTANCE_KEYS,
  type ParticleChildIssue,
  type ParticleInstance,
} from "./particles";
import { PARTICLE_CATEGORIES, readParticleModule } from "../particles/modules";
import type { TranslateResult } from "../wpesl2wgsl";
import type { SceneEffect, SceneLayer } from "./bundle";
import type { SceneParticle } from "./particles";
import type { SceneScript } from "./scripts";
import { scanScriptApi, scanScriptCallbacks, type ScriptApiScene } from "./scriptApi";
import { SOUND_MODES, soundFlag } from "./sounds";
import { TEXTURE_FORMATS } from "./tex";
import {
  attributeSemantic,
  attributeTypeMatches,
  MDL_FORMAT_BITS,
  meshAttributes,
  semanticKey,
  type MdlFile,
} from "./mdl";

export const SUPPORTED = {
  objects: ["image"],
  blending: ["normal", "translucent", "additive"],
  /** 按原格式上传的 `.tex` 格式（0、4、6–9），从 `tex.ts` 的 `TEXTURE_FORMATS` 取，不另写一份；不支持的由 `parseTex` 报 `tex:format:<n>`。 */
  textureFormats: Object.keys(TEXTURE_FORMATS).map(Number),
  /** FreeImage 形态 `.tex`（mip 是整份图片文件）：2 JPEG、13 PNG，主线程 `createImageBitmap` 解码。 */
  freeImageFormats: [2, 13],
} as const;

/**
 * 渲染器会写入的引擎内置 uniform（翻译结果里没有 `meta.material` 的成员）。另有 `g_Texture<n>Resolution`。
 * 与 `render/uniforms.ts` 的 `staticBuiltins` / `frameBuiltins` 一一对应，`p2a.test.ts` 核对两边一致。
 * 只在某类 pass 里才写的另列：effect pass 的 `EFFECT_UNIFORMS`、粒子的 `PARTICLE_UNIFORMS`。
 */
export const ENGINE_UNIFORMS: ReadonlySet<string> = new Set([
  "g_ModelViewProjectionMatrix",
  "g_ModelViewProjectionMatrixInverse",
  "g_EffectModelViewProjectionMatrix",
  "g_EffectModelViewProjectionMatrixInverse",
  "g_ModelMatrix",
  "g_ModelMatrixInverse",
  "g_EffectModelMatrix",
  "g_EffectModelMatrixInverse",
  "g_NormalModelMatrix",
  "g_ViewProjectionMatrix",
  "g_EffectTextureProjectionMatrix",
  "g_EffectTextureProjectionMatrixInverse",
  "g_EyePosition",
  "g_Brightness",
  "g_UserAlpha",
  "g_Alpha",
  "g_Color",
  "g_Color4",
  "g_CompositeColor",
  "g_TexelSize",
  "g_TexelSizeHalf",
  "g_Screen",
  "g_TextureReductionScale",
  "g_Texture0Rotation",
  "g_Texture0Translation",
  "g_LightAmbientColor",
  "g_LightSkylightColor",
  "g_Time",
  "g_Frametime",
  "g_Daytime",
  "g_PointerPosition",
  "g_PointerPositionLast",
  "g_PointerState",
  "g_ParallaxPosition",
]);
/** 光照路径声明了、只有 PRELIGHTING 才读的 uniform（`genericimage4.vert`）：渲染器不写，PRELIGHTING 另报。 */
const UNREAD_UNIFORMS = new Set(["g_AltModelMatrix", "g_AltNormalModelMatrix", "g_AltViewProjectionMatrix"]);
export function isEngineUniform(name: string): boolean {
  // 灯光数组由 `lights.ts` 随材质常量写入
  return (
    ENGINE_UNIFORMS.has(name) ||
    UNREAD_UNIFORMS.has(name) ||
    /^g_Texture\d+(?:Resolution|Texel)$/.test(name) ||
    /^g_L(?:Point|Spot|Tube|Directional)_/.test(name)
  );
}

/**
 * 只有 effect pass 才写的引擎 uniform（P7d 步骤 2），程序检查只在 effect 的 pass 里把它们当引擎 uniform：
 * - `g_LayerModelMatrix`：effect 的每个 pass（画进 fbo 的中间 pass 与上屏的末 pass）都是图层的世界矩阵 `W`，含父链、不含 `size`、
 *   不带视差（视差在视图投影里）。实测见 p7-REPORT「P7d 的实测」（`p7d-uni` 的 `kbfx`、子图层 `kbchild`）与 effect-matrices-REPORT
 *   S3（非 final 与 final 都是 `L = W`）；开着视差时 MVP 的平移变了，它和 `g_ModelMatrix` 的平移仍是 `origin`
 *   （`A:\p7d\unipar\unipar-frame132.rdc` 事件 73）。
 * - WPE 只在 effect pass 的着色器反射到效果矩阵或 `g_LayerModelMatrix` 时写（`FUN_1401ebf60`，pass 标志 bit0）。基础 pass、
 *   直接上屏、passthrough 上屏不写，读到的是上一个写它的图层留下的值，取决于绘制顺序，复刻没有意义，所以基础材质读到它照报
 *   `uniform:g_LayerModelMatrix`。
 * 渲染器在 `render/uniforms.ts` 的 `drawMatrices`（`effect`、`final` 两种角色）给值，`p2a.test.ts` 核对两边一致。
 */
export const EFFECT_UNIFORMS: ReadonlySet<string> = new Set(["g_LayerModelMatrix"]);

/**
 * 值非 0 时需要引擎提供数据、渲染器还没有的 COMBO。`LIGHTING` 不在这里：无 effect 的图层已实现（`lights.ts`），
 * 其余路径由 `compileScene` 报 `lighting:*`。其余 COMBO（材质 / effect 自己的选项，如 `VERSION`、`BLENDMODE`、
 * rz 的 `HUEMODE`）只是着色器内部分支，交给翻译器即可。
 * - `SPRITESHEET`：要逐帧的 `g_Texture0Rotation` / `Translation`（P6），现在只给恒等帧；
 * - `ALPHATOCOVERAGE`：混合模式 3（B7），没有 MSAA 时结果不同；
 * - 反射、蒙皮、变形、预光照：对应的 uniform 也会被 `uniform:*` 报出，这里一并列上，防止只改 COMBO 漏报。
 */
const ENGINE_COMBOS = new Set([
  "SPRITESHEET",
  "ALPHATOCOVERAGE",
  "REFLECTION",
  "SKINNING",
  "SKINNING_ALPHA",
  "MORPHING",
  "PRELIGHTING",
]);

/**
 * 不影响画面、或由别处裁决的 general 键。
 * - `orthogonalprojection` / `clearcolor` / `clearenabled`：已实现。
 * - `ambientcolor` / `skylightcolor`：只进 `g_LightAmbientColor` / `g_LightSkylightColor`，渲染器照写。
 * - `lightconfig`：灯数进 `LIGHTS_*`（`lights.ts`），要阴影 / cookie 的项由 `lightConfigIssues` 另报。
 * - `norecompile`、`camerapreview`：编辑器选项。
 * - `camerafade`：加载时的淡入，不改变稳定画面。
 * - `bloom`、`hdr` 与全部 `bloom*` 调节项：由后处理档位裁决（`postprocess.ts`），泛光 / HDR 由 `bloom.ts` 与 `render/bloom.ts` 实现。
 * - `farz` / `fov` / `nearz`：正交投影不用；透视另报 `camera:perspective`。
 * - `supportsvideo`：只决定 D3D 设备的视频支持标志（G2 0x8000）。视频纹理已实现（P9a：播放在 `video/`，纹理在
 *   `GpuScene.copyVideo`），和这个键无关。
 * - `gravitydirection` / `gravitystrength` / `windenabled` / `winddirection` / `windstrength`：REA 没找到引擎读取点，
 *   实测见 P4a 实施记录（`rea-p4a.md` C7：只在场景属性表里，粒子路径不碰，`movement` 的重力只来自模块自己的 `gravity`）。
 * `cameraparallax*` 已实现（P5a 步骤 2，`render/parallax.ts`）：四个字段由 `GENERAL_FIELDS` 存值，渲染器每帧读，属性与脚本写入就地生效；
 * 透视场景开视差 WPE 不移动对象（rea-p5-camera.md 6.1，语料 0 张），透视整张另报 `camera:perspective`。
 * `camerashake*` 已实现正交（P5a 步骤 3，`render/shake.ts`）：四个字段同样由 `GENERAL_FIELDS` 存值、渲染器每帧读；透视场景开抖动
 * 另报 `general:camerashake`（归 P5d）。`zoom` 已实现（P5a 步骤 4，`render/layout.ts` 的 `sceneViewProjection`）：同样由 `GENERAL_FIELDS`
 * 存值、渲染器每帧读，只在解析出的值 ≤ 0 时报（见 `checkSceneFeatures`）。
 * `perspectiveoverridefov` 不是中性：它是透视粒子的 fov（C4，实测核对过），解析进 `SceneGeneral.perspectiveOverrideFov`，
 * 见 `PARSED_GENERAL`。
 */
const NEUTRAL_GENERAL = new Set([
  "orthogonalprojection",
  "clearcolor",
  "clearenabled",
  "ambientcolor",
  "skylightcolor",
  "lightconfig",
  "norecompile",
  "camerapreview",
  "camerafade",
  "bloom",
  "hdr",
  "farz",
  "fov",
  "nearz",
  "supportsvideo",
  "gravitydirection",
  "gravitystrength",
  "windenabled",
  "winddirection",
  "windstrength",
]);
/** 编译期解析、由渲染器使用的 general 键（不进中性表）：`perspectiveoverridefov` → `SceneGeneral.perspectiveOverrideFov`（步骤 4 用）。 */
const PARSED_GENERAL = new Set(["perspectiveoverridefov"]);

/**
 * 支持或中性的对象键。
 * - `colorBlendMode`：0 普通，31 改成 additive，其它值走 passthrough 上屏（B7 / B8）。
 * - `copybackground`：只对组合层（passthrough 模型）生效（B9），普通图像模型上没有渲染效果。组合层已实现（P5b 步骤 2，
 *   `SceneLayer.copyBackground`）：缺省 true，基础 pass 从快照铺进合成 RT；JSON false 时合成 RT 0 清成透明（p5-REPORT `p5b-cl`）。
 * - `solid`：渲染路径不读（B9，推断与鼠标命中有关）。
 * - `ledsource`：Razer Chroma 外设灯效的取色来源，不参与渲染。
 * - `brightness`：只在 HDR 下乘进颜色（B10，`render/uniforms.ts` 的 `colorScale`），LDR 下不生效。
 * - `locktransforms`：编辑器锁定。
 * - `parallaxDepth`：视差已实现（P5a 步骤 2）。缺键 (1, 1)，绘制时只用根对象的值（`render/parallax.ts`），绑用户属性就地写、挂
 *   `{script}` 的字段脚本写回到它；只在 `general.cameraparallax` 打开时起作用，透视场景不移动对象（读码，语料 0 张）。
 * - `parent`：层级已实现（P4a 步骤 1，`hierarchy.ts` 与 `render/layout.ts`）；灯对象例外，见 `checkObjectFeatures`。
 * - `config`：运行时只在托盘、播放列表代码里读，渲染路径不碰；P5a 步骤 0 实测带 `config.passthrough` 的层画面不变。
 * 另判的键（不在这张表里，`checkObjectFeatures` 单独检查，未知键循环跳过）：
 * - `alignment`：图像层已实现（P8 步骤 3，rea-p8-layer 2.1–2.4，p8-REPORT 结论 6，`SceneLayer.alignment`）。WPE 的 JSON setter 只认
 *   字符串、查不到或不是字符串（含绑属性、写数字）都是 `center`，所以 JSON 的任何写法都不报；文本、形状、粒子、模型、声音、灯、分组
 *   节点不在它的属性查找链上，中性。照报的两处：`fullscreen` 图层带非 `center` 的对齐报 `object:alignment:fullscreen`（`bundle.ts` 的
 *   `compileImageModel`，末 pass 是单位矩阵、偏移落在哪里没测）；图像层上挂 `{script}` 报 `object:alignment:script`（字段脚本写回
 *   枚举没有实现，WPE 怎么处理也没测；语料 0 个）。
 * - `shape`：形状对象（P8 步骤 2，`isShapeObject`）上已实现；同时带别的内容的对象照未知键报。
 * - `perspective`：图像层上的 JSON `true` 已实现（P5b 步骤 1，画到场景目标的绘制换透视视图投影，`render/scene.ts`）；false 等不为
 *   真的值中性；绑属性、挂脚本或别的真值，以及非图像对象上为真，报 `object:perspective`。
 * - `clampuvs`、`nointerpolation`：合成 RT 的采样（P8 步骤 1，p8-REPORT「合成 RT 与基础纹理的采样」、rea-p8-layer §3，
 *   `SceneLayer.clampUVs` / `noInterpolation`、`render/graph.ts` 的 `compositeSampling`）。JSON 布尔值已实现（null 同没写，取缺省）；
 *   绑属性、挂脚本或别的取值报 `object:clampuvs` / `object:nointerpolation`：WPE 运行中改这两位不重建合成 RT（rea-p8-layer §3，
 *   推断），和就地写的语义对不上，没有实测（语料 0 个）。
 */
const SUPPORTED_OBJECT = new Set([
  "id",
  "name",
  "parent",
  "image",
  "origin",
  "scale",
  "angles",
  "size",
  "alpha",
  "color",
  "visible",
  "locktransforms",
  "effects",
  "brightness",
  "colorBlendMode",
  "copybackground",
  "solid",
  "ledsource",
  "parallaxDepth",
  "config",
]);
/**
 * 打开时改变画面、还没实现的对象开关。`instanceoverride` 不在这里（P4a 步骤 5）：粒子对象上按键检查
 * （`checkParticleInstance`），其它对象上 WPE 不读，照未知键报 `object:instanceoverride`（语料 0 个）。
 * `perspective` 也不在这里（P5b 步骤 1）：图像层的 JSON `true` 已实现，其余在 `checkObjectFeatures` 里另判。
 * 这里的 `fullscreen`、`passthrough` 是对象上的键，和模型 JSON 的同名标志（P5b 步骤 2、3 已实现，见 `SUPPORTED_MODEL`）不是一回事。
 */
const OBJECT_FLAGS = [
  "fullscreen",
  "passthrough",
  "attachment",
  "castshadow",
  "disablepropagation",
  "reflected",
  "skin",
];
/**
 * 模型对象上中性的 `OBJECT_FLAGS`（P5c 步骤 1，rea-p5-mesh 2.2，p5-REPORT「P5c 语义的实测核对」）：
 * - `skin`：选材质（`mdl.ts` 的 `meshSkin`，`p5c-skin` 实测）；
 * - `castshadow`、`reflected`：只决定是不是阴影 pass 的投射者、在不在反射 pass 的名单里。没有消费者时不改变画面，而消费者现在都照报
 *   （读 `_rt_Reflection` 报 `texture:rendertarget:_rt_Reflection`，`REFLECTION` 非 0 报 `combo:REFLECTION`，投影灯报 `lightconfig:*`）；
 * - `disablepropagation`：渲染侧没有读取点（p2 I6）。
 * 图像、粒子等对象上这几个键照旧报。
 */
const MODEL_NEUTRAL_FLAGS = ["skin", "castshadow", "reflected", "disablepropagation"];
/**
 * 支持或中性的模型键。
 * - `autosize`：纹理就绪时覆盖对象 `size` 与模型 `width` / `height`（P5b 步骤 1，`bundle.ts` 的 `imageLayerSize`，p5-REPORT
 *   `p5b-autosize`）：带 `projectlayer` 时取正交投影宽高（步骤 2，`p5b-proj`），否则取槽 0 纹理的图像尺寸、没有纹理时不覆盖。
 *   精灵表的帧尺寸随图像层帧动画（`tex:animation`）另报。
 * - `nopadding`：直接上屏的四边形不内缩，带 effect 时末 pass 照旧内缩（P5b 步骤 1，`render/graph.ts`，p5-REPORT `p5b-nopad`）。
 * - `solidlayer`：管两件事，WPE 里分开判断（P5b 步骤 5，rea-p5-modelflags）：上屏（直接上屏与末 pass）不内缩只看这一位
 *   （`+0x304 & 0x200`，`render/graph.ts` 的 `flat`），instanced 照样不内缩；合成 RT 按图层 `size`（`compositeSize`）还要求不是
 *   `instanced`（`FUN_1402091e0`）。`SceneLayer.solidLayer` 只表示这一位。
 * - `instanced`（P5b 步骤 5，`SceneLayer.instanced`，p5-REPORT `p5b-inst`、`p5b-inst2`）：编辑器的「纯色图层」，模型固定是
 *   `{instanced, solidlayer, material: materials/util/solidlayer_instance*.json}`（translucent 的 genericimage2 / 4，槽 0 是
 *   `util/white` 32×32）。对象的 `instance` 在加载时覆盖材质 pass 的同名键（rea-p5-modelflags §6.2）：`combos` 合并、`textures`
 *   按槽合并，规则同 effect 实例覆盖（`bundle.ts`）；对象上的键由 `checkInstanceFeatures` 检查。合成 RT 仍按槽 0 纹理的图像尺寸
 *   （`p5b-inst2` 的 J1 32×32、J2 48×40），上屏不内缩由 `solidlayer` 那一位管（J1、J2 末 pass、J3 直接上屏的 UV 都不内缩）。
 * - `passthrough`：组合层（P5b 步骤 2，`SceneLayer.passthroughModel`，p5-REPORT `p5b-cl`）：基础 pass 按 `copybackground` 从快照铺进
 *   合成 RT 或清成透明，之后照常跑 effect 链、借基础材质的 blend 上屏（`colorBlendMode` 混合时 passthrough 上屏）；合成 RT 按 `size`、
 *   上屏不内缩；没有启用的 effect、`colorBlendMode` 是 0 / 31、没有子层时整层不画。带子层的是「组」（步骤 4，p5-REPORT `p5b-grp-*`、
 *   `p5b-nest`、`p5b-grpptc`）：子孙不在顶层画，由组在基础 pass 之后按先序、组的局部正交画进合成 RT（`copybackground: false` 时
 *   alpha 取 MAX），没有 effect 时用 `effectpassthrough` 上屏；组里还不支持的用法由 `groupChildIssues` 报（`bundle.ts` 在全部对象之后
 *   查）。fullscreenlayer 同时带 `fullscreen`，基础 pass 换成拷贝，见下一条；它带子层报 `model:fullscreen:children`。
 * - `fullscreen`（P5b 步骤 3，`SceneLayer.fullscreen`，p5-REPORT `p5b-fs`、`p5b-fsnofx`、`p5b-fsmvp`）：几何一律是 2×2 的 NDC 四边形，
 *   两条路径：
 *   - 直接上屏（没有启用的 effect、`colorBlendMode` 是 0 / 31、不是组合层）：MVP 照常（场景视图投影 · 视差 · W），着色器不乘 MVP 就
 *     铺满全屏（neon_sunset 的 `cloudsbg`、`p5b-fsmvp` 的 FSBG），乘了就是被 W 变换的 2×2 方块（FSQ）；
 *   - 合成路径：不画基础材质，合成 RT 0 拷贝当前画面（先拍快照、再拷进去），照常跑 effect 链；上屏与 effect pass 的模型、视图是
 *     单位阵，投影是 `ortho(−1, 1, −1, 1)`，`origin` / `scale` / `angles`、视差、抖动都不起作用。
 *   两份尺寸：几何尺寸 `size` 固定 (2, 2)；合成 RT 尺寸 `fullscreenSize` 取槽 0 静态纹理的图像尺寸，槽 0 是 `_rt_FullFrameBuffer`
 *   （fullscreenlayer）或没有纹理时取场景尺寸。两者都不内缩。fullscreenlayer 没有 effect、cbm 是 0 / 31 时同普通组合层整层不画。
 *   对象级的 `fullscreen` 键（`OBJECT_FLAGS`）是另一回事，照报。
 * - `projectlayer`：只在 `autosize` 时起作用，尺寸取正交投影宽高（rea-p5-modelflags §3.1，`p5b-proj`）；另一个作用是透明排序键 −∞，
 *   只在透视场景起作用（P5d），正交场景按列表顺序画。
 * - `cropoffset`：编辑器写的偏移，导入时已加进 `origin`；`wallpaper64.exe` 里没有这个字符串，P5a 步骤 0 实测不改位置。
 */
const SUPPORTED_MODEL = new Set([
  "material",
  "width",
  "height",
  "autosize",
  "nopadding",
  "solidlayer",
  "instanced",
  "passthrough",
  "projectlayer",
  "fullscreen",
  "cropoffset",
]);
/**
 * 模型 JSON 的布尔键（`FUN_1401fac50`，rea-p5-modelflags §7）：WPE 只认 JSON 的 `true`，写成 1、字符串等于没写
 * （P5a 步骤 0 实测 `fullscreen: 1` 不生效）。能力表与 `bundle.ts` 读这些键都经 `modelFlag`。
 */
const MODEL_FLAGS = new Set([
  "fullscreen",
  "nopadding",
  "autosize",
  "passthrough",
  "solidlayer",
  "projectlayer",
  "instanced",
]);
export function modelFlag(model: ModelJson, key: string): boolean {
  return model[key] === true;
}
const SUPPORTED_PASS = new Set([
  "shader",
  "blending",
  "cullmode",
  "depthtest",
  "depthwrite",
  "textures",
  "combos",
  "constantshadervalues",
  "usershadervalues",
]);
/** effect.json 的元数据键（编辑器显示用，`gizmos` 是编辑器画布上的拖拽手柄）与已实现的结构键。 */
const SUPPORTED_EFFECT = new Set([
  "version",
  "name",
  "description",
  "group",
  "preview",
  "dependencies",
  "replacementkey",
  "performance",
  "gizmos",
  // 编辑器键（P7b 步骤 5）：wallpaper64.exe 2.8.42 里没有 "editable" 这个字符串，运行时不读，按中性放开
  "editable",
  "passes",
  "fbos",
  // 具名动作（只有 `clear`）的声明（P7d 步骤 3）：唯一调用方是脚本 `executeMaterialFunction`，加载、属性变化、可见性切换都不调
  // （rea-p7d-fluid 第 2 节，xrefs 列全）。声明本身不改画面，按中性放开；脚本调用照报 `script:api:effect.executeMaterialFunction`
  "functions",
]);
// `conditions`（P7d 步骤 3）：编译期按实例顶层 `combos` 求值（`conditions.ts`），被去掉的不进 bundle
const SUPPORTED_EFFECT_PASS = new Set(["material", "command", "source", "target", "compose", "bind", "conditions"]);
const SUPPORTED_FBO = new Set([
  "name",
  "format",
  "scale",
  "width",
  "height",
  "fit",
  "unique",
  "clear",
  "uvs",
  "conditions",
]);
const SUPPORTED_BIND = new Set(["name", "index", "conditions"]);
// 顶层 `combos`（P7d 步骤 3）：只给 `conditions` 求值，不并进各 pass 的 COMBO（p7-REPORT「流体 effect 的条件」）；写成对象
// （绑用户属性）时 WPE 在条件里当 0（`combos` 不是 effect 对象的属性，不经属性框架展开，rea-p7d-fluid 第 1 节「补」），照做、不报
const SUPPORTED_EFFECT_INSTANCE = new Set(["file", "id", "name", "passes", "visible", "combos"]);
const SUPPORTED_INSTANCE_PASS = new Set(["id", "combos", "constantshadervalues", "textures"]);

/**
 * 递归扫描一个 JSON 值：属性关键帧 `{animation: {…}, value}` 报 `value:animation`（`isKeyframedValue`，P4a 步骤 5，
 * `sample-gaps.md` §3.3）。挂了 `user` / `script` 的同样报；puppet 的 `animationlayers[i].animation` 是整数 id，不报。
 * 只给不经属性框架的 JSON 用（语料 0 处）：`checkPassFeatures` 扫材质 JSON 的常量，`checkModelFeatures` 扫模型 JSON，
 * `checkEffectFeatures` 扫 effect.json；粒子 JSON 在 `checkParticleFeatures` 里按键检查（模块字段由 `readParticleModule` 报
 * `animation`）。`scene.json` 里的（`general`、图层字段、effect 实例常量、`instanceoverride`）由 `collectAnimations` 编成动画，
 * 没有就地目标的报 `value:animation:<light|camera|other>`（P10a 步骤 2，`animations.ts`）。
 */
export function scanValue(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) scanValue(v, unsupported);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (isKeyframedValue(value)) unsupported.add("value:animation");
  for (const v of Object.values(value)) scanValue(v, unsupported);
}

function active(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== "";
}

export function checkSceneFeatures(scene: SceneJson, unsupported: Set<string>): void {
  const g = scene.general ?? {};
  if (!g.orthogonalprojection) unsupported.add("camera:perspective");
  // `cameraparallax` 不再报（P5a 步骤 2）：视差点、`g_ParallaxPosition` 与对象平移已实现
  // `camerashake` 只在透视场景报（P5a 步骤 3）：正交的抖动已实现（`render/shake.ts`）；透视下幅度是 `0.1·amplitude` 个世界单位、
  // 偏移是三维的，要和透视相机一起做，归 P5d（rea-p5-camera.md 第 5 节），透视场景整张另报 `camera:perspective`，这一条提醒 P5d 补上
  if (!g.orthogonalprojection && active(g.camerashake)) unsupported.add("general:camerashake");
  // `supportsaudioprocessing` 中性（P4e 步骤 4）：渲染器不读 `scene.json` 里的这个键，开关只看 `project.json` 的同名键（rea-p4e-audio.md
  // 第 6 节、4.1，`SceneBundle.audio`）；语料只有默认工程 `audiophile` 在 `scene.json` 里写了它
  // `zoom` 已实现（P5a 步骤 4）：正交投影绕场景中心乘它（p5-REPORT 实测），绑属性、脚本写回都就地生效。只在解析出的值 ≤ 0 时报：
  // 投影退化、指针反投影是 NaN（语料最小 1.0）。常量与 `{script}` 的初值同 `bundle.ts` 的 `generalFields` 解析，不合法时取缺省 1；
  // 绑用户属性的不看值（运行中的值编译期定不了）；关键帧取 `value`（WPE 加载时写它，P10a）。透视场景里 zoom 不起作用
  // （rea-p5-camera.md 1.4：读取点都在正交分支），不报，整张另报 `camera:perspective`
  if (g.orthogonalprojection && !isUserBinding(g.zoom)) {
    const zoom = generalValue("zoom", resolveValue(g.zoom as SceneValue | undefined, {}));
    if (typeof zoom === "number" && zoom <= 0) unsupported.add("general:zoom");
  }
  for (const [key, value] of Object.entries(g))
    if (
      !NEUTRAL_GENERAL.has(key) &&
      !PARSED_GENERAL.has(key) &&
      !key.startsWith("bloom") &&
      !key.startsWith("cameraparallax") &&
      !key.startsWith("camerashake") &&
      !["supportsaudioprocessing", "zoom"].includes(key) &&
      active(value)
    )
      unsupported.add(`general:${key}`);
  const { parents, cycle } = resolveParents(scene.objects);
  if (cycle) unsupported.add("object:parent-cycle");
  scene.objects.forEach((object, index) => checkObjectFeatures(object, unsupported, parents[index]));
  // 关键帧不在这里报：由 `collectAnimations`（`animations.ts`，P10a 步骤 2）按目标报细分键与过渡键
}

/**
 * 场景脚本用到 WPE 有、我们没实现的 API：`script:api:<分组>.<成员>`（表与匹配规则见 `scriptApi.ts`，用户定 2026-11-07）；
 * 导出了 WPE 会调、运行时还没调的回调（光标、媒体等）：`script:callback:<名>`（P6 前置，否则场景静默缺交互）。
 * 只扫会执行的脚本：`collectScripts` 收集的 scene.json 脚本里，导入说明符无效的整段不求值（`ScriptRuntime.load`），不扫。
 * 脚本运行期的普通错误不在这里，仍只进脚本诊断（3b）。
 * `context.particleLayers`：场景里有粒子层，这时任意接收者上的粒子播放控制都报 `script:api:particle.<名>`（`scanScriptApi`，P6a 步骤 2）。
 */
export function checkScriptFeatures(
  scripts: readonly SceneScript[],
  unsupported: Set<string>,
  context: ScriptApiScene = {},
): void {
  for (const script of scripts) {
    if (script.errors.length) continue;
    for (const key of scanScriptApi(script, context)) unsupported.add(`script:api:${key}`);
    for (const name of scanScriptCallbacks(script.source)) unsupported.add(`script:callback:${name}`);
  }
}

/**
 * 灯对象自己的键（`FUN_14025da80`）。灯不画东西，这些键只影响 `lights.ts` 算出的 uniform，`density` 之后的项只给体积光与阴影用。
 * `castshadow` / `usecookie` 单独不起作用：要 `lightconfig` 里的阴影灯数才生效，那时报 `lightconfig:*`。
 */
const LIGHT_KEYS = new Set([
  "light",
  "intensity",
  "radius",
  "exponent",
  "innercone",
  "outercone",
  "controlpoint",
  "density",
  "volumetricsexponent",
  "cascadedistance0",
  "cascadedistance1",
  "cascadedistance2",
  "lightsourcesize",
  "castshadow",
  "usecookie",
]);

const OBJECT_KINDS = ["image", "model", "particle", "sound", "text", "light"] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * 粒子对象上的 `alpha`、`color`、`brightness`（P4a 步骤 4）：图像层按 `g_Color4` 等用，粒子上 WPE 怎么用没测过
 * （档 1 的两个粒子着色器都不读 `g_Color4`，WPE 可能乘进实例颜色）。取默认值时没有分别，取非默认值、或绑了用户属性 /
 * 脚本（运行时可能变）时报 `particle:object:<键>`。
 */
const PARTICLE_OBJECT_DEFAULTS: Readonly<Record<string, readonly number[]>> = {
  alpha: [1],
  color: [1, 1, 1],
  brightness: [1],
};

/** 值与默认值不同：解析成数字后逐分量比；解析不出来时编译按默认值处理，不算。 */
function particleObjectValueUsed(value: unknown, defaults: readonly number[]): boolean {
  if (value === null || value === undefined) return false;
  if (isUserBinding(value) || isScriptValue(value)) return true;
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") return true;
  const parsed = numbers(value, []);
  if (!parsed.length) return false;
  return defaults.some((expected, i) => (parsed[i] ?? expected) !== expected);
}

/** 对象的内容类别；都没有时是分组节点（undefined）。`compileScene` 按同一规则分派。 */
export function objectKind(object: SceneObject): ObjectKind | undefined {
  return OBJECT_KINDS.find((key) => active(object[key]));
}

/**
 * 声音对象（P6a 步骤 1）：`sound` 键不为 null（rea-p6a-sound.md 1.1，工厂 `0x140190554`）。空字符串、空数组也算，只是没有文件；
 * `objectKind` 按 `active()` 认不出空字符串，所以没有别的内容时另按键判。`compileScene` 与能力表共用。
 */
export function isSoundObject(object: SceneObject): boolean {
  const kind = objectKind(object);
  return kind === "sound" || (kind === undefined && object.sound !== undefined && object.sound !== null);
}

/**
 * 声音对象自己的键（`FUN_1401f7090` 的描述符表，rea-p6a-sound.md 1.2）。`muteineditor` 在播放器里没有读取点；`attenuation` /
 * `mindistance` 只在 `spatialization: true` 时用（三维声音，没做，那时另报 `object:spatialization`），语料 0 张打开，所以中性。
 */
const SOUND_KEYS = new Set([
  "sound",
  "playbackmode",
  "volume",
  "mintime",
  "maxtime",
  "startsilent",
  "muteineditor",
  "attenuation",
  "mindistance",
  "spatialization",
]);

/**
 * 文本对象（P6b 1d）：`text` 键不为 null（rea-p6b-layout 1.1，工厂 `0x140190332` 只看有没有这个成员）。`text: ""` 也算（空文字，整层
 * 不画）；`objectKind` 按 `active()` 认不出空串，所以没有别的内容时另按键判。`compileScene` 与能力表共用。
 */
export function isTextObject(object: SceneObject): boolean {
  const kind = objectKind(object);
  return kind === "text" || (kind === undefined && object.text !== undefined && object.text !== null);
}

/**
 * 形状对象（P8 步骤 2，rea-p8-layer 1.1）：WPE 的工厂（`FUN_14018ff60` 的 `0x14019075e`）只看 `shape` 是不是字符串、不比较取值。同时带
 * 图像、模型、粒子、声音、文本、灯的对象 WPE 按哪个类建没查（语料 0 个），不算形状，`shape` 照未知键报 `object:shape`。
 * `compileScene` 与能力表共用。WPE 的形状是图像类的子类，我们照样当一种图层（`SceneLayer.shape`，渲染图见 `render/graph.ts` 的
 * `planShapeLayer`）；它不参加光标命中测试（WPE 只认类型 1、4、5，形状是 10），P6 做命中测试时要排除它。
 */
export function isShapeObject(object: SceneObject): boolean {
  return (
    typeof object.shape === "string" &&
    objectKind(object) === undefined &&
    !isSoundObject(object) &&
    !isTextObject(object)
  );
}

/**
 * 文本对象自己的键（描述符表 `DAT_1404e88e0`，rea-p6b-layout 1.2）。排版类键、背景、`depthtest` 已实现或中性：
 * - `depthtest`：只在透视场景选 `_depth` 材质，正交场景恒用无深度材质（rea-p6b-raster 1，p6-REPORT 实测），透视场景整张另报
 *   `camera:perspective`；
 * - 描边、模糊、投影的参数（`outlinethickness` 等）只在 MSDF 路径用，开关另由 `checkTextOptions` 报；
 * - `backgroundbrightness` 只在 HDR 下乘进背景色（`compile/texts.ts`）。
 * 不在这张表、文本上同样中性的：`size`（运行时用排版结果覆盖，1.4）、`alignment`（不在文本的查找链上）、`copybackground`（文本的
 * 合成 RT 初值不看它，5.5）。
 */
const TEXT_KEYS = new Set([
  "text",
  "font",
  "pointsize",
  "padding",
  "spacing",
  "maxwidth",
  "maxrows",
  "opaquebackground",
  "limitwidth",
  "limitrows",
  "limituseellipsis",
  "blockalign",
  "horizontalalign",
  "verticalalign",
  "anchor",
  "depthtest",
  "backgroundcolor",
  "backgroundbrightness",
  "msdf",
  "outline",
  "blur",
  "dropshadow",
  "outlinethickness",
  "outlinecolor",
  "blursize",
  "dropshadowsize",
  "dropshadowopacity",
  "dropshadowoffset",
  "dropshadowcolor",
]);

/** 打开任意一个都改走 MSDF（rea-p6b-raster 1：`O+0x518 != 0`），P6b 不做（语料 2 张、5 个对象）。 */
const TEXT_MSDF_KEYS = ["msdf", "outline", "blur", "dropshadow"] as const;

/**
 * `anchor` 里中性的取值：`none` 不平移；`center` 平移 `((E0 − E2)/2, (E3 − E1)/2)`，场景按居中盖满铺放时左右、上下的裁边相等，为 0
 * （rea-p6b-layout 3.4）。其余取值贴着可见区域的边走，要按铺放算裁边（语料 23 个），报 `text:anchor:<值>`。
 */
const NEUTRAL_ANCHORS = new Set(["none", "center"]);

/**
 * 文本对象的静态检查（P6b 1d，`checkObjectFeatures` 调）：挂 `{script}` 的文本键。`text` 的字段脚本（时钟）是 1e，报 `text:script`；
 * 其它文本键挂脚本报 `text:script:<键>`（WPE 写入时当场重排，1e 起才有字符串写回与就地重排）。
 * 生效值相关的项（MSDF 的开关、`anchor`）要按当前用户属性判断，在编译时由 `checkTextOptions` 报（`compile/texts.ts`）。
 */
export function checkTextFeatures(object: SceneObject, unsupported: Set<string>): void {
  for (const key of TEXT_KEYS)
    if (isScriptValue(object[key])) unsupported.add(key === "text" ? "text:script" : `text:script:${key}`);
}

/**
 * 文本对象按生效值（绑了属性的取当前值）查的能力（P6b 1d，`compile/texts.ts` 解析字段时调）：
 * - `msdf` / `outline` / `blur` / `dropshadow` 打开：`text:msdf:<键>`；
 * - `anchor` 不是 `none` / `center`：`text:anchor:<值>`（取值已按 WPE 的枚举规则规整，查不到的是 `none`）。
 */
export function checkTextOptions(
  values: Record<(typeof TEXT_MSDF_KEYS)[number], boolean> & { anchor: string },
  unsupported: Set<string>,
): void {
  for (const key of TEXT_MSDF_KEYS) if (values[key]) unsupported.add(`text:msdf:${key}`);
  if (!NEUTRAL_ANCHORS.has(values.anchor)) unsupported.add(`text:anchor:${values.anchor}`);
}

/**
 * 字体着色器（`font.frag`）声明的引擎 uniform：`g_RenderVar0–3` 是 MSDF 的描边、模糊、投影参数（rea-p6b-raster 6），普通路径不读
 * （翻译器标 `unused`，本来就不报）。文本 pass 的程序检查放行它们，渲染器不写（MSDF 另报 `text:msdf:*`）。
 */
export const TEXT_UNIFORMS: ReadonlySet<string> = new Set([
  "g_RenderVar0",
  "g_RenderVar1",
  "g_RenderVar2",
  "g_RenderVar3",
]);

/** 声音对象上 WPE 没有回调、运行时改了不生效的键（rea 1.2）：绑了属性或挂了脚本报 `sound:binding:<键>`（语料 0 个）。 */
const SOUND_UNBOUND_KEYS = ["playbackmode", "mintime", "maxtime", "startsilent", "spatialization"];

/**
 * 声音对象的键（P6a 步骤 1）。已实现：三种播放模式、`mintime` / `maxtime`、`startsilent`、`volume`（数字与 `{user}`，就地更新；
 * 挂 `{script}` 时字段脚本每帧写回到同一个就地目标，P6a 步骤 2）。
 * - `spatialization` 为真：`object:spatialization`（三维声音，步骤 0b 取消，语料 0 张）；
 * - `playbackmode` 不是 `loop` / `single` / `random`：`sound:playbackmode:<值>`（WPE 的枚举解析怎么处理未知值没读）；
 * - `SOUND_UNBOUND_KEYS` 绑了属性或挂了脚本：`sound:binding:<键>`。
 */
export function checkSoundFeatures(object: SceneObject, unsupported: Set<string>): void {
  for (const key of SOUND_UNBOUND_KEYS)
    if (isUserBinding(object[key]) || isScriptValue(object[key])) unsupported.add(`sound:binding:${key}`);
  const mode = object.playbackmode;
  if (
    mode !== undefined &&
    mode !== null &&
    !isUserBinding(mode) &&
    !isScriptValue(mode) &&
    !SOUND_MODES.includes(mode as (typeof SOUND_MODES)[number])
  )
    unsupported.add(`sound:playbackmode:${typeof mode === "string" ? mode : JSON.stringify(mode)}`);
  if (soundFlag(object.spatialization)) unsupported.add("object:spatialization");
}

/**
 * 一个对象的能力检查。`parent` 是解析后的父对象下标（`hierarchy.ts` 的 `resolveParents`），根节点为 null。
 * 没有内容的对象是分组节点：WPE 把它建成只有变换的基类对象（P4a 实测），不报；它的 `effects` 不读（`bundle.ts`
 * 在没有 image 时不编译图层内容），所以也不报。
 *
 * 形状对象（P8 步骤 2，`isShapeObject`，rea-p8-layer 1.9、p8-REPORT 结论 4、5）：`shape` 键本身不报；`alignment` 不在形状的属性查找链上
 * （rea-p8-layer 1.1 的虚表 +0x20），中性；`alpha`、`color`、`brightness`、`colorBlendMode`、`clampuvs`、`nointerpolation` 形状路径不读，
 * 本来就在中性表或另判里放行；`perspective: true` 照报（只放行图像层与模型，语料 0 个）；`castshadow`、`disablepropagation`
 * 形状绘制与重建都不读，但别处的语义没查清（rea-p8-layer 1.9），取值为真照旧报（语料都是 false）。effect 的用法由 `bundle.ts` 的
 * `compileShape` 编完后按 `shapeIssues` 报。
 *
 * 粒子对象自己的键（`origin`、`angles`、`scale`、`visible`、`parent` 等）照对象规则走；`instanceoverride` 要看粒子 JSON 的
 * `flags` 与场景 HDR，由 `checkParticleInstance` 在读到文件后检查；粒子 JSON 的用法由 `checkParticleFeatures` 检查。
 * 粒子不再有总括键（步骤 5 删掉了 `particle:pending`）：不支持的用法都要由这些细分键挡住。
 *
 * 模型对象（P5c 步骤 1）不再整个报 `object:model`：mdl 与网格的用法由 `bundle.ts` 读到文件后按 `checkMdlFeatures`、
 * `checkMeshAttributes` 与模型 pass 的 `checkPassFeatures` 报（P5c 步骤 2 接上绘制后去掉了过渡键 `model:pending`）。对象上：
 * - `MODEL_NEUTRAL_FLAGS` 中性，`perspective: true` 中性（和 P5b 的透视图层同一套，`p5c-matrix` 实测）；
 * - `effects` 非空报 `model:effects`（语料 0 个）；`animationlayers`（W6）、`dependencies` 等照未知键报。
 */
export function checkObjectFeatures(object: SceneObject, unsupported: Set<string>, parent: number | null = null): void {
  const kind = objectKind(object);
  const effects = object.effects as unknown;
  const hasEffects = Array.isArray(effects) ? effects.length > 0 : active(effects);
  if (kind === "particle") {
    // 带 effects 的粒子对象本机 0 个，P4 不做
    if (hasEffects) unsupported.add("particle:effects");
    for (const [key, defaults] of Object.entries(PARTICLE_OBJECT_DEFAULTS))
      if (particleObjectValueUsed(object[key], defaults)) unsupported.add(`particle:object:${key}`);
  } else if (kind === "model") {
    // 模型对象的 effect（WPE 怎么画没读，语料 0 个）：`bundle.ts` 也不编译它
    if (hasEffects) unsupported.add("model:effects");
  } else if (kind && kind !== "image" && kind !== "light" && kind !== "sound" && kind !== "text")
    unsupported.add(`object:${kind}`);
  // 灯的位置取本地 origin（`lights.ts`），挂在父链下时的位置没有和 WPE 比过，照报
  if (kind === "light" && parent !== null) unsupported.add("object:parent");
  const lightKey = (key: string) => kind === "light" && LIGHT_KEYS.has(key);
  // 声音对象（P6a 步骤 1）：父层、可见性不影响播放（p6-REPORT `p6a-misc`），`parent` / `origin` 只在三维声音里用
  const sound = isSoundObject(object);
  if (sound) checkSoundFeatures(object, unsupported);
  const soundKey = (key: string) => sound && SOUND_KEYS.has(key);
  // 文本对象（P6b 1d）：自己的键见 `TEXT_KEYS`，`alignment` 不在文本的查找链上（rea-p6b-layout 1.2），中性
  const text = isTextObject(object);
  if (text) checkTextFeatures(object, unsupported);
  const textKey = (key: string) => text && TEXT_KEYS.has(key);
  const modelKey = (key: string) => kind === "model" && MODEL_NEUTRAL_FLAGS.includes(key);
  // 形状对象（P8 步骤 2）：`shape` 键本身已实现，`alignment` 不在形状的查找链上（rea-p8-layer 1.1），中性
  const shape = isShapeObject(object);
  for (const key of OBJECT_FLAGS)
    if (active(object[key]) && !lightKey(key) && !modelKey(key)) unsupported.add(`object:${key}`);
  // 对齐（P8 步骤 3）：图像层已实现，JSON 的任何写法都按 WPE 的 setter 取值（字符串查表，别的是 center），别的对象中性。图像层上挂
  // `{script}` 的字段脚本：写回目标是枚举，运行时没有实现（`compile/scripts.ts` 落成 unsupported），照报
  if (kind === "image" && isScriptValue(object.alignment)) unsupported.add("object:alignment:script");
  // 图像层（P5b 步骤 1）与模型（P5c 步骤 1）的 perspective：JSON true 已实现；绑属性、挂脚本或别的取值，以及别的对象上为真，照报
  if (active(object.perspective) && !((kind === "image" || kind === "model") && object.perspective === true))
    unsupported.add("object:perspective");
  // 合成 RT 的采样（P8 步骤 1）：JSON 布尔值已实现（null 同没写）；绑属性、挂脚本时 WPE 不重建 RT（rea-p8-layer §3，推断），
  // 没有实测，照报
  for (const key of ["clampuvs", "nointerpolation"]) {
    const value = object[key];
    if (value !== undefined && value !== null && typeof value !== "boolean") unsupported.add(`object:${key}`);
  }
  // `instance`（P5b 步骤 5）：WPE 只在模型是 instanced 时读它（rea-p5-modelflags §6.2），那时由 `bundle.ts` 调
  // `checkInstanceFeatures` 查；非 instanced 对象上中性（语料 0 个）
  for (const [key, value] of Object.entries(object))
    if (
      !SUPPORTED_OBJECT.has(key) &&
      !OBJECT_FLAGS.includes(key) &&
      ![
        "alignment",
        "perspective",
        "clampuvs",
        "nointerpolation",
        "instance",
        "model",
        "particle",
        "sound",
        "text",
        "light",
      ].includes(key) &&
      !lightKey(key) &&
      !soundKey(key) &&
      !textKey(key) &&
      !(kind === "particle" && key === "instanceoverride") &&
      !(shape && key === "shape") &&
      active(value)
    )
      unsupported.add(`object:${key}`);
}

/**
 * instanced 模型的对象（P5b 步骤 5，rea-p5-modelflags §6.2，p5-REPORT `p5b-inst`、`p5b-inst2`）：`bundle.ts` 在模型是 instanced 时调。
 * WPE 加载时用对象的 `instance` 覆盖材质 pass 的同名键，语料 167 个对象只用到 `textures`、`combos`、`usertextures`。
 * 已实现的覆盖是 `combos` 合并、`textures` 按槽合并（`bundle.ts`，规则同 effect 实例覆盖）。值为 null 的键当缺键。
 * - `instance` 缺失或不是对象：`model:instanced:instance`（编辑器总会写，语料 0 个，WPE 怎么处理没测）；
 * - 对象 `size` 不是字符串（缺键也算）：`model:instanced:size`（WPE 按 `"w h"` 两次 `atof` 读，绑属性、写成数组等怎么处理没读，
 *   语料全是字符串）；
 * - `id`：编辑器键，中性；
 * - `textures` 不是非空字符串组成的数组：`object:instance:textures`（语料都是一个非空字符串：94 个 `util/white`、73 个工程纹理；
 *   null 槽在 instance 上什么意思没测）；
 * - `combos` 不是对象：`object:instance:combos`（值绑属性由合并后 pass 的 `checkPassFeatures` 报 `combo:user-binding`；语料都是
 *   `{"version": 2}`，和材质本身相同）；
 * - `usertextures` 取值有效：`material:usertextures`（`$mediaThumbnail`、用户属性纹理、`usershortcut`，同材质 pass 上的这个键；WPE
 *   绑了用户纹理时还强制 `g_Color4 = (1, 1, 1, 1)`，一起照报）；
 * - 其它键取值有效：`object:instance:<键>`。
 */
export function checkInstanceFeatures(object: SceneObject, unsupported: Set<string>): void {
  if (typeof object.size !== "string") unsupported.add("model:instanced:size");
  const instance = object.instance;
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) {
    unsupported.add("model:instanced:instance");
    return;
  }
  for (const [key, value] of Object.entries(instance as Record<string, unknown>)) {
    if (value === null || value === undefined || key === "id") continue;
    if (key === "textures") {
      if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && name !== ""))
        unsupported.add("object:instance:textures");
    } else if (key === "combos") {
      if (typeof value !== "object" || Array.isArray(value)) unsupported.add("object:instance:combos");
    } else if (key === "usertextures") {
      if (active(value)) unsupported.add("material:usertextures");
    } else if (active(value)) unsupported.add(`object:instance:${key}`);
  }
}

/**
 * 粒子对象的 `instanceoverride`（P4a 步骤 5，`rea-p4a.md` C3 / C5，`FUN_14022bd40`）。`flags` 是粒子 JSON 的系统 `flags`，
 * `hdr` 是场景实际的 HDR（`postprocess.hdr`），`resolved` 是编译期解析出的值（含用户属性）。
 * - `alpha`、`size`、`count`、`speed`、`lifetime`、`rate`：已实现（静态值与 `{user}`，就地更新），不报；`id` 是编辑器键。
 * - `brightness`：只在 HDR 且没有 bit3 时生效（乘实例颜色，没实现），这时取非默认值报 `particle:instance:brightness`；
 *   LDR 或有 bit3 时中性。绑了用户属性时 `bundle.ts` 把它登记成重编译目标，改成非默认值后由这里报。
 * - `color`、`colorn`（P4b 步骤 6，rea-p4b-render.md 7.1、7.3、7.4）：已实现（`particles/colorn.ts`）。`color`（0–255）加载时
 *   ÷255 后 `%.5f` 转成 `colorn`；生效要已设（r ≥ 0）、不是三个分量都和系统色（从颜色模块推出）差 < 0.9/255、系统 flags
 *   没有 bit3；生效后颜色模块按 HSV 差平移，场景 `version` < 5 或没有颜色模块（`0x200000`）时新粒子再乘 `colorn`。静态值与
 *   `colorn` 的 `{user}` 都不报（就地更新）。没有 bit3 时下面两种 WPE 的处理没读到（语料 0 处），照报：
 *   - `color` 绑了用户属性：`particle:instance:color:user`（属性值怎么 ÷255 没读到）；
 *   - `colorn` 的 `{user: {name, condition}}`：`particle:instance:colorn:condition`（布尔值怎么转颜色没读到）。
 *   `brightness`（HDR 时乘实例颜色）见上条。子系统（P4e 步骤 1）用同一个对象的值，`compileScene` 按子系统自己的 `flags` 再调一次
 *   （`colorn` 另要父生效，`particles/colorn.ts` 的 `parentActive`）。
 * - `controlpoint0..7`、`controlpointangle0..7`（P4c 步骤 1，`particles/controlpoints.ts`）：静态值已实现，不报（下标 ≥ 控制点
 *   个数、或点上带 `flags` 1 / 4 时 WPE 不用它，同样中性）；绑了用户属性报 `particle:instance:controlpoint:user`（运行时改值
 *   没做，语料 0 处）。
 * - 挂了 `{script}`（P4f 步骤 1，rea-p4f-script.md 第 6 节）：`alpha`、`size`、`count`、`speed`、`lifetime`、`rate`、`colorn`
 *   （`SCRIPT_INSTANCE_KEYS`）已实现，字段脚本写回到就地目标 `particle-instance`（`compile/scripts.ts`），不报；其余键报
 *   `particle:binding:instance:<键>`：`brightness`（HDR 下要先变成就地目标，P4f 步骤 2）、`controlpointN` / `controlpointangleN`
 *   （运行时写入归 P4f 步骤 3）、`color` 等。脚本里用到的 API 照常由 `scanScriptApi` 检查。
 * - 其它键：`particle:instance:<键>`；不是对象：`particle:instance`。值为 null 的键当缺键。关键帧由 `collectAnimations` 处理（P10a）。
 */
export function checkParticleInstance(
  raw: unknown,
  resolved: Pick<ParticleInstance, "brightness">,
  context: { flags: number; hdr: boolean },
  unsupported: Set<string>,
): void {
  if (raw === null || raw === undefined) return;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    if (active(raw)) unsupported.add("particle:instance");
    return;
  }
  // bit3 禁用 colorn 与 brightness（C3）
  const colorOverride = (context.flags & 8) === 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined || key === "id") continue;
    if (isScriptValue(value) && !(SCRIPT_INSTANCE_KEYS as readonly string[]).includes(key))
      unsupported.add(`particle:binding:instance:${key}`);
    if ((INSTANCE_FIELDS as readonly string[]).includes(key)) continue;
    if (key === "color") {
      if (colorOverride && isUserBinding(value)) unsupported.add("particle:instance:color:user");
    } else if (key === "colorn") {
      if (colorOverride && userBindingOf(value as SceneValue)?.condition !== undefined)
        unsupported.add("particle:instance:colorn:condition");
    } else if (/^controlpoint(?:angle)?[0-7]$/.test(key)) {
      if (isUserBinding(value)) unsupported.add("particle:instance:controlpoint:user");
    } else unsupported.add(`particle:instance:${key}`);
  }
  if (context.hdr && colorOverride && resolved.brightness !== 1) unsupported.add("particle:instance:brightness");
}

/** 程序最终是否开了光照（COMBO 可能来自材质，也可能是着色器注解的默认值）。 */
export function usesLighting(result: TranslateResult): boolean {
  return (result.combos ?? []).some((combo) => combo.name.toUpperCase() === "LIGHTING" && combo.value !== 0);
}

/**
 * 模型 JSON 的键：布尔键只认 `true`（`modelFlag`），其余（`puppet` 是路径字符串等）按 `active()`；键名报 `model:<键>`。
 * `passthrough`、`projectlayer`（P5b 步骤 2）、`fullscreen`（步骤 3）与 `instanced`（步骤 5）已实现（见 `SUPPORTED_MODEL`），所以
 * WPE 自带的四个组合层模型（含 fullscreenlayer）与纯色图层模型都不报，`MODEL_FLAGS` 里的布尔键现在全部放行。组合层带子层（组，步骤 4）
 * 要看场景的父子关系，组里还不支持的用法由 `bundle.ts` 按 `groupChildIssues` 报；instanced 对象上的 `instance` 与 `size` 由
 * `bundle.ts` 按 `checkInstanceFeatures` 报。
 */
export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const [key, value] of Object.entries(model)) {
    if (SUPPORTED_MODEL.has(key)) continue;
    if (MODEL_FLAGS.has(key) ? modelFlag(model, key) : active(value)) unsupported.add(`model:${key}`);
  }
  // 关键帧（语料 0 处，防御用）；puppet 的 `animationlayers` 是整数 id，不报
  scanValue(model, unsupported);
}

const hex = (value: number) => `0x${(value >>> 0).toString(16)}`;

/**
 * 尾部段的标签 → 能力键（rea-p5-mesh 1.7 的识别规则：`MDLS`、`MDLA` 只比较前 4 个字符，`MDAT0001`、`MDMP0001` 比较 8 个字符，
 * `MDLE0002` 全串比较）。其余标签 WPE 整段跳过，中性（`p5c-ver` 的 S14、S23 带 `ZZZZ0001`、`MDLX0001` 照常显示）。
 */
function sectionIssue(tag: string): string | undefined {
  if (tag.startsWith("MDLS") || tag === "MDLE0002") return "mdl:skeleton";
  if (tag.startsWith("MDLA")) return "mdl:animation";
  if (tag.startsWith("MDMP0001")) return "mdl:morph";
  if (tag.startsWith("MDAT0001")) return "mdl:attachment";
  return undefined;
}

/**
 * 一个 mdl 文件（`mdl.ts` 的 `parseMdl`，P5c 步骤 1）还不支持的用法。静态网格（无段或只有不认识的段、无木偶数据）都不报。
 * - `mdl:truncated`：读越界（语料 0 个，WPE 的读取原语越界返回 0，不猜）；
 * - `mdl:skeleton` / `mdl:animation` / `mdl:morph` / `mdl:attachment`：骨骼、动画层、变形目标、挂点段（W6，语料只在 3706286085）；
 * - `mdl:puppet`：网格带可选块或记录表（木偶数据，语料只在 puppet mdl，模型对象用的都是空的）；
 * - `mdl:flags:<十六进制>`：网格标志除 bit0（u32 索引）、bit1（多一个 u32）外还有位，值是多出来的位（bit10 是 `MORPHING_NORMALS`，
 *   bit2、bit12 含义没查，rea 1.3）；
 * - `mdl:format:<十六进制>`：格式有表外的位，或同一个语义出现两次（如 `a_Position` 与 `a_PositionVec4`，语料 0 个，WPE 的输入布局
 *   怎么建没测），值是整个格式。
 * 材质多于一个 pass 在编译材质时报（`bundle.ts` 的 `compileMesh`，`mdl:material-passes`）。
 */
export function checkMdlFeatures(file: MdlFile, unsupported: Set<string>): void {
  if (file.truncated) unsupported.add("mdl:truncated");
  for (const tag of file.sections) {
    const issue = sectionIssue(tag);
    if (issue) unsupported.add(issue);
  }
  for (const mesh of file.meshes) {
    if (mesh.puppet) unsupported.add("mdl:puppet");
    if (mesh.flags & ~3) unsupported.add(`mdl:flags:${hex(mesh.flags & ~3)}`);
    const semantics = meshAttributes(mesh.format).map(semanticKey);
    if (mesh.format & ~MDL_FORMAT_BITS || new Set(semantics).size !== semantics.length)
      unsupported.add(`mdl:format:${hex(mesh.format)}`);
  }
}

/**
 * 网格格式和着色器属性对不上（P5c 步骤 1，p5-REPORT「P5c 语义的实测核对」的缺属性一行）：着色器按语义配对，同语义不同宽度共用一个槽
 * （`p5c-attr` 的 M1、M4 照常画）。只看被读的属性（不带翻译器的 `unused`）：
 * - 读了网格没有的语义：WPE 建不出输入布局，画出来是未定义的值（M2、M5），报 `mdl:missing-attribute:<名>`；
 * - 声明了却没读的：fxc 把它从输入签名里去掉，正常画（M3；语料 fantasticcar、audiophile 的 `grid` 声明 `a_Normal` 但不读），不报，
 *   渲染器给 WebGPU 一个占位（`render/mesh.ts` 的 `meshVertexLayout`）；
 * - 名字不在属性表里：`FUN_1400f4460` 只认表里的 26 个名字，别的没有 HLSL 语义，报 `mdl:attribute:<名>`；
 * - 分量类型和网格数据对不上（`mdl.ts` 的 `attributeTypeMatches`：`a_BlendIndices` 是 uint，其余 float；P5c 步骤 2）：报
 *   `mdl:attribute-type:<名>`。语料 0 个，WPE 的 D3D11 输入布局遇到它怎么样没测；WebGPU 建管线是校验错误。
 */
export function checkMeshAttributes(program: TranslateResult, format: number, unsupported: Set<string>): void {
  const present = new Map(meshAttributes(format).map((item) => [semanticKey(item), item]));
  for (const attribute of program.attributes ?? []) {
    if (attribute.unused) continue;
    const semantic = attributeSemantic(attribute.name);
    const item = semantic === undefined ? undefined : present.get(semantic);
    if (!semantic) unsupported.add(`mdl:attribute:${attribute.name}`);
    else if (!item) unsupported.add(`mdl:missing-attribute:${attribute.name}`);
    else if (attribute.array !== undefined || !attributeTypeMatches(attribute.type, item))
      unsupported.add(`mdl:attribute-type:${attribute.name}`);
  }
}

/** 组里的图层要拷快照（P5b 步骤 4，`groupChildIssues`）。 */
export const GROUP_CHILD_FRAMEBUFFER = "model:passthrough:children:framebuffer";

/** effect 的任一绘制 pass 读 `_rt_FullFrameBuffer`（同 `render/graph.ts` 的快照规则 2）。 */
export function effectNeedsFramebuffer(effect: Pick<SceneEffect, "steps">): boolean {
  return effect.steps.some((step) => step.kind === "draw" && step.pass.framebuffer);
}

/** 粒子系统树（P4e 步骤 1）里有一个系统满足 `test`。 */
function someParticleSystem(system: SceneParticle, test: (system: SceneParticle) => boolean): boolean {
  return test(system) || (system.children ?? []).some((child) => someParticleSystem(child.system, test));
}

/**
 * 组里的图层（`SceneLayer.group` 非空，P5b 步骤 4）还不支持的用法。要子孙的模型、材质、effect、粒子都编完才能判断，所以
 * `compileScene` 在全部对象之后逐个调（`assignGroups` 之后）。WPE 在组里画子孙时换了相机与渲染目标（rea-p5-modelflags §2.5），
 * 下面这些用法读的东西和组的局部坐标对不上或没有实测，照报：
 * - `model:passthrough:children:framebuffer`：要拷快照。基础 pass 或任一启用 effect 的 pass 读 `_rt_FullFrameBuffer`、粒子系统树里
 *   任一 pass 读它（`REFRACT` 等）、文本层的合成 RT 初值（`composelayer_clearalpha`，P6b 1d），或 colorBlendMode ∉ {0, 31}
 *   （passthrough 混合上屏要读快照）。WPE 在组里不拍新的快照、读的是组开始
 *   时那份，着色器按屏幕坐标采样，而子孙画在组的局部坐标里。例外是嵌套组自己的基础 pass（composelayer 读快照）：`p5b-nest` 实测它用
 *   场景相机采组开始时那份，已实现（渲染器在组里拍的快照和组开始时那份内容相同：组里的绘制都不落在场景目标上）。关着、运行时可能
 *   打开的 effect 读快照时，`bundle.ts` 把这个键记进那个 effect 自己的不支持项。
 * - `model:passthrough:children:fullscreen`：fullscreen 模型。当前目标是组的合成 RT，没有实测。
 * - `model:passthrough:children:perspective`：图层 `perspective: true`，或粒子系统树里有透视系统（`flags & 4`）。组里的投影是局部正交，
 *   没有实测。
 * - `model:passthrough:children:model`：模型对象（P5c 步骤 1）。语料 0 个，组里的网格怎么画（深度、剔除、视锥剔除用哪个相机）没有实测。
 * - `model:passthrough:children:shape`：形状对象（P8 步骤 2）。WPE 由组代画进它的合成 RT（rea-p8-layer 1.4，`FUN_1401ecb20`），没有实测；
 *   语料 24 个形状的父对象都是分组节点。
 */
export function groupChildIssues(
  layer: Pick<
    SceneLayer,
    | "passthroughModel"
    | "passes"
    | "effects"
    | "colorBlendMode"
    | "fullscreen"
    | "perspective"
    | "particle"
    | "text"
    | "model"
    | "shape"
  >,
): string[] {
  const keys: string[] = [];
  const cbm = layer.colorBlendMode;
  const framebuffer =
    (!layer.passthroughModel && layer.passes.some((pass) => pass.framebuffer)) ||
    // 文本层（P6b 1d）走合成、没开背景时，合成 RT 的初值是场景快照（`composelayer_clearalpha`）
    !!layer.text?.clearAlphaPass?.framebuffer ||
    layer.effects.some((effect) => effect.enabled && effectNeedsFramebuffer(effect)) ||
    (cbm !== 0 && cbm !== 31) ||
    (!!layer.particle &&
      someParticleSystem(layer.particle, (system) => system.passes.some((pass) => pass.framebuffer)));
  if (framebuffer) keys.push(GROUP_CHILD_FRAMEBUFFER);
  if (layer.fullscreen) keys.push("model:passthrough:children:fullscreen");
  if (
    layer.perspective ||
    (!!layer.particle && someParticleSystem(layer.particle, (system) => (system.flags & 4) !== 0))
  )
    keys.push("model:passthrough:children:perspective");
  if (layer.model) keys.push("model:passthrough:children:model");
  if (layer.shape) keys.push("model:passthrough:children:shape");
  return keys;
}

/**
 * 形状层画的程序里 WPE 不写的引擎 uniform（P8 步骤 2，rea-p8-layer 1.5）：形状路径（`FUN_1401ebf60(…, −1, 1)`）不写 `ctx+0x120..+0x12c`，
 * 着色器读到的是上一次写它们的绘制留下的值，取决于绘制顺序，复刻没有意义。只算引擎 uniform（没有 `meta.material`，带的是材质常量，WPE
 * 照材质写）。
 */
export const SHAPE_UNWRITTEN_UNIFORMS = ["g_Color4", "g_Alpha", "g_Color"] as const;

/**
 * 程序是否读了某个槽的纹理（P8 步骤 2 的 `shape:texture0` 用）。翻译器的纹理反射不带 `unused`（只有 uniform 与属性有，见
 * `src-tauri/wpesl2wgsl/README.md`「没被读的 uniform」），着色器声明了却在关掉的分支里才采样的槽照样列出（`lightshafts` 在
 * `DIRECTDRAW = 1` 时的 `g_Texture0`，P8 步骤 2 实测），所以这里看输出的 WGSL：按反射给的绑定号找到这个槽的纹理变量
 * （`@binding(N) var 名字:`），名字在某个阶段里出现不止声明那一处就算读了。naga 输出里没被引用的全局只剩声明。WPE 按 fxc 反射建槽表，
 * 没读的槽不在表里、什么都不绑（rea-p8-layer 1.6）。没有 WGSL 文本（手写的测试数据）时按读了算（保守）。
 */
export function textureSlotRead(
  program: Pick<TranslateResult, "textures" | "vertex" | "fragment">,
  slot: number,
): boolean {
  const binding = program.textures?.find((texture) => texture.slot === slot);
  if (!binding) return false;
  const stages = [program.vertex?.wgsl, program.fragment?.wgsl].filter((wgsl): wgsl is string => !!wgsl);
  if (!stages.length) return true;
  return stages.some((wgsl) => {
    const name = new RegExp(`@binding\\(${binding.binding}\\)\\s*var\\s+([A-Za-z_]\\w*)\\s*:`).exec(wgsl)?.[1];
    return !!name && (wgsl.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0) > 1;
  });
}

/**
 * 形状层还不支持的用法（P8 步骤 2，rea-p8-layer 1.4–1.8，p8-REPORT 结论 5）。`compileScene` 在形状的 effect 全部编完后调；语料 24 个形状
 * 都只挂一个单 pass 的 `lightshafts`，下面这些都是 0 个：
 * - `shape:effects`：没有 effect（WPE 取 `effects.back()`，空列表是未定义行为）；
 * - `shape:effect-passes`：最后一个 effect 不是恰好一个绘制步骤（多 pass、`copy` / `swap`），或有 fbo。WPE 的非末 pass 画一个没建的
 *   四边形 `+0x2e0`，读码说会解引用空指针（1.5）；
 * - `shape:uniform:<名字>`：画的程序读 `SHAPE_UNWRITTEN_UNIFORMS`（`unused` 为假、不是材质常量）；
 * - `shape:texture0`：画的程序读槽 0（`textureSlotRead`）而 pass 没有静态纹理、也不在 `runtime` 里。WPE 没有当前合成 RT（`compIndex = −1`），
 *   槽 0 只剩材质自己的纹理，没有就是没人赋值（1.5、1.6）。
 * 前面的 effect 永远不画，只看最后一个；它们的不支持项已经并进整场（形状的 effect 一律当开着编）。
 */
export function shapeIssues(layer: Pick<SceneLayer, "effects">, programs: readonly TranslateResult[]): string[] {
  const effect = layer.effects.at(-1);
  if (!effect) return ["shape:effects"];
  const keys = new Set<string>();
  const draws = effect.steps.flatMap((step) => (step.kind === "draw" ? [step] : []));
  if (effect.steps.length !== 1 || draws.length !== 1 || effect.fbos.length > 0) keys.add("shape:effect-passes");
  for (const { pass } of draws) {
    const program = pass.program === null ? undefined : programs[pass.program];
    if (!program) continue;
    for (const name of SHAPE_UNWRITTEN_UNIFORMS)
      if (program.uniforms?.some((uniform) => uniform.name === name && !uniform.unused && !uniform.meta?.material))
        keys.add(`shape:uniform:${name}`);
    if (textureSlotRead(program, 0) && !(0 in pass.textures) && !(0 in pass.runtime)) keys.add("shape:texture0");
  }
  return [...keys];
}

/**
 * 材质 pass 的 `alphawriting` 取值（`sample-gaps.md` §2.10，读码可定论）：映射 `"default"` 0、`"enabled"` 1、`"disabled"` 2
 * （`0x140157eb0`–`0x140157f40`）；绘制时 0 什么都不做，1 / 2 才保存设备状态、开关 alpha 写入（`0x140157201`）。
 * 所以 `"default"` 等于没写；其余取值照报。
 */
function alphaWritingUsed(value: unknown): boolean {
  return active(value) && value !== "default";
}

/** 材质 pass 的剔除（`cullmode` 规整后的值）：normal 剔背面、屏幕上逆时针为正面；nocull 不剔。 */
export type PassCullMode = "normal" | "nocull";
/** 材质 pass 的深度测试 / 深度写入（`depthtest` / `depthwrite` 规整后的值）。 */
export type PassDepthMode = "enabled" | "disabled";

/**
 * 材质 pass 的深度 / 剔除键照 WPE 规整（rea-p5-mesh 3.3，p5-REPORT「P5d 语义的实测核对」的深度、非法值、缺键三行）：
 * - 缺键（`undefined`）为开：`cullmode` normal、`depthtest` / `depthwrite` enabled（材质 pass 字节缺省为 0，图像层、粒子、模型、
 *   effect 一样，`p5d-depth` 缺全部深度键的图像层测、写、剔背面）；
 * - 写了但不是表里的串（含非字符串、`null`）取表的第一项：`depthtest` / `depthwrite` 落到 disabled（`depthtest: "yes"` 不测），
 *   `cullmode` 落到 normal（`cullmode: "back"` 剔背面）。
 * 所有 pass 一套规则（`compilePass`、泛光材质），之后 `ScenePass` 上这三个字段只会是这里的值，渲染器不再兜底。
 */
export function normalizeDepthKeys(pass: Pick<MaterialPass, "cullmode" | "depthtest" | "depthwrite">): {
  cullmode: PassCullMode;
  depthtest: PassDepthMode;
  depthwrite: PassDepthMode;
} {
  const pick = <T extends string>(value: unknown, on: T, off: T, fallback: T): T =>
    value === undefined ? on : value === on || value === off ? (value as T) : fallback;
  return {
    cullmode: pick<PassCullMode>(pass.cullmode, "normal", "nocull", "normal"),
    depthtest: pick<PassDepthMode>(pass.depthtest, "enabled", "disabled", "disabled"),
    depthwrite: pick<PassDepthMode>(pass.depthwrite, "enabled", "disabled", "disabled"),
  };
}

/**
 * 材质 pass 的能力检查。深度与剔除三个键不报（P5d 步骤 1）：缺键、合法值、非法值都按 WPE 规整（`normalizeDepthKeys`），渲染器按规整后的值
 * 给每个绘制步骤定光栅状态（`render/graph.ts` 的 `rasterState`），场景目标按需带深度附件（`render/scene.ts`）。依据是 p5-REPORT「P5d 语义的
 * 实测核对」：深度、剔除、非法值、缺键、正交场景同样测深度几行全部实测成立。拼错的键（ricepod 的 `depthtesting`）不在 `SUPPORTED_PASS`
 * 里，照旧报 `material:<键>`。
 *
 * 常量上的关键帧报 `value:animation`（材质 JSON 不经属性框架）。`context.sceneConstants` 是 effect 实例从 `scene.json` 覆盖进来的常量
 * （`bundle.ts` 已把它们并进 `pass.constantshadervalues`）：这些键上的关键帧由 `collectAnimations` 处理，这里跳过（P10a 步骤 2）。
 */
export function checkPassFeatures(
  pass: MaterialPass,
  unsupported: Set<string>,
  context: { sceneConstants?: Readonly<Record<string, unknown>> } = {},
): void {
  if (pass.blending && !SUPPORTED.blending.includes(pass.blending as never)) unsupported.add(`blend:${pass.blending}`);
  // COMBO 只按整数读（I3）：写成 `{user, value}` 时 WPE 断言中止整个进程，这里按不支持退回预览图
  for (const value of Object.values(pass.combos ?? {}))
    if (value && typeof value === "object") unsupported.add("combo:user-binding");
  if (alphaWritingUsed(pass.alphawriting)) unsupported.add("material:alphawriting");
  for (const key of ["keepaspect", "usertextures", "usertexturereference"])
    if (active(pass[key])) unsupported.add(`material:${key}`);
  for (const [key, value] of Object.entries(pass))
    if (
      !SUPPORTED_PASS.has(key) &&
      !["alphawriting", "keepaspect", "usertextures", "usertexturereference"].includes(key) &&
      active(value)
    )
      unsupported.add(`material:${key}`);
  for (const [key, value] of Object.entries(pass.constantshadervalues ?? {}))
    if (!(context.sceneConstants && Object.hasOwn(context.sceneConstants, key))) scanValue(value, unsupported);
}

/**
 * 翻译结果里依赖引擎、渲染器还不提供的部分：内置 uniform 与 COMBO。`extra` 是这类 pass 另外由渲染器写的引擎 uniform
 * （泛光链的 `g_RenderVar0`，见 `bloom.ts` 的 `POSTPROCESS_UNIFORMS`；粒子的 `PARTICLE_UNIFORMS`；effect pass 的 `EFFECT_UNIFORMS`；
 * 图层材质里它们没有意义，照报）。
 *
 * 两阶段同名、取值来源不同而被翻译器拆开的 uniform（`kb_vs_<名字>` / `kb_fs_<名字>`，带 `original`）总带 `meta.material`：
 * 翻译器让引擎值那一侧保留原名，改名的一侧一定是材质常量，所以这里按 `meta.material` 放行，不会被当成未知的引擎 uniform。
 */
export function checkProgramFeatures(
  result: TranslateResult,
  unsupported: Set<string>,
  extra: ReadonlySet<string> = new Set(),
): void {
  for (const uniform of result.uniforms ?? [])
    if (
      !uniform.unused && // WPE 的反射里没有它，不进常量缓冲（p7-REPORT「P7d 的实测」）
      typeof uniform.meta?.material !== "string" &&
      !isEngineUniform(uniform.name) &&
      !extra.has(uniform.name)
    )
      unsupported.add(`uniform:${uniform.name}`);
  for (const combo of result.combos ?? [])
    if (combo.value !== 0 && ENGINE_COMBOS.has(combo.name.toUpperCase()))
      unsupported.add(`combo:${combo.name.toUpperCase()}`);
}

/**
 * 一个图层 effect 的结构（`label` 是 effect 目录名，如 `tint`）。effect 不再整条报 `effect:<名字>`，
 * 而是逐项检查 effect.json、实例覆盖、fbo 与命令；材质与着色器由 `checkPassFeatures` / `checkProgramFeatures` 核对。
 *
 * `holds` 是 `conditions` 的求值（缺省按实例顶层 `combos`，同 `compileEffect`）：被条件去掉的 fbo、pass、bind 不进 bundle，
 * 也就不检查；`target` 指向被去掉的 fbo 等于没写，不报。
 */
export function checkEffectFeatures(
  instance: SceneEffectInstance,
  effect: EffectJson,
  label: string,
  unsupported: Set<string>,
  holds: (conditions: unknown) => boolean = (conditions) => conditionsHold(conditions, instance.combos),
): void {
  for (const [key, value] of Object.entries(instance))
    if (!SUPPORTED_EFFECT_INSTANCE.has(key) && active(value)) unsupported.add(`effect:${label}:${key}`);
  for (const pass of instance.passes ?? []) {
    for (const [key, value] of Object.entries(pass))
      if (!SUPPORTED_INSTANCE_PASS.has(key) && active(value)) unsupported.add(`effect:${label}:pass:${key}`);
    // 实例覆盖的 COMBO 同样不能绑用户属性（I3）
    const combos = pass.combos as Record<string, unknown> | undefined;
    for (const value of Object.values(combos ?? {}))
      if (value && typeof value === "object") unsupported.add("combo:user-binding");
  }
  for (const [key, value] of Object.entries(effect))
    if (!SUPPORTED_EFFECT.has(key) && active(value)) unsupported.add(`effect:${label}:${key}`);
  // effect.json 里的关键帧（语料 0 处，防御用）；实例上的由 `collectAnimations` 处理（P10a）
  scanValue(effect, unsupported);
  const fbos = new Set<string>();
  for (const fbo of effect.fbos ?? []) {
    if (!holds(fbo.conditions)) continue;
    if (typeof fbo.name !== "string" || !fbo.name) unsupported.add(`effect:${label}:fbo-name`);
    else fbos.add(fbo.name);
    for (const [key, value] of Object.entries(fbo))
      if (!SUPPORTED_FBO.has(key) && active(value)) unsupported.add(`effect:${label}:fbo:${key}`);
  }
  /** 被条件去掉的 fbo：WPE 按名字查不到下标（−1）。 */
  const removed = removedFbos(effect, holds);
  for (const pass of effect.passes ?? []) {
    if (!holds(pass.conditions)) continue;
    for (const [key, value] of Object.entries(pass))
      if (!SUPPORTED_EFFECT_PASS.has(key) && active(value)) unsupported.add(`effect:${label}:pass:${key}`);
    // bind 逐项查键（P7d 步骤 3 之前没人查，`conditions` 曾被静默忽略）；条件不满足的 bind 不进 bundle，不查
    if (Array.isArray(pass.bind))
      for (const bind of pass.bind as unknown[]) {
        if (!bind || typeof bind !== "object" || !holds((bind as JsonObject).conditions)) continue;
        for (const [key, value] of Object.entries(bind))
          if (!SUPPORTED_BIND.has(key) && active(value)) unsupported.add(`effect:${label}:bind:${key}`);
      }
    if (pass.command !== undefined) {
      if (pass.command !== "copy" && pass.command !== "swap")
        unsupported.add(`effect:${label}:command:${pass.command}`);
      if (typeof pass.source !== "string" || typeof pass.target !== "string")
        unsupported.add(`effect:${label}:command-operands`);
      else if (pass.command === "swap") {
        // swap 的一端被条件去掉：WPE 要求两端下标都 ≥ 0，否则什么都不做（rea-p7d-fluid 第 3 节第 3 条），`compileEffect`
        // 不收这条命令，不报
        const dropped = removed.has(pass.source) || removed.has(pass.target);
        // swap 只交换 fbo 的下标（B6），两端都必须是本 effect 的 fbo
        if (!dropped && (!fbos.has(pass.source) || !fbos.has(pass.target)))
          unsupported.add(`effect:${label}:swap-operands`);
      } else if (pass.command === "copy" && (removed.has(pass.source) || removed.has(pass.target)))
        // copy 的一端被条件去掉：WPE 拿 −1 做什么没读，语料 0 处，照报
        unsupported.add(`effect:${label}:command-operands`);
    } else if (typeof pass.material !== "string") unsupported.add(`effect:${label}:pass-without-material`);
    // 绘制目标只认本 effect 的 fbo；缺省为合成链。指向被条件去掉的 fbo 等于没写（WPE 查不到下标），不报
    if (
      pass.command === undefined &&
      pass.target !== undefined &&
      !fbos.has(String(pass.target)) &&
      !removed.has(String(pass.target))
    )
      unsupported.add(`effect:${label}:target:${pass.target}`);
  }
}

/**
 * 粒子着色器（`common_particles.h`）要、只有粒子路径才写的引擎 uniform：朝向、视图轴与 `g_RenderVar0/1`。渲染器在粒子
 * draw 里写它们（`render/uniforms.ts` 的 `particleBuiltins`，P4a 步骤 4，单测核对两边一致），所以粒子 pass 的程序检查
 * 把它们当引擎 uniform，图层材质里照报。`g_EyePosition`、`g_Texture0Resolution` 已在 `ENGINE_UNIFORMS` / 通配里。
 */
export const PARTICLE_UNIFORMS: ReadonlySet<string> = new Set([
  "g_OrientationUp",
  "g_OrientationRight",
  "g_OrientationForward",
  "g_ViewUp",
  "g_ViewRight",
  "g_RenderVar0",
  "g_RenderVar1",
]);

/**
 * 粒子材质允许非 0 的 COMBO（都是着色器自带的分支，数学全在着色器里）：
 * - `WORLDBLUR`、`USERCOLORBLEND`：P4a（`shimmering_particles` 的项目 `particle` 着色器，总计划「P4a 实现」）；
 * - `REFRACT`、`CUTOUT`：P4b 步骤 5（`genericparticle`）。引擎只负责在本对象画之前拷一次帧缓冲绑到 `g_Texture3`
 *   （`render/graph.ts` 的 `planParticleLayer`，时机同 rea-p4b-render.md 6.1），以及写 `g_ViewRight` / `g_ViewUp`；
 *   步骤 0 抓帧实测这两个视图轴与 `g_RefractAmount`、`g_Cutout*`、`g_Overbright` 都和我们写的相同（后几个是普通材质常量）；
 * - `NORMALMAP`：采样器 COMBO，槽 1 按名字绑了纹理就定义，WPE 运行时不读注解里的 `require` / `requireany`
 *   （rea-p4b-render.md 6.2）。`g_Texture1` 的声明在 `#if REFRACT || LIGHTING` 里，没开折射时定义了也不起作用
 *   （语料 `2903412088`）；法线按 `TEX1FORMAT` 解码，翻译器按 `formatcombo` 写这个宏。
 */
const PARTICLE_COMBOS = new Set(["WORLDBLUR", "USERCOLORBLEND", "REFRACT", "CUTOUT", "NORMALMAP"]);

/**
 * 粒子材质 pass 的 COMBO 与光照（混合由 `checkPassFeatures` 照常检查，剔除、深度按 `normalizeDepthKeys` 规整，引擎 uniform /
 * COMBO 由 `checkProgramFeatures` 带 `PARTICLE_UNIFORMS` 检查）。
 * - 材质写的、以及纹理槽注解带出的 COMBO（翻译结果 `source` 为 `request` / `texture`），值非 0 的只允许
 *   `PARTICLE_COMBOS` 里的，其余报 `particle:combo:<名字>`。
 * - 着色器注解的缺省值（`source: "default"`）不算：WPE 同样按缺省值编，翻译器照办。`genericparticle` 的 `FOG` 缺省为 1，
 *   但它只在引擎的 `FOG_DIST` / `FOG_HEIGHT` 下起作用，渲染器不定义这两个宏。
 * - 最终开了 `LIGHTING`（含着色器缺省值）报 `particle:lighting`：粒子的光照路径没有和 WPE 比过，本机 0 张。
 */
export function checkParticleProgram(
  pass: MaterialPass,
  result: TranslateResult | null,
  unsupported: Set<string>,
): void {
  const combos = new Map<string, number>();
  for (const [name, value] of Object.entries(staticCombos(pass.combos))) combos.set(name.toUpperCase(), Number(value));
  for (const combo of result?.combos ?? [])
    if (combo.source !== "default") combos.set(combo.name.toUpperCase(), combo.value);
  for (const [name, value] of combos) {
    if (value === 0 || PARTICLE_COMBOS.has(name)) continue;
    unsupported.add(name === "LIGHTING" ? "particle:lighting" : `particle:combo:${name}`);
  }
  if (result && usesLighting(result)) unsupported.add("particle:lighting");
}

/**
 * `children` 的条目（P4e 步骤 1，rea-p4e-children 第 1 节，`parseParticleChildEntry`）。只在是数组时读（`0x1401d0899`），值为 null 的
 * 键当缺键，不认识的键（含 `id`）没有读者、中性：
 * - 不是对象，或 `name` 不是非空字符串：`particle:child:name`（WPE 读到空文件名，加载失败，这棵子树不画）；
 * - 不认识的 `type`（含大小写不同的 `"Static"`）：中性，WPE 整条忽略（编号 0，实测 `st-type`）；
 * - 三种事件类型 `eventfollow`（P4e 步骤 2）、`eventspawn` / `eventdeath`（步骤 3）都已实现，不报（rea-p4e-children 第 4 节，实例池、
 *   跟随与触发见 `particles/system.ts`）；
 * - 条目键写成 `{user}` / `{script}`：`particle:binding:child:<键>`（WPE 按 `asString` / `asInt` 读，对象会抛异常）；
 * - `origin` / `angles` / `scale` 不是字符串：`particle:child:<键>`（WPE 把数值当指针读，语料都是字符串）；
 * - `flags` bit0 且 `controlpointstartindex` 为负：`particle:child:controlpointstartindex`（WPE 从负下标写控制点，越界，第 5 节【推】）。
 * 子系统文件读不到、解析失败由 `compileScene` 报（`particle:missing:<name>`、`particle:parse:<name>`）。
 */
export function checkParticleChildren(children: unknown, unsupported: Set<string>): void {
  if (!Array.isArray(children)) return;
  for (const raw of children) {
    const issues: ParticleChildIssue[] = [];
    const entry = parseParticleChildEntry(raw, issues);
    for (const issue of issues)
      unsupported.add(
        issue.kind === "binding" ? `particle:binding:child:${issue.field}` : `particle:child:${issue.field}`,
      );
    if (!entry) {
      unsupported.add("particle:child:name");
      continue;
    }
    // 三种事件类型都已实现（P4e 步骤 2、3），只剩条目字段与 `controlpointstartindex` 的检查
    if (entry.flags & 1 && entry.controlPointStartIndex < 0) unsupported.add("particle:child:controlpointstartindex");
  }
}

/**
 * 粒子 JSON 的能力检查，规则从模块表（`particles/modules.ts`）生成。依据见各条注释，系统级键见 `particles.ts`。
 * - 表外模块：`particle:<类别>:<名字>`；表内模块的未知字段、形状不对或本节不支持的取值：`particle:<类别>:<名字>:<字段>`；
 *   写成 `{user}` / `{script}`：`particle:binding:<类别>:<名字>:<字段>`。
 * - 系统 `flags`（C3）：bit0–7 支持。bit0 世界空间（P4c 步骤 4，rea-p4c-sim.md 第 5 节，实测见报告「P4c 语义的实测核对」与
 *   `ignore/p4/c4` 的回放）：模拟侧见 `particles/system.ts`，绘制时模型矩阵是单位阵（`render/scene.ts`）；组里的世界空间系统
 *   WPE 把模型矩阵换成 `ctx+0xaf0`（组画子树时设的 `inverse(W_组)`），我们是单位模型矩阵乘组的视图投影 `ortho · inverse(W_组)`，
 *   结果相同（P5b 步骤 4，`p5b-grpptc` 实测：世界坐标的顶点回到组的本地坐标）。
 *   bit1 唯一的读取点是关混帧
 *   （rea-p4b-render.md 2.3【确，有界】，P4b 步骤 2）。更高位逐位报 `particle:flags:<位值>`（WPE 解析时 `movzx` 只取低 8 位，
 *   `0x1401c56e9`，高位其实被丢掉；没有样本，保守报）。
 * - `children`（P4e 步骤 1，`checkParticleChildren`；WPE 只读数组，`0x1401d0899`）：`static` 与三种事件类型（`eventfollow` 步骤 2，
 *   `eventspawn` / `eventdeath` 步骤 3）的条目都已实现，子系统 JSON 由 `compileScene` 读出后照顶层同样检查。`options.children` 为 false 时
 *   不看（深度已到 `MAX_CHILD_DEPTH` 的系统，WPE 不读它的 `children`）。
 * - 控制点：全部支持或中性（P4c 步骤 1、2，`particles/controlpoints.ts`：`offset`、`flags` bit0 指针、bit1 已实现，bit2 父控制点、
 *   bit3 父分支不换算与 `parentcontrolpoint` 在子系统里实现（P4e 步骤 1），在顶层系统上 bit2 只让实例覆盖不生效、bit3 没有读者；
 *   `angles`、`locktopointer`、bit4 没有读者，理由见 `SceneControlPoint`）。关键帧照下面整段 `scanValue`。
 * - `animationmode`、`sequencemultiplier` 任意取值都支持（P4b 步骤 2）：只在材质槽 0 是帧表纹理时起作用（frame 列、混帧宏），
 *   否则是中性的。写成绑定或关键帧照下面两条报。帧表纹理用在粒子其它槽位是普通纹理（P4b 步骤 5），用在图像层、effect 由纹理
 *   报 `tex:animation`（`bundle.ts` 的 `getTexture`）。
 * - 其它顶层键：`particle:system:<键>`；顶层键写成绑定：`particle:binding:system:<键>`（WPE 按 `isNumeric` / `isString`
 *   读，对象当缺键，语义没核对）。`emitter` / `initializer` / `operator` 不是数组时同样报 `particle:system:<键>`。
 * - renderer：`sprite`、`spritetrail` 在表里，`orientation`、`axis`、`flags` 的取值全部支持（P4c 步骤 5，`particles/orientation.ts`）；
 *   `rope`（P4d 步骤 1）在表里，`subdivision`、`uvscale`、`uvscrolling`、`uvsmoothing` 的取值全部支持（`particles/rope.ts`）；
 *   `ropetrail`（P4d 步骤 2）在表里，`length`、`segments`、`subdivision`、`fadealpha`、`fadesize`、`uvscale`、`uvscrolling` 的取值
 *   全部支持（`particles/ropetrail.ts`）。多于一个报 `particle:renderers`：WPE 按数组顺序各画一次、共用同一个顶点缓冲、各绑自己的变体材质
 *   （rea-p4c-render.md 6.3，实测两种顺序都是两次绘制），我们一个粒子层只有一次绘制，支持它要拆成一个系统多次绘制（顶点布局
 *   能不能共用、每次绘制各自的 uniform、快照「每对象至多一次」、四角探针按绘制输出）。语料里这样的系统 0 张，留着不做
 *   （2026-11-09 用户定）。
 * - 属性关键帧（P4a 步骤 5）：系统级键、模块字段写成 `{animation: {…}, value}` 报 `value:animation`，与绑定分开报；
 *   控制点与子系统条目整段 `scanValue`。
 * - `mapsequence*`（P4d 步骤 3，`particles/mapsequence.ts`）在表里。`between` 的 `flags` 有 1、2、4、8、0x10、0x20 之外的位时由模块表
 *   报 `particle:initializer:mapsequencebetweencontrolpoints:flags`；系统里有 `around` 且有 emitter 开了周期发射（`flags & 4`）时报
 *   `particle:initializer:mapsequencearoundcontrolpoint:periodic`：新周期清不清零它的序号看记录里没写过的 `rec+0x58 & 2`（解析暂存区的
 *   残留值，rea-p4d-modules.md 1.1、1.3），没实测（phase-4d-ropes.md「决定」3）。语料里没有这种组合。
 * 值为 null 的键一律当缺键。
 */
export function checkParticleFeatures(
  system: JsonObject,
  orthographic: boolean,
  unsupported: Set<string>,
  options: { children?: boolean } = {},
): void {
  for (const [key, value] of Object.entries(system)) {
    if (value === null || value === undefined) continue;
    if (isUserBinding(value) || isScriptValue(value)) unsupported.add(`particle:binding:system:${key}`);
    // 关键帧和绑定分开报（P4a 步骤 5）：同时挂了 `user` / `script` 两个键都报
    if (isKeyframedValue(value)) unsupported.add("value:animation");
    if (!PARTICLE_SYSTEM_KEYS.has(key)) unsupported.add(`particle:system:${key}`);
  }
  // 控制点与子系统条目不走模块表，整段扫一次关键帧
  scanValue(system.controlpoint, unsupported);
  scanValue(system.children, unsupported);
  const { flags } = readParticleSystem(system);
  for (let bit = 8; bit < 32; bit++) if (flags & (1 << bit)) unsupported.add(`particle:flags:${(1 << bit) >>> 0}`);
  if (options.children !== false) checkParticleChildren(system.children, unsupported);
  // `mapsequencearoundcontrolpoint` 配周期发射（P4d 步骤 3）：新周期清不清零序号看 `rec+0x58 & 2`，是解析暂存区的残留值、没实测
  let around = false;
  let periodic = false;
  for (const category of PARTICLE_CATEGORIES) {
    const entries = particleModuleEntries(system, category);
    if (!entries) {
      unsupported.add(`particle:system:${category}`);
      continue;
    }
    // 一个系统多个 renderer 的绘制没做（见上）
    if (category === "renderer" && entries.length > 1) unsupported.add("particle:renderers");
    for (const entry of entries) {
      const reading = readParticleModule(category, entry, orthographic);
      const module = `${category}:${reading.name || "unnamed"}`;
      if (!reading.known) {
        unsupported.add(`particle:${module}`);
        continue;
      }
      if (category === "emitter" && (reading.fields.flags as number) & 4) periodic = true;
      if (module === "initializer:mapsequencearoundcontrolpoint") around = true;
      for (const issue of reading.issues)
        unsupported.add(
          issue.kind === "animation"
            ? "value:animation"
            : issue.kind === "binding"
              ? `particle:binding:${module}:${issue.field}`
              : `particle:${module}:${issue.field}`,
        );
    }
  }
  if (around && periodic) unsupported.add("particle:initializer:mapsequencearoundcontrolpoint:periodic");
}
