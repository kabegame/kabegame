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
