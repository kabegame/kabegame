/**
 * `thisScene.createLayer(...args)` 的参数整理（P6d3b）：纯函数，照 WPE dll 的流程（`rea-p6d-script.md` 1.2、1.3）与 `__workshopId` 的路径改写
 * （2.2、2.3）。参数 → 一份配置对象（和 `scene.json` 里一个对象同一个形状），之后当成结构里的新建对象走编译。
 * 依赖宿主的几件事（realm 的 `stringifyConfig`、场景投影、当前脚本的 `__workshopId`、「路径在场景里存不存在」）经 `CreateConfigContext` 传入。
 */

import { isSoundObject, isTextObject, objectKind } from "../compile/features";
import type { SceneObject } from "../compile/model";
import { pkgKey } from "../compile/pkg";

export interface CreateConfigContext {
  /** realm 里 WPE 自带的 `_Internal.stringifyConfig`（`Vec` → "x y z"）；对象参数先过它 */
  stringify(value: unknown): string | undefined;
  /** 场景是不是正交（缺省模型：正交 `models/util/solidlayer_depthtest.json`，透视 `models/util/solidlayer.json`，步骤 0 实测） */
  orthographic: boolean;
  /** 「当前脚本」的 `__workshopId`（只认字符串；没有是 null） */
  workshopId: string | null;
  /**
   * 路径在场景查找范围（工程散文件、`scene.pkg`、WPE `assets`）里存在：宿主每次加载经命令 `wpe_scene_files` 拉全表，按
   * {@link sceneFileKey} 查。读码推测 WPE 的存在查询也是这三处（rea-p6d-script 2.2，没在 WPE 上实测）
   */
  exists(path: string): boolean;
  /** 值是 `IModelData` 句柄（P14，S16）：单参数时先包成 `{ model: 句柄 }` 再序列化，`model` 经 `toConfigString` 变成整数 token */
  isModelData?(value: unknown): boolean;
}

/** 缺省模型（不带参数、`{ color }` 没有任何内容键时的 `image`）。 */
export function defaultLayerModel(orthographic: boolean): string {
  return orthographic ? "models/util/solidlayer_depthtest.json" : "models/util/solidlayer.json";
}

/**
 * 场景文件表（`wpe_scene_files`）的键：`\` 换成 `/`、去掉开头的 `./` 与 `/`、并掉连续的 `/`，ASCII 字母不分大小写
 * （照 WPE 在 Windows 上的查找，同 {@link pkgKey}）。表里的路径与要查的路径都过它。
 */
export function sceneFileKey(path: string): string {
  return pkgKey(
    path
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/^(?:\.\/|\/)+/, ""),
  );
}

/** 配置里有任意一个就不补缺省模型。 */
const CONTENT_KEYS = ["model", "particle", "sprite", "image", "text", "light", "sound", "camera"] as const;
/** 顶层值是字符串才改写的键。 */
const REWRITTEN_KEYS = ["particle", "sprite", "image", "font", "path"] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function segments(path: string): string[] {
  return path.split(/[/\\]/).filter((part) => part !== "");
}

/**
 * `RP(path, key)`（rea-p6d-script 2.2）：当前脚本没有 `__workshopId`、或路径在场景里存在时原样；否则：
 * - `key === "textures"`：第一段是 `workshop` 去掉前两段，结果 `workshop/<id>/<其余>`；
 * - 其它：`first/workshop/<id>/其余`，其余 = 去掉第一段（只有一段时不去），其余的第一段是 `workshop` 再去掉两段。
 * 最后 `\` 换成 `/`、连续 `//` 并成一个。
 */
export function rewriteWorkshopPath(path: string, key: string | null, ctx: CreateConfigContext): string {
  const id = ctx.workshopId;
  if (id === null || id === "" || ctx.exists(path)) return path;
  const parts = segments(path);
  let out: string[];
  if (key === "textures") {
    const rest = parts[0] === "workshop" ? parts.slice(2) : parts;
    out = ["workshop", id, ...rest];
  } else {
    const first = parts[0] ?? "";
    let rest = parts.length > 1 ? parts.slice(1) : [...parts];
    if (rest[0] === "workshop") rest = rest.slice(2);
    out = [first, "workshop", id, ...rest];
  }
  return out
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
}

