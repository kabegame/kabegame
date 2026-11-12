import { init, parse } from "es-module-lexer";
import {
  GENERAL_FIELDS,
  isTextRuntimeField,
  type BindingTarget,
  type GeneralKey,
  type SceneBinding,
  type TargetKey,
  type TextRuntimeField,
  type ValueType,
} from "./bindings";
import { isSoundObject, isTextObject } from "./features";
import { resolveValue, type SceneJson, type SceneObject, type SceneScalar, type SceneValue } from "./model";
import { BLOOM_FIELDS } from "./postprocess";

export type ScriptOwner =
  | { kind: "layer"; object: number }
  | { kind: "material"; pass: TargetKey; layer: number }
  | { kind: "effect"; object: number; effect: number }
  | { kind: "general" };

export interface SceneScript {
  id: string;
  source: string;
  target: BindingTarget | { kind: "unsupported"; path: string };
  valueType: ValueType | "string";
  initial: SceneScalar;
  owner: ScriptOwner;
  layer: number | null;
  scriptProperties: Record<string, SceneScalar> | null;
  imports: string[];
  errors: string[];
}

export interface SceneScripts {
  list: SceneScript[];
}

const layerTypes: Record<string, ValueType> = {
  origin: "vec3",
  scale: "vec3",
  angles: "angles",
  alpha: "float",
  color: "vec3",
  brightness: "float",
  visible: "bool",
  // P5a 步骤 2：字段脚本写回到视差深度（语料 2582765611、2896608544）
  parallaxDepth: "vec2",
};

/**
 * 文本对象运行中可改的字段 → 字段脚本收发的形状（P6b 1e）：按字段定，不按初值猜。`text` 恒为字符串——初值是两三个词时
 * （`"Song Title"`、`"<Time and Date>"`）按初值猜会当成 vec2 / vec3，`update(value)` 收到 `Vec2(NaN, NaN)`；枚举同样是字符串
 * （WPE 类型 5），数字键 float、向量键 vec2、布尔位 bool。
 */
const textTypes: Record<TextRuntimeField, ValueType | "string"> = {
  text: "string",
  pointsize: "float",
  padding: "vec2",
  spacing: "vec2",
  maxwidth: "float",
  maxrows: "float",
  limitwidth: "bool",
  limitrows: "bool",
  limituseellipsis: "bool",
  blockalign: "bool",
  horizontalalign: "string",
  verticalalign: "string",
};

function valueType(initial: SceneScalar): ValueType | "string" {
  if (typeof initial === "boolean") return "bool";
  if (typeof initial === "number") return "float";
  if (typeof initial === "string") {
    const parts = initial.trim().split(/\s+/);
    if (parts.length === 2) return "vec2";
    if (parts.length === 3) return "vec3";
    if (parts.length === 4) return "vec4";
  }
  return "string";
}

/**
 * 字段脚本的写回目标。`sound`：声音对象自己的 `volume`（P6a 步骤 2）写回到就地目标 `{ kind: "sound" }`，返回值每帧写回、
 * 当场交给排期器（同 API 写 `thisLayer.volume`）。只认对象顶层的 `objects/<i>/volume`。
 * `text`：文本对象顶层的 `objects/<i>/<TEXT_RUNTIME_FIELDS 之一>`（P6b 1e）写回到文本目标，值变了才重排；`font`、
 * `opaquebackground` 等其余文本键仍是 `unsupported`（能力表另报 `text:script:<键>`）。
 */
function targetOf(
  path: string,
  owner: ScriptOwner,
  key: string,
  initial: SceneScalar,
  sound: boolean,
  text: boolean,
): SceneScript["target"] {
  if (owner.kind === "layer" && sound && path === `objects/${owner.object}/volume`)
    return { kind: "sound", object: owner.object, field: "volume" };
  if (owner.kind === "layer" && text && path === `objects/${owner.object}/${key}` && isTextRuntimeField(key))
    return { kind: "text", object: owner.object, field: key };
  if (owner.kind === "layer" && key in layerTypes)
    return { kind: "layer", object: owner.object, field: key as Extract<BindingTarget, { kind: "layer" }>["field"] };
  if (owner.kind === "effect" && key === "visible")
    return { kind: "effect", object: owner.object, effect: owner.effect };
  if (owner.kind === "general" && key === "bloom") return { kind: "bloom-enabled" };
  if (owner.kind === "general" && key in BLOOM_FIELDS)
    return { kind: "bloom", field: BLOOM_FIELDS[key as keyof typeof BLOOM_FIELDS] };
  if (owner.kind === "general" && key in GENERAL_FIELDS) return { kind: "general", key: key as GeneralKey };
  if (owner.kind === "material")
    return {
      kind: "constant",
      pass: owner.pass,
      material: key,
      uniforms: [],
      type: valueType(initial) === "string" ? "float" : (valueType(initial) as ValueType),
    };
  return { kind: "unsupported", path };
}

