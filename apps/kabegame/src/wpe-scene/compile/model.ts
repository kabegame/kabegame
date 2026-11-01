export type SceneScalar = string | number | boolean | null;
export type SceneValue =
  | SceneScalar
  | { user: string | { name: string; condition?: string }; value: SceneScalar }
  | { script: string; value: SceneScalar };
export type JsonObject = Record<string, unknown>;
export interface ProjectJson extends JsonObject {
  file: string;
  general?: { properties?: Record<string, { value: SceneScalar }> };
}
export interface SceneJson extends JsonObject {
  camera?: JsonObject;
  general?: JsonObject;
  objects: SceneObject[];
}
export interface SceneObject extends JsonObject {
  id?: number;
  name?: string;
  image?: string;
  model?: string;
  particle?: string;
  origin?: SceneValue;
  scale?: SceneValue;
  angles?: SceneValue;
  size?: SceneValue;
  alpha?: SceneValue;
  color?: SceneValue;
  visible?: SceneValue;
  effects?: unknown[];
}
export interface ModelJson extends JsonObject {
  material?: string;
  width?: number;
  height?: number;
  autosize?: unknown;
  puppet?: unknown;
}
export interface MaterialPass extends JsonObject {
  shader?: string;
  blending?: string;
  cullmode?: string;
  depthtest?: string;
  depthwrite?: string;
  textures?: unknown[];
  combos?: Record<string, number | boolean>;
  constantshadervalues?: Record<string, SceneValue>;
  usershadervalues?: Record<string, string>;
}
export interface MaterialJson extends JsonObject {
  passes: MaterialPass[];
}
/** effect.json 的 `fbos[]`。 */
export interface EffectFboJson extends JsonObject {
  name?: string;
  format?: string;
  scale?: number;
  width?: number;
  height?: number;
  fit?: number;
  unique?: boolean;
  clear?: string;
  uvs?: string;
}
/** effect.json 的 `passes[]`：有 `material` 是绘制 pass，有 `command` 是 `copy` / `swap`。 */
export interface EffectPassJson extends JsonObject {
  material?: string;
  command?: string;
  source?: string;
  target?: string;
  compose?: boolean;
  bind?: { name?: string; index?: number }[];
}
export interface EffectJson extends JsonObject {
  passes?: EffectPassJson[];
  fbos?: EffectFboJson[];
}
/** scene.json 里图层 `effects[]` 的一项；`passes` 按顺序覆盖 effect.json 里各绘制 pass 的材质。 */
export interface SceneEffectInstance extends JsonObject {
  file?: string;
  id?: number;
  name?: string;
  visible?: SceneValue;
  passes?: {
    combos?: Record<string, number | boolean>;
    constantshadervalues?: Record<string, SceneValue>;
    textures?: unknown[];
    usershadervalues?: Record<string, string>;
  }[];
}

export function parseProject(text: string): ProjectJson {
  return JSON.parse(text) as ProjectJson;
}
export function parseScene(text: string): SceneJson {
  const scene = JSON.parse(text) as SceneJson;
  scene.objects ??= [];
  return scene;
}
export function parseModel(text: string): ModelJson {
  return JSON.parse(text) as ModelJson;
}
export function parseMaterial(text: string): MaterialJson {
  const material = JSON.parse(text) as MaterialJson;
  material.passes ??= [];
  return material;
}
export function parseEffect(text: string): EffectJson {
  const effect = JSON.parse(text) as EffectJson;
  effect.passes ??= [];
  effect.fbos ??= [];
  return effect;
}

/** 材质 `textures[]` 的一项：字符串、`{ name }` 或 null（null = 由运行时填）。 */
export function textureName(raw: unknown): string | null {
  if (typeof raw === "string") return raw || null;
  if (raw && typeof raw === "object" && "name" in raw && typeof raw.name === "string") return raw.name || null;
  return null;
}

/**
 * SceneScript 源码导出的名字（`export function x`、`export const x`、`export { a, b as c }`）；
 * `export default` 记为 `default`。只做词法扫描，不执行脚本。
 */
export function scriptExports(source: string): string[] {
  const names = new Set<string>();
  // 去掉注释与字符串字面量里的内容，避免把注释里的 `export function` 算进来
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, '""');
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g))
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (name) names.add(name);
    }
  if (/\bexport\s+default\b/.test(code)) names.add("default");
  return [...names];
}

/**
 * D10 脚本静态规则：只导出 `applyUserProperties`（没有 `update` / `init` 等每帧或生命周期入口）的脚本，P3 之前按
 * 绑定的 `value` 静态处理；用户属性对这类脚本的影响要等 P3 的脚本宿主才生效。
 */
export function isStaticScript(source: unknown): boolean {
  if (typeof source !== "string") return false;
  return scriptExports(source).every((name) => name === "applyUserProperties");
}

export function currentProperties(
  project: ProjectJson,
  overrides: Record<string, unknown>,
): Record<string, SceneScalar> {
  const result: Record<string, SceneScalar> = {};
  for (const [name, prop] of Object.entries(project.general?.properties ?? {})) result[name] = prop.value;
  for (const [name, value] of Object.entries(overrides))
    result[name] = (
      value && typeof value === "object" && "value" in value ? (value as { value: SceneScalar }).value : value
    ) as SceneScalar;
  return result;
}

export function resolveValue(
  value: SceneValue | undefined,
  properties: Record<string, SceneScalar>,
): SceneScalar | undefined {
  if (value && typeof value === "object") {
    if ("script" in value) return value.value;
    if (!("user" in value) || !value.user) return undefined;
    const name = typeof value.user === "string" ? value.user : value.user.name;
    const current = properties[name] ?? value.value;
    if (typeof value.user === "object" && value.user.condition !== undefined)
      return String(current) === value.user.condition;
    return current;
  }
  return value;
}

export function numbers(value: SceneScalar | undefined, fallback: number[] = []): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "boolean") return [value ? 1 : 0];
  if (typeof value === "string") {
    const parsed = value.trim().split(/\s+/).map(Number);
    if (parsed.length && parsed.every(Number.isFinite)) return parsed;
  }
  return fallback;
}
