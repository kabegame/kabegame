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
import { isKeyframedValue, isScriptValue, isUserBinding } from "./bindings";
import { resolveParents } from "./hierarchy";
import {
  INSTANCE_FIELDS,
  instanceVector,
  PARTICLE_SYSTEM_KEYS,
  particleModuleEntries,
  readParticleSystem,
  type ParticleInstance,
} from "./particles";
import { PARTICLE_CATEGORIES, readParticleModule } from "../particles/modules";
import type { TranslateResult } from "../wpesl2wgsl";
import type { SceneScript } from "./scripts";
import { scanScriptApi } from "./scriptApi";

export const SUPPORTED = {
  objects: ["image"],
  blending: ["normal", "translucent", "additive"],
  textureFormats: [0, 4],
  /** FreeImage 形态 `.tex`（mip 是整份图片文件）：2 JPEG、13 PNG，主线程 `createImageBitmap` 解码。 */
  freeImageFormats: [2, 13],
} as const;

/**
 * 渲染器会写入的引擎内置 uniform（翻译结果里没有 `meta.material` 的成员）。另有 `g_Texture<n>Resolution`。
 * 与 `render/uniforms.ts` 的 `staticBuiltins` / `frameBuiltins` 一一对应，`render.test.ts` 核对两边一致。
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
 * - `supportsvideo`：只决定 D3D 设备的视频支持标志（G2 0x8000）；视频纹理另报 `tex:video`。
 * - `gravitydirection` / `gravitystrength` / `windenabled` / `winddirection` / `windstrength`：REA 没找到引擎读取点，
 *   实测见 P4a 实施记录（`rea-p4a.md` C7：只在场景属性表里，粒子路径不碰，`movement` 的重力只来自模块自己的 `gravity`）。
 * `cameraparallax*` / `camerashake*` 的调节项只在主开关打开时起作用，主开关打开时另报；`zoom` 为 1 时是恒等。
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
 * - `copybackground`：只对 passthrough 模型生效（B9），普通图像模型上没有渲染效果；passthrough 模型另报 `model:passthrough`。
 * - `solid`：渲染路径不读（B9，推断与鼠标命中有关）。
 * - `ledsource`：Razer Chroma 外设灯效的取色来源，不参与渲染。
 * - `brightness`：只在 HDR 下乘进颜色（B10，`render/uniforms.ts` 的 `colorScale`），LDR 下不生效。
 * - `locktransforms`：编辑器锁定。
 * - `parallaxDepth`：只在 `general.cameraparallax` 打开时起作用，那时已报 `general:cameraparallax`。
 * - `parent`：层级已实现（P4a 步骤 1，`hierarchy.ts` 与 `render/layout.ts`）；灯对象例外，见 `checkObjectFeatures`。
 * `alignment` 为 `center`、`perspective` 为 false 时中性，其余取值另报。
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
]);
/**
 * 打开时改变画面、还没实现的对象开关。`instanceoverride` 不在这里（P4a 步骤 5）：粒子对象上按键检查
 * （`checkParticleInstance`），其它对象上 WPE 不读，照未知键报 `object:instanceoverride`（语料 0 个）。
 */
const OBJECT_FLAGS = [
  "perspective",
  "fullscreen",
  "passthrough",
  "attachment",
  "castshadow",
  "disablepropagation",
  "reflected",
  "skin",
];
/**
 * 支持或中性的模型键。
 * - `autosize`：`size` 与模型 `width` / `height` 都缺失时取基础纹理的图像尺寸（`bundle.ts`），否则不起作用。
 * - `solidlayer`：合成 RT 按图层 `size`（`compositeSize`）；UV 不内缩（`uvInset`）。
 *   `instanced` 另报 `model:instanced`，它的合成 RT 仍按纹理尺寸。
 */
const SUPPORTED_MODEL = new Set(["material", "width", "height", "autosize", "solidlayer"]);
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
  "passes",
  "fbos",
]);
const SUPPORTED_EFFECT_PASS = new Set(["material", "command", "source", "target", "compose", "bind"]);
const SUPPORTED_FBO = new Set(["name", "format", "scale", "width", "height", "fit", "unique", "clear", "uvs"]);
const SUPPORTED_EFFECT_INSTANCE = new Set(["file", "id", "name", "passes", "visible"]);
const SUPPORTED_INSTANCE_PASS = new Set(["id", "combos", "constantshadervalues", "textures"]);