/** 原始 JSON 坐标扫描；不受可见性、effect 开关或编译快速回退影响。 */
export async function collectScripts(
  scene: SceneJson,
  properties: Record<string, SceneScalar>,
  bindings: SceneBinding[],
): Promise<SceneScripts> {
  await init;
  const list: SceneScript[] = [];
  function visit(value: unknown, path: string, owner: ScriptOwner, layer: number | null): void {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && "script" in value && typeof value.script === "string") {
      const raw = value as { script: string; value?: SceneScalar; scriptproperties?: Record<string, SceneValue> };
      const initial = raw.value ?? null;
      const key = path.split("/").at(-1) ?? "";
      const imports: string[] = [];
      const errors: string[] = [];
      try {
        for (const item of parse(raw.script)[0]) {
          if (item.n === undefined) continue;
          if (item.n === null) continue; // 变量动态 import 无法在编译期确定
          if (/^(?![./]|[a-z][\w+.-]*:)[\w-]+$/i.test(item.n)) imports.push(item.n);
          else errors.push(`不支持的模块说明符：${item.n}`);
        }
      } catch (error) {
        errors.push(`扫描导入失败：${String(error)}`);
      }
      const scriptProperties: Record<string, SceneScalar> = {};
      for (const [property, source] of Object.entries(raw.scriptproperties ?? {})) {
        scriptProperties[property] = resolveValue(source, properties) ?? null;
        if (source && typeof source === "object" && "user" in source) {
          const user = source.user;
          const name = typeof user === "string" ? user : user.name;
          bindings.push({
            property: name,
            ...(typeof user === "object" && user.condition !== undefined ? { condition: String(user.condition) } : {}),
            target: { kind: "script-property", script: path, key: property },
          });
        }
      }
      const object = owner.kind === "layer" ? (scene.objects as SceneObject[])[owner.object] : undefined;
      const sound = !!object && typeof object === "object" && isSoundObject(object);
      const text = !!object && typeof object === "object" && isTextObject(object);
      const target = targetOf(path, owner, key, initial, sound, text);
      list.push({
        id: path,
        source: raw.script,
        target,
        valueType:
          target.kind === "sound"
            ? "float"
            : target.kind === "text"
              ? textTypes[target.field]
              : owner.kind === "layer" && key in layerTypes
                ? layerTypes[key]
                : owner.kind === "general" && key in GENERAL_FIELDS
                  ? GENERAL_FIELDS[key as GeneralKey].type
                  : valueType(initial),
        initial,
        owner,
        layer,
        scriptProperties: raw.scriptproperties ? scriptProperties : null,
        imports: [...new Set(imports)],
        errors,
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const next =
          path === "objects"
            ? { kind: "layer" as const, object: index }
            : /^objects\/\d+\/effects$/.test(path)
              ? { kind: "effect" as const, object: layer!, effect: index }
              : owner;
        visit(entry, `${path}/${index}`, next, path === "objects" ? index : layer);
      });
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      let next = owner;
      let nextLayer = layer;
      if (path === "objects") {
        next = { kind: "layer", object: Number(key) };
        nextLayer = Number(key);
      } else if (/^objects\/\d+\/effects$/.test(path)) {
        next = { kind: "effect", object: layer!, effect: Number(key) };
      } else if (key === "constantshadervalues" && /\/passes\/\d+$/.test(path)) {
        next = { kind: "material", pass: path, layer: layer! };
      }
      visit(entry, path ? `${path}/${key}` : key, next, nextLayer);
    }
  }
  if (scene.general) visit(scene.general, "general", { kind: "general" }, null);
  visit(scene.objects, "objects", { kind: "general" }, null);
  return { list };
}
