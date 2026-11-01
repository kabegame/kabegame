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
  isStaticScript,
  type EffectJson,
  type MaterialPass,
  type ModelJson,
  type SceneEffectInstance,
  type SceneJson,
  type SceneObject,
  type SceneValue,
} from "./model";
import type { TranslateResult } from "../wpesl2wgsl";

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
export function isEngineUniform(name: string): boolean {
  return ENGINE_UNIFORMS.has(name) || /^g_Texture\d+(?:Resolution|Texel)$/.test(name);
}

/**
 * 值非 0 时需要引擎提供数据、渲染器还没有的 COMBO。其余 COMBO（材质 / effect 自己的选项，如 `VERSION`、`BLENDMODE`、
 * rz 的 `HUEMODE`）只是着色器内部分支，交给翻译器即可。
 * - `SPRITESHEET`：要逐帧的 `g_Texture0Rotation` / `Translation`（P6），现在只给恒等帧；
 * - `ALPHATOCOVERAGE`：混合模式 3（B7），没有 MSAA 时结果不同；
 * - 光照、反射、蒙皮、变形、预光照：对应的 uniform 也会被 `uniform:*` 报出，这里一并列上，防止只改 COMBO 漏报。
 */
const ENGINE_COMBOS = new Set([
  "SPRITESHEET",
  "ALPHATOCOVERAGE",
  "LIGHTING",
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
 * - `norecompile`、`camerapreview`：编辑器选项。
 * - `camerafade`：加载时的淡入，不改变稳定画面。
 * - `bloom`、`hdr` 与全部 `bloom*` 调节项：由后处理档位裁决（`postprocess.ts`），泛光 / HDR 由 `bloom.ts` 与 `render/bloom.ts` 实现。
 * - `farz` / `fov` / `nearz`：正交投影不用；透视另报 `camera:perspective`。
 * - `supportsvideo`：只决定 D3D 设备的视频支持标志（G2 0x8000）；视频纹理另报 `tex:video`。
 * `cameraparallax*` / `camerashake*` 的调节项只在主开关打开时起作用，主开关打开时另报；`zoom` 为 1 时是恒等。
 */
const NEUTRAL_GENERAL = new Set([
  "orthogonalprojection",
  "clearcolor",
  "clearenabled",
  "ambientcolor",
  "skylightcolor",
  "norecompile",
  "camerapreview",
  "camerafade",
  "bloom",
  "hdr",
  "farz",
  "fov",
  "nearz",
  "supportsvideo",
]);

/**
 * 支持或中性的对象键。
 * - `colorBlendMode`：0 普通，31 改成 additive，其它值走 passthrough 上屏（B7 / B8）。
 * - `copybackground`：只对 passthrough 模型生效（B9），普通图像模型上没有渲染效果；passthrough 模型另报 `model:passthrough`。
 * - `solid`：渲染路径不读（B9，推断与鼠标命中有关）。
 * - `ledsource`：Razer Chroma 外设灯效的取色来源，不参与渲染。
 * - `brightness`：只在 HDR 下乘进颜色（B10，`render/uniforms.ts` 的 `colorScale`），LDR 下不生效。
 * - `locktransforms`：编辑器锁定。
 * - `parallaxDepth`：只在 `general.cameraparallax` 打开时起作用，那时已报 `general:cameraparallax`。
 * `alignment` 为 `center`、`perspective` 为 false 时中性，其余取值另报。
 */
const SUPPORTED_OBJECT = new Set([
  "id",
  "name",
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
/** 打开时改变画面、还没实现的对象开关。 */
const OBJECT_FLAGS = [
  "parent",
  "perspective",
  "fullscreen",
  "passthrough",
  "instanceoverride",
  "attachment",
  "castshadow",
  "disablepropagation",
  "reflected",
  "skin",
];
/** `autosize`：`size` 与模型 `width` / `height` 都缺失时取基础纹理的图像尺寸（`bundle.ts`），否则不起作用。 */
const SUPPORTED_MODEL = new Set(["material", "width", "height", "autosize"]);
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

export function scanValue(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) scanValue(v, unsupported);
    return;
  }
  if (!value || typeof value !== "object") return;
  // D10：只导出 applyUserProperties 的脚本按 value 静态处理，其余要脚本宿主（P3）
  if ("script" in value && !isStaticScript((value as { script: unknown }).script)) unsupported.add("value:script");
  if ("user" in value && typeof (value as { user: unknown }).user === "object") unsupported.add("visible:condition");
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
      !key.startsWith("bloom") &&
      !key.startsWith("cameraparallax") &&
      !key.startsWith("camerashake") &&
      !["supportsaudioprocessing", "zoom"].includes(key) &&
      active(value)
    )
      unsupported.add(`general:${key}`);
  for (const object of scene.objects) checkObjectFeatures(object, unsupported);
  scanValue(scene, unsupported);
}

export function checkObjectFeatures(object: SceneObject, unsupported: Set<string>): void {
  const kind = ["image", "model", "particle", "sound", "text", "light"].find((key) => active(object[key]));
  if (!kind) unsupported.add("object:empty");
  else if (kind !== "image") unsupported.add(`object:${kind}`);
  for (const key of OBJECT_FLAGS) if (active(object[key])) unsupported.add(`object:${key}`);
  if (object.alignment !== undefined && object.alignment !== "center") unsupported.add("object:alignment");
  for (const [key, value] of Object.entries(object))
    if (
      !SUPPORTED_OBJECT.has(key) &&
      !OBJECT_FLAGS.includes(key) &&
      !["alignment", "model", "particle", "sound", "text", "light"].includes(key) &&
      active(value)
    )
      unsupported.add(`object:${key}`);
  if (
    typeof object.visible === "object" &&
    object.visible &&
    "user" in object.visible &&
    typeof (object.visible as { user: unknown }).user === "object"
  )
    unsupported.add("visible:condition");
}

export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const key of ["puppet", "fullscreen", "passthrough", "solidlayer"])
    if (active(model[key])) unsupported.add(`model:${key}`);
  for (const [key, value] of Object.entries(model))
    if (
      !SUPPORTED_MODEL.has(key) &&
      !["puppet", "fullscreen", "passthrough", "solidlayer"].includes(key) &&
      active(value)
    )
      unsupported.add(`model:${key}`);
}

export function checkPassFeatures(pass: MaterialPass, unsupported: Set<string>): void {
  if (pass.blending && !SUPPORTED.blending.includes(pass.blending as never)) unsupported.add(`blend:${pass.blending}`);
  if (pass.cullmode && pass.cullmode !== "nocull") unsupported.add(`cull:${pass.cullmode}`);
  if (pass.depthtest && pass.depthtest !== "disabled") unsupported.add(`depthtest:${pass.depthtest}`);
  if (pass.depthwrite && pass.depthwrite !== "disabled") unsupported.add(`depthwrite:${pass.depthwrite}`);
  for (const key of ["alphawriting", "keepaspect", "usertextures", "usertexturereference"])
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
  for (const pass of instance.passes ?? [])
    for (const [key, value] of Object.entries(pass))
      if (!SUPPORTED_INSTANCE_PASS.has(key) && active(value)) unsupported.add(`effect:${label}:pass:${key}`);
  for (const [key, value] of Object.entries(effect))
    if (!SUPPORTED_EFFECT.has(key) && active(value)) unsupported.add(`effect:${label}:${key}`);
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