/**
 * 递归扫描一个 JSON 值：属性关键帧 `{animation: {…}, value}` 报 `value:animation`（`isKeyframedValue`，P4a 步骤 5，
 * `sample-gaps.md` §3.3）。挂了 `user` / `script` 的同样报；puppet 的 `animationlayers[i].animation` 是整数 id，不报。
 * 覆盖：`checkSceneFeatures` 扫整个 scene（`general`、图层字段、effect 实例常量、`instanceoverride`），`checkPassFeatures`
 * 扫材质 pass（含常量），`checkModelFeatures` 扫模型 JSON，`checkEffectFeatures` 扫 effect.json；粒子 JSON 在
 * `checkParticleFeatures` 里按键检查（模块字段由 `readParticleModule` 报 `animation`）。
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
  for (const key of ["cameraparallax", "camerashake", "supportsaudioprocessing"])
    if (active(g[key])) unsupported.add(`general:${key}`);
  if (g.zoom !== undefined && g.zoom !== 1) unsupported.add("general:zoom");
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
  scanValue(scene, unsupported);
}

/**
 * 场景脚本用到 WPE 有、我们没实现的 API：`script:api:<分组>.<成员>`（表与匹配规则见 `scriptApi.ts`，用户定 2026-11-07）。
 * 只扫会执行的脚本：`collectScripts` 收集的 scene.json 脚本里，导入说明符无效的整段不求值（`ScriptRuntime.load`），不扫。
 * 脚本运行期的普通错误不在这里，仍只进脚本诊断（3b）。
 */