/** 字符串当资源路径：按第一段目录与最后一段的扩展名定键；别的目录 null。 */
function configFromPath(raw: string, ctx: CreateConfigContext): Record<string, unknown> | null {
  const path = raw.replace(/^[/\\]+/, "");
  const parts = segments(path);
  const last = parts.at(-1) ?? "";
  const dot = last.lastIndexOf(".");
  const extension = dot >= 0 ? last.slice(dot).toLowerCase() : "";
  let key: string;
  switch (parts[0]) {
    case "models":
      key = extension === ".json" ? "image" : "model";
      break;
    case "particles":
      key = "particle";
      break;
    case "materials":
      key = "sprite";
      break;
    case "sounds":
      key = "sound";
      break;
    default:
      return null;
  }
  return { [key]: rewriteWorkshopPath(path, null, ctx) };
}

/**
 * 对象 / JSON 字符串分支的「整理」：补缺省模型、对资源键做 `RP`。不改入参。缺省模型是 WPE 自带资源（assets 里有），`RP` 不改它
 * （`wpe-asset.log` 的 `arg color`：带 `__workshopId` 的脚本建出的仍是 `models/util/solidlayer_depthtest.json`）；补在改写之后，场景文件表
 * 拉取失败（空表）时也不改它。
 */
function tidy(input: Record<string, unknown>, ctx: CreateConfigContext): Record<string, unknown> {
  const config: Record<string, unknown> = { ...input };
  const needsDefault = "color" in config && !CONTENT_KEYS.some((key) => key in config);
  for (const key of REWRITTEN_KEYS)
    if (typeof config[key] === "string") config[key] = rewriteWorkshopPath(config[key] as string, key, ctx);
  const sound = config.sound;
  if (typeof sound === "string") config.sound = rewriteWorkshopPath(sound, "sound", ctx);
  else if (Array.isArray(sound))
    config.sound = sound.map((entry) => (typeof entry === "string" ? rewriteWorkshopPath(entry, "sound", ctx) : entry));
  if (Array.isArray(config.effects))
    config.effects = config.effects.map((effect) => {
      if (!isPlainObject(effect)) return effect;
      const next: Record<string, unknown> = { ...effect };
      if (typeof next.file === "string") next.file = rewriteWorkshopPath(next.file, "file", ctx);
      if (Array.isArray(next.passes))
        next.passes = next.passes.map((pass) => {
          if (!isPlainObject(pass) || !Array.isArray(pass.textures)) return pass;
          return {
            ...pass,
            textures: pass.textures.map((texture) =>
              typeof texture === "string" ? rewriteWorkshopPath(texture, "textures", ctx) : texture,
            ),
          };
        });
      return next;
    });
  if (needsDefault) config.image = defaultLayerModel(ctx.orthographic);
  return config;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * `createLayer(...args)` 的参数 → 配置（rea-p6d-script 1.2、1.3）；建不出来返回 null。
 * - 参数个数不是 1：`{ image: 缺省模型 }`；
 * - 对象（含数组）：（`IModelData` 句柄先包成 `{ model }`）先过 `stringify` 再 `JSON.parse`，普通对象走整理，数组原样返回（WPE 建出空名的分组节点，配置原文是这个数组），别的 null；
 * - 字符串：先当 JSON，是普通对象走整理，否则当路径（不补缺省模型、不整理）；
 * - 其它类型 null。
 */
export function createLayerConfig(
  args: readonly unknown[],
  ctx: CreateConfigContext,
): Record<string, unknown> | unknown[] | null {
  if (args.length !== 1) return { image: defaultLayerModel(ctx.orthographic) };
  const arg = args[0];
  if (typeof arg === "object" && arg !== null) {
    let text: string | undefined;
    try {
      text = ctx.stringify(ctx.isModelData?.(arg) ? { model: arg } : arg);
    } catch {
      return null;
    }
    if (typeof text !== "string") return null;
    const parsed = parseJson(text);
    if (!parsed.ok) return null;
    if (Array.isArray(parsed.value)) return parsed.value;
    return isPlainObject(parsed.value) ? tidy(parsed.value, ctx) : null;
  }
  if (typeof arg === "string") {
    const parsed = parseJson(arg);
    if (parsed.ok && isPlainObject(parsed.value)) return tidy(parsed.value, ctx);
    return configFromPath(arg, ctx);
  }
  return null;
}

/** 新建对象的类别（按配置的内容键）：声音 / 文本 / 图像 / 粒子 / 模型 / sprite / 灯，都没有（含数组配置）是分组节点。 */
export type CreatedLayerKind = "image" | "model" | "particle" | "sprite" | "sound" | "text" | "light" | "group";

export function createdLayerKind(config: Record<string, unknown> | unknown[]): CreatedLayerKind {
  if (Array.isArray(config)) return "group";
  const object = config as SceneObject;
  if (isSoundObject(object)) return "sound";
  if (isTextObject(object)) return "text";
  return objectKind(object) ?? "group";
}
