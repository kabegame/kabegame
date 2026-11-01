import { SceneFs, type SceneReader } from "./fs";
import { checkModelFeatures, checkPassFeatures, checkSceneFeatures } from "./features";
import {
  currentProperties,
  numbers,
  parseMaterial,
  parseModel,
  parseProject,
  parseScene,
  resolveValue,
  type MaterialPass,
  type SceneScalar,
  type SceneValue,
} from "./model";
import { ShaderCompiler } from "./shader";
import { parseTex, TEX_FLAGS, type TexResult } from "./tex";
import type { TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

export interface SceneGeneral {
  width: number;
  height: number;
  clearColor: number[];
  clearEnabled: boolean;
  camera: { eye: number[]; center: number[]; up: number[] };
}
export interface SceneTexture {
  path: string;
  source: string;
  format: number;
  width: number;
  height: number;
  textureWidth: number;
  textureHeight: number;
  flags: number;
  clampUVs: boolean;
  noInterpolation: boolean;
  /** unsupported 非空时可能为空：编译器只读头部，不解码 mip。 */
  mips: { width: number; height: number; bytes: Uint8Array }[];
  videoRange?: { start: number; end: number };
}
export interface ScenePass {
  program: number | null;
  blending: string;
  cullmode: string;
  depthtest: string;
  depthwrite: string;
  textures: Record<number, number>;
  uniforms: Record<string, number[]>;
}
export interface SceneLayer {
  id: number;
  name: string;
  origin: number[];
  scale: number[];
  angles: number[];
  size: number[];
  alpha: number;
  color: number[];
  visible: boolean;
  passes: ScenePass[];
}
export interface SceneBundle {
  general: SceneGeneral;
  layers: SceneLayer[];
  programs: TranslateResult[];
  textures: SceneTexture[];
  /** 非空时渲染器必须回退预览图，不能用可能缺少 mip 的 textures 渲染。 */
  unsupported: string[];
}
export interface CompileSceneInput {
  projectDir: string;
  sceneAssets: string[];
  userProperties?: Record<string, unknown>;
  reader: SceneReader;
  translator: Wpesl2wgsl | null;
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
export function shaderUniforms(
  result: TranslateResult | null,
  pass: MaterialPass,
  properties: Record<string, SceneScalar>,
): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  if (!result?.ok) return values;
  for (const uniform of result.uniforms ?? []) {
    const material = uniform.meta?.material;
    if (typeof material !== "string") continue;
    const property = Object.entries(pass.usershadervalues ?? {}).find(([, target]) => target === material)?.[0];
    const raw =
      (property ? properties[property] : undefined) ??
      resolveValue(pass.constantshadervalues?.[material], properties) ??
      (uniform.meta?.default as SceneScalar | undefined);
    if (raw !== undefined) values[uniform.name] = numbers(raw);
  }
  return values;
}

export async function compileScene(input: CompileSceneInput): Promise<SceneBundle> {
  const fs = new SceneFs(input.projectDir, input.sceneAssets, input.reader);
  const unsupported = new Set<string>();
  const projectText = await fs.text("project.json");
  if (!projectText) throw new Error("缺少 project.json");
  const project = parseProject(projectText);
  const sceneText = await fs.text(project.file);
  if (!sceneText) throw new Error(`缺少场景入口：${project.file}`);
  const scene = parseScene(sceneText);
  const properties = currentProperties(project, input.userProperties ?? {});
  checkSceneFeatures(scene, unsupported);
  const general = scene.general ?? {},
    camera = scene.camera ?? {};
  const projection =
    general.orthogonalprojection && typeof general.orthogonalprojection === "object"
      ? (general.orthogonalprojection as { width?: number; height?: number })
      : {};
  const bundle: SceneBundle = {
    general: {
      width: projection.width ?? 1920,
      height: projection.height ?? 1080,
      clearColor: numbers(resolveValue(general.clearcolor as SceneValue, properties), [0, 0, 0]),
      clearEnabled: general.clearenabled !== false,
      camera: {
        eye: numbers(resolveValue(camera.eye as SceneValue, properties), [0, 0, 1]),
        center: numbers(resolveValue(camera.center as SceneValue, properties), [0, 0, 0]),
        up: numbers(resolveValue(camera.up as SceneValue, properties), [0, 1, 0]),
      },
    },
    layers: [],
    programs: [],
    textures: [],
    unsupported: [],
  };
  const shader = new ShaderCompiler(fs, input.translator, unsupported);
  const textureIndex = new Map<string, number>();
  const programIndex = new Map<TranslateResult, number>();
  async function getTexture(name: string): Promise<{ index: number; format: number } | null> {
    const path = texturePath(name);
    if (path.startsWith("_rt_")) {
      unsupported.add("texture:rendertarget");
      return null;
    }
    const existing = textureIndex.get(path);
    if (existing !== undefined) return { index: existing, format: bundle.textures[existing].format };
    const file = await fs.resolve(path);
    if (!file) {
      unsupported.add(`texture:missing:${path}`);
      return null;
    }
    let tex: TexResult;
    try {
      tex = await parseTex(file, unsupported.size === 0);
    } catch (error) {
      unsupported.add(`tex:parse:${path}:${String(error)}`);
      return null;
    }
    for (const key of tex.unsupported) unsupported.add(key);
    const index = bundle.textures.length;
    textureIndex.set(path, index);
    bundle.textures.push({
      path,
      source: file.source,
      format: tex.format,
      width: tex.width,
      height: tex.height,
      textureWidth: tex.textureWidth,
      textureHeight: tex.textureHeight,
      flags: tex.flags,
      clampUVs: !!(tex.flags & TEX_FLAGS.clampUVs),
      noInterpolation: !!(tex.flags & TEX_FLAGS.noInterpolation),
      mips:
        tex.images[0]?.mips.flatMap((mip) =>
          mip.bytes ? [{ width: mip.width, height: mip.height, bytes: mip.bytes }] : [],
        ) ?? [],
      videoRange: tex.videoRange,
    });
    return { index, format: tex.format };
  }
  for (const object of scene.objects) {
    const layer: SceneLayer = {
      id: object.id ?? bundle.layers.length,
      name: object.name ?? "",
      origin: numbers(resolveValue(object.origin, properties), [0, 0, 0]),
      scale: numbers(resolveValue(object.scale, properties), [1, 1, 1]),
      angles: numbers(resolveValue(object.angles, properties), [0, 0, 0]),
      size: numbers(resolveValue(object.size, properties)),
      alpha: asNumber(resolveValue(object.alpha, properties), 1),
      color: numbers(resolveValue(object.color, properties), [1, 1, 1]),
      visible: resolveValue(object.visible, properties) !== false,
      passes: [],
    };
    bundle.layers.push(layer);
    if (!object.image) continue;
    const modelText = await fs.text(object.image);
    if (!modelText) {
      unsupported.add(`model:missing:${object.image}`);
      continue;
    }
    const model = parseModel(modelText);
    checkModelFeatures(model, unsupported);
    if (!layer.size.length) layer.size = [model.width ?? 0, model.height ?? 0];
    if (!model.material) {
      unsupported.add("material:missing");
      continue;
    }
    const materialText = await fs.text(model.material);
    if (!materialText) {
      unsupported.add(`material:missing:${model.material}`);
      continue;
    }
    const material = parseMaterial(materialText);
    for (const pass of material.passes) {
      checkPassFeatures(pass, unsupported);
      const slots: Record<number, number> = {};
      const formats: { slot: number; format: number }[] = [];
      for (const [slot, raw] of (pass.textures ?? []).entries()) {
        const name =
          typeof raw === "string" ? raw : raw && typeof raw === "object" && "name" in raw ? String(raw.name) : "";
        if (!name) continue;
        const texture = await getTexture(name);
        if (texture) {
          slots[slot] = texture.index;
          formats.push({ slot, format: texture.format });
        }
      }
      const result = pass.shader ? await shader.compile(pass.shader, pass.combos ?? {}, formats) : null;
      if (!pass.shader) unsupported.add("shader:missing");
      let program: number | null = null;
      if (result?.ok) {
        const old = programIndex.get(result);
        program = old ?? bundle.programs.length;
        if (old === undefined) {
          programIndex.set(result, program);
          bundle.programs.push(result);
        }
      }
      layer.passes.push({
        program,
        blending: pass.blending ?? "normal",
        cullmode: pass.cullmode ?? "nocull",
        depthtest: pass.depthtest ?? "disabled",
        depthwrite: pass.depthwrite ?? "disabled",
        textures: slots,
        uniforms: shaderUniforms(result, pass, properties),
      });
    }
  }
  if (!input.sceneAssets.length) unsupported.add("assets:missing");
  bundle.unsupported = [...unsupported].sort();
  return bundle;
}

export function transferableBuffers(bundle: SceneBundle): ArrayBuffer[] {
  return [
    ...new Set(
      bundle.textures.flatMap((texture) =>
        texture.mips
          .map((mip) => mip.bytes.buffer)
          .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
      ),
    ),
  ];
}