export function checkScriptFeatures(scripts: readonly SceneScript[], unsupported: Set<string>): void {
  for (const script of scripts) {
    if (script.errors.length) continue;
    for (const key of scanScriptApi(script)) unsupported.add(`script:api:${key}`);
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
 * 一个对象的能力检查。`parent` 是解析后的父对象下标（`hierarchy.ts` 的 `resolveParents`），根节点为 null。
 * 没有内容的对象是分组节点：WPE 把它建成只有变换的基类对象（P4a 实测），不报；它的 `effects` 不读（`bundle.ts`
 * 在没有 image 时不编译图层内容），所以也不报。
 *
 * 粒子对象自己的键（`origin`、`angles`、`scale`、`visible`、`parent` 等）照对象规则走；`instanceoverride` 要看粒子 JSON 的
 * `flags` 与场景 HDR，由 `checkParticleInstance` 在读到文件后检查；粒子 JSON 的用法由 `checkParticleFeatures` 检查。
 * 粒子不再有总括键（步骤 5 删掉了 `particle:pending`）：不支持的用法都要由这些细分键挡住。
 */
export function checkObjectFeatures(object: SceneObject, unsupported: Set<string>, parent: number | null = null): void {
  const kind = objectKind(object);
  if (kind === "particle") {
    // 带 effects 的粒子对象本机 0 个，P4 不做
    const effects = object.effects as unknown;
    if (Array.isArray(effects) ? effects.length > 0 : active(effects)) unsupported.add("particle:effects");
    for (const [key, defaults] of Object.entries(PARTICLE_OBJECT_DEFAULTS))
      if (particleObjectValueUsed(object[key], defaults)) unsupported.add(`particle:object:${key}`);
  } else if (kind && kind !== "image" && kind !== "light") unsupported.add(`object:${kind}`);
  // 灯的位置取本地 origin（`lights.ts`），挂在父链下时的位置没有和 WPE 比过，照报
  if (kind === "light" && parent !== null) unsupported.add("object:parent");
  const lightKey = (key: string) => kind === "light" && LIGHT_KEYS.has(key);
  for (const key of OBJECT_FLAGS) if (active(object[key]) && !lightKey(key)) unsupported.add(`object:${key}`);
  if (object.alignment !== undefined && object.alignment !== "center") unsupported.add("object:alignment");
  for (const [key, value] of Object.entries(object))
    if (
      !SUPPORTED_OBJECT.has(key) &&
      !OBJECT_FLAGS.includes(key) &&
      !["alignment", "model", "particle", "sound", "text", "light"].includes(key) &&
      !lightKey(key) &&
      !(kind === "particle" && key === "instanceoverride") &&
      active(value)
    )
      unsupported.add(`object:${key}`);
}

/**
 * 粒子对象的 `instanceoverride`（P4a 步骤 5，`rea-p4a.md` C3 / C5，`FUN_14022bd40`）。`flags` 是粒子 JSON 的系统 `flags`，
 * `hdr` 是场景实际的 HDR（`postprocess.hdr`），`resolved` 是编译期解析出的值（含用户属性）。
 * - `alpha`、`size`、`count`、`speed`、`lifetime`、`rate`：已实现（静态值与 `{user}`，就地更新），不报；`id` 是编辑器键。
 * - `brightness`：只在 HDR 且没有 bit3 时生效（乘实例颜色，没实现），这时取非默认值报 `particle:instance:brightness`；
 *   LDR 或有 bit3 时中性。绑了用户属性时 `bundle.ts` 把它登记成重编译目标，改成非默认值后由这里报。
 * - `color`、`colorn`：没有 bit3、且设了值（`r ≥ 0`，WPE 只看第一个分量，`0x14022bd9f`；或绑了用户属性）时报
 *   `particle:instance:colorn`。生效还要与系统颜色差 0.0035 以上，系统颜色的来源没读到，HSV 路径也没读全，所以 `"1 1 1"`
 *   也照报。
 * - `controlpoint0..7`、`controlpointangle0..7`：`particle:instance:controlpoint`（P4c）。
 * - 挂了 `{script}`：`particle:binding:instance:<键>`（脚本名 `instance`，P4f）。
 * - 其它键：`particle:instance:<键>`；不是对象：`particle:instance`。值为 null 的键当缺键。关键帧由 `scanValue` 报。
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
    if (isScriptValue(value)) unsupported.add(`particle:binding:instance:${key}`);
    if ((INSTANCE_FIELDS as readonly string[]).includes(key)) continue;
    if (key === "color" || key === "colorn") {
      const color = instanceVector(value);
      if (colorOverride && (isUserBinding(value) || (color !== null && color[0] >= 0)))
        unsupported.add("particle:instance:colorn");
    } else if (/^controlpoint(?:angle)?[0-7]$/.test(key)) unsupported.add("particle:instance:controlpoint");
    else unsupported.add(`particle:instance:${key}`);
  }
  if (context.hdr && colorOverride && resolved.brightness !== 1) unsupported.add("particle:instance:brightness");
}

/** 程序最终是否开了光照（COMBO 可能来自材质，也可能是着色器注解的默认值）。 */
export function usesLighting(result: TranslateResult): boolean {
  return (result.combos ?? []).some((combo) => combo.name.toUpperCase() === "LIGHTING" && combo.value !== 0);
}

export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const key of ["puppet", "fullscreen", "passthrough"]) if (active(model[key])) unsupported.add(`model:${key}`);
  for (const [key, value] of Object.entries(model))
    if (!SUPPORTED_MODEL.has(key) && !["puppet", "fullscreen", "passthrough"].includes(key) && active(value))
      unsupported.add(`model:${key}`);
  // 关键帧（语料 0 处，防御用）；puppet 的 `animationlayers` 是整数 id，不报
  scanValue(model, unsupported);
}

/**
 * 材质 pass 的 `alphawriting` 取值（`sample-gaps.md` §2.10，读码可定论）：映射 `"default"` 0、`"enabled"` 1、`"disabled"` 2
 * （`0x140157eb0`–`0x140157f40`）；绘制时 0 什么都不做，1 / 2 才保存设备状态、开关 alpha 写入（`0x140157201`）。
 * 所以 `"default"` 等于没写；其余取值照报。
 */
function alphaWritingUsed(value: unknown): boolean {
  return active(value) && value !== "default";
}

export function checkPassFeatures(pass: MaterialPass, unsupported: Set<string>): void {
  if (pass.blending && !SUPPORTED.blending.includes(pass.blending as never)) unsupported.add(`blend:${pass.blending}`);
  if (pass.cullmode && pass.cullmode !== "nocull") unsupported.add(`cull:${pass.cullmode}`);
  if (pass.depthtest && pass.depthtest !== "disabled") unsupported.add(`depthtest:${pass.depthtest}`);
  if (pass.depthwrite && pass.depthwrite !== "disabled") unsupported.add(`depthwrite:${pass.depthwrite}`);
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
  scanValue(pass.constantshadervalues as Record<string, SceneValue> | undefined, unsupported);
}

