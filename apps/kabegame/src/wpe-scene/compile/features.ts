import type { SceneJson, SceneObject, ModelJson, MaterialPass, SceneValue } from "./model";

/** P1 能忠实呈现的值；新特性统一在这里命名，渲染器据 unsupported 决定回退。 */
export const SUPPORTED = {
  objects: ["image"],
  blending: ["normal", "translucent", "additive"],
  textureFormats: [0, 4],
  shaders: ["genericimage", "flag", "flowimage", "swayimage"],
} as const;
const NEUTRAL_GENERAL = new Set(["ambientcolor", "skylightcolor", "norecompile"]);
const SUPPORTED_GENERAL = new Set(["orthogonalprojection", "clearcolor", "clearenabled", "bloom", ...NEUTRAL_GENERAL]);
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
]);
const SUPPORTED_MODEL = new Set(["material", "width", "height"]);
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

export function scanValue(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) scanValue(v, unsupported);
    return;
  }
  if (!value || typeof value !== "object") return;
  if ("script" in value) unsupported.add("value:script");
  if ("user" in value && typeof (value as { user: unknown }).user === "object") unsupported.add("visible:condition");
  for (const v of Object.values(value)) scanValue(v, unsupported);
}

function active(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== "";
}

export function checkSceneFeatures(scene: SceneJson, unsupported: Set<string>): void {
  const g = scene.general ?? {};
  if (!g.orthogonalprojection) unsupported.add("camera:perspective");
  for (const key of ["bloom", "hdr", "cameraparallax", "camerashake", "camerafade", "supportsaudioprocessing"])
    if (active(g[key])) unsupported.add(`general:${key}`);
  // 数值调节项单独识别，防止开启某效果却只填写强度时漏报。
  for (const key of Object.keys(g))
    if (
      /^(bloom|camerashake|cameraparallax)/.test(key) &&
      !["bloom", "camerashake", "cameraparallax"].includes(key) &&
      active(g[key])
    )
      unsupported.add(`general:${key}`);
  for (const [key, value] of Object.entries(g))
    if (
      !SUPPORTED_GENERAL.has(key) &&
      !key.startsWith("bloom") &&
      !key.startsWith("cameraparallax") &&
      !key.startsWith("camerashake") &&
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
  if (active(object.parent)) unsupported.add("object:parent");
  if (Array.isArray(object.effects))
    for (const effect of object.effects)
      unsupported.add(
        `effect:${typeof effect === "object" && effect && "file" in effect ? (String(effect.file).split("/").at(-2) ?? "unknown") : "unknown"}`,
      );
  for (const key of [
    "copybackground",
    "solid",
    "perspective",
    "fullscreen",
    "passthrough",
    "ledsource",
    "instanceoverride",
    "attachment",
    "castshadow",
    "disablepropagation",
    "reflected",
    "skin",
  ])
    if (active(object[key])) unsupported.add(`object:${key}`);
  if (active(object.colorBlendMode)) unsupported.add(`blend:${object.colorBlendMode}`);
  if (active(object.parallaxDepth)) unsupported.add("object:parallax-depth");
  for (const [key, value] of Object.entries(object))
    if (
      !SUPPORTED_OBJECT.has(key) &&
      ![
        "parent",
        "copybackground",
        "solid",
        "perspective",
        "fullscreen",
        "passthrough",
        "ledsource",
        "instanceoverride",
        "attachment",
        "castshadow",
        "disablepropagation",
        "reflected",
        "skin",
        "colorBlendMode",
        "parallaxDepth",
        "model",
        "particle",
        "sound",
        "text",
        "light",
      ].includes(key) &&
      active(value)
    )
      unsupported.add(`object:${key}`);
  if (active(object.brightness) && object.brightness !== 1) unsupported.add("object:brightness");
  if (
    typeof object.visible === "object" &&
    object.visible &&
    "user" in object.visible &&
    typeof (object.visible as { user: unknown }).user === "object"
  )
    unsupported.add("visible:condition");
}

export function checkModelFeatures(model: ModelJson, unsupported: Set<string>): void {
  for (const key of ["puppet", "autosize", "fullscreen", "passthrough", "solidlayer"])
    if (active(model[key])) unsupported.add(`model:${key}`);
  for (const [key, value] of Object.entries(model))
    if (
      !SUPPORTED_MODEL.has(key) &&
      !["puppet", "autosize", "fullscreen", "passthrough", "solidlayer"].includes(key) &&
      active(value)
    )
      unsupported.add(`model:${key}`);
}

export function checkPassFeatures(pass: MaterialPass, unsupported: Set<string>): void {
  if (pass.blending && !SUPPORTED.blending.includes(pass.blending as never)) unsupported.add(`blend:${pass.blending}`);
  if (pass.shader && !SUPPORTED.shaders.includes(pass.shader as never))
    unsupported.add(`shader:${pass.shader}:unsupported`);
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
  for (const [key, value] of Object.entries(pass.combos ?? {}))
    if (key.toUpperCase() !== "TINT" && active(value)) unsupported.add(`combo:${key}`);
  scanValue(pass.constantshadervalues as Record<string, SceneValue> | undefined, unsupported);
}