/**
 * 翻译结果里依赖引擎、渲染器还不提供的部分：内置 uniform 与 COMBO。`extra` 是这类 pass 另外由渲染器写的引擎 uniform
 * （泛光链的 `g_RenderVar0`，见 `bloom.ts` 的 `POSTPROCESS_UNIFORMS`；图层材质里它没有意义，照报）。
 */
export function checkProgramFeatures(
  result: TranslateResult,
  unsupported: Set<string>,
  extra: ReadonlySet<string> = new Set(),
): void {
  for (const uniform of result.uniforms ?? [])
    if (typeof uniform.meta?.material !== "string" && !isEngineUniform(uniform.name) && !extra.has(uniform.name))
      unsupported.add(`uniform:${uniform.name}`);
  for (const combo of result.combos ?? [])
    if (combo.value !== 0 && ENGINE_COMBOS.has(combo.name.toUpperCase()))
      unsupported.add(`combo:${combo.name.toUpperCase()}`);
}

/**
 * 一个图层 effect 的结构（`label` 是 effect 目录名，如 `tint`）。effect 不再整条报 `effect:<名字>`，
 * 而是逐项检查 effect.json、实例覆盖、fbo 与命令；材质与着色器由 `checkPassFeatures` / `checkProgramFeatures` 核对。
 */
export function checkEffectFeatures(
  instance: SceneEffectInstance,
  effect: EffectJson,
  label: string,
  unsupported: Set<string>,
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
  // effect.json 里的关键帧（语料 0 处，防御用）；实例上的已由 `checkSceneFeatures` 扫过
  scanValue(effect, unsupported);
  const fbos = new Set<string>();
  for (const fbo of effect.fbos ?? []) {
    if (typeof fbo.name !== "string" || !fbo.name) unsupported.add(`effect:${label}:fbo-name`);
    else fbos.add(fbo.name);
    for (const [key, value] of Object.entries(fbo))
      if (!SUPPORTED_FBO.has(key) && active(value)) unsupported.add(`effect:${label}:fbo:${key}`);
  }
  for (const pass of effect.passes ?? []) {
    for (const [key, value] of Object.entries(pass))
      if (!SUPPORTED_EFFECT_PASS.has(key) && active(value)) unsupported.add(`effect:${label}:pass:${key}`);
    if (pass.command !== undefined) {
      if (pass.command !== "copy" && pass.command !== "swap")
        unsupported.add(`effect:${label}:command:${pass.command}`);
      if (typeof pass.source !== "string" || typeof pass.target !== "string")
        unsupported.add(`effect:${label}:command-operands`);
      // swap 只交换 fbo 的下标（B6），两端都必须是本 effect 的 fbo
      else if (pass.command === "swap" && (!fbos.has(pass.source) || !fbos.has(pass.target)))
        unsupported.add(`effect:${label}:swap-operands`);
    } else if (typeof pass.material !== "string") unsupported.add(`effect:${label}:pass-without-material`);
    // 绘制目标只认本 effect 的 fbo；缺省为合成链
    if (pass.command === undefined && pass.target !== undefined && !fbos.has(String(pass.target)))
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

/** 粒子材质允许非 0 的 COMBO：`shimmering_particles` 自带 `particle` 着色器的分支，本节实现（总计划「P4a 实现」）。 */
const PARTICLE_COMBOS = new Set(["WORLDBLUR", "USERCOLORBLEND"]);

/**
 * 粒子材质 pass 的 COMBO 与光照（混合、剔除、深度由 `checkPassFeatures` 照常检查，引擎 uniform / COMBO 由
 * `checkProgramFeatures` 带 `PARTICLE_UNIFORMS` 检查）。
 * - 材质写的、以及纹理槽注解带出的 COMBO（翻译结果 `source` 为 `request` / `texture`），值非 0 的只允许 `WORLDBLUR`、
 *   `USERCOLORBLEND`，其余报 `particle:combo:<名字>`（`REFRACT`、`CUTOUT` 属 P4b）。
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

/** `"x y z"` 有没有非 0 分量；不是字符串（null 除外）时保守算有。 */
function nonZeroVector(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "string") return true;
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .some((part) => Number(part) !== 0);
}

/**
 * 控制点数组有没有实际内容（P4c 的范围）。依据 `ignore/p4/rea/parser.asm` 的 `0x1401d04d8`–`0x1401d080e`：先把 8 个槽清零，
 * 只在 `controlpoint` 是数组时读（`0x1401d051b`），按**数组下标**读前 8 项（`0x1401d080a`）、只读对象项（`0x1401d053e`）；
 * 每项读 `offset`（缺省 `"0 0 0"`）、`flags`（0）、`parentcontrolpoint`（0）、`angles`（只在是字符串时解析，缺省 0），`id` 不读。
 * 所以这几个键取缺省值时等于没写。`locktopointer` 不在这段里，读取点没找到，真值保守算内容；其余键同样保守算内容。
 */
function controlPointsUsed(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.slice(0, 8).some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return Object.entries(entry as Record<string, unknown>).some(([key, value]) => {
      if (value === null || value === undefined || key === "id") return false;
      if (key === "offset" || key === "angles") return nonZeroVector(value);
      if (key === "flags" || key === "parentcontrolpoint") return value !== 0 && value !== false;
      if (key === "locktopointer") return value !== false;
      return true;
    });
  });
}

/**
 * 粒子 JSON 的能力检查，规则从模块表（`particles/modules.ts`）生成。依据见各条注释，系统级键见 `particles.ts`。
 * - 表外模块：`particle:<类别>:<名字>`；表内模块的未知字段、形状不对或本节不支持的取值：`particle:<类别>:<名字>:<字段>`；
 *   写成 `{user}` / `{script}`：`particle:binding:<类别>:<名字>:<字段>`。
 * - 系统 `flags`（C3）：bit2–7 支持；bit0 世界空间没实测，报 `particle:flags:world`；bit1 读取点没找到，报 `particle:flags:2`；
 *   更高位逐位报 `particle:flags:<位值>`（WPE 解析时 `movzx` 只取低 8 位，`0x1401c56e9`，高位其实被丢掉；没有样本，保守报）。
 * - `children` 是非空数组：`particle:children`（P4e；WPE 只读数组，`0x1401d0899`）。
 * - `controlpoint` 有实际内容：`particle:controlpoint`（P4c，判定见 `controlPointsUsed`）。
 * - `animationmode` 是 `"randomframe"`、`sequencemultiplier` 是数字且不为 1：`particle:<键>`（帧表属 P4b）。
 * - 其它顶层键：`particle:system:<键>`；顶层键写成绑定：`particle:binding:system:<键>`（WPE 按 `isNumeric` / `isString`
 *   读，对象当缺键，语义没核对）。`emitter` / `initializer` / `operator` 不是数组时同样报 `particle:system:<键>`。
 * - renderer 多于一个：`particle:renderers`（多个 renderer 的绘制没读）。
 * - 属性关键帧（P4a 步骤 5）：系统级键、模块字段写成 `{animation: {…}, value}` 报 `value:animation`，与绑定分开报；
 *   控制点与子系统条目整段 `scanValue`。
 * 值为 null 的键一律当缺键。
 */
export function checkParticleFeatures(system: JsonObject, orthographic: boolean, unsupported: Set<string>): void {
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
  const { flags, animationMode, sequenceMultiplier } = readParticleSystem(system);
  if (flags & 1) unsupported.add("particle:flags:world");
  if (flags & 2) unsupported.add("particle:flags:2");
  for (let bit = 8; bit < 32; bit++) if (flags & (1 << bit)) unsupported.add(`particle:flags:${(1 << bit) >>> 0}`);
  if (animationMode !== "sequence") unsupported.add("particle:animationmode");
  if (sequenceMultiplier !== 1) unsupported.add("particle:sequencemultiplier");
  if (Array.isArray(system.children) && system.children.length > 0) unsupported.add("particle:children");
  if (controlPointsUsed(system.controlpoint)) unsupported.add("particle:controlpoint");
  for (const category of PARTICLE_CATEGORIES) {
    const entries = particleModuleEntries(system, category);
    if (!entries) {
      unsupported.add(`particle:system:${category}`);
      continue;
    }
    if (category === "renderer" && entries.length > 1) unsupported.add("particle:renderers");
    for (const entry of entries) {
      const reading = readParticleModule(category, entry, orthographic);
      const module = `${category}:${reading.name || "unnamed"}`;
      if (!reading.known) {
        unsupported.add(`particle:${module}`);
        continue;
      }
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
}
