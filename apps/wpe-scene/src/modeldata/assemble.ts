/**
 * 脚本模型数据层在主线程同步拼片段（P14 步骤 3a，方案甲）。
 *
 * WPE 的 `createLayer({ model: 句柄 })` 当帧就建好图层（Karin 在第一次 `update` 里一口气建出全部部件）。走 Worker 编片段（L5 没命中缓存那条路）会让
 * 部件晚几帧、分批出现，所以满足条件时由主线程用**编译期同一批纯函数**（`layerLiteral` / `modelDataMesh` / `modelDataModel` / `modelDataSortClass`）
 * 拼出片段：图层字面量来自配置，每个形状的 pass 取自加载时按 `general.precache` 预编的「模型材质模板」（`bundle.modelMaterials`），把键
 * `modeldata/<n>/…` 改成 `objects/<i>/meshes/<m>/…`，再按形状格式查着色器输入（`checkMeshAttributes`）。
 *
 * **两条路必须等价**：同一份配置与描述，这里拼出的片段与 Worker 里 `compileFragment` 编出的逐字段相同（`assemble.test.ts` 用编译会话对照）。
 * 所以同步条件收得很窄——只要有一处这里没有复刻的可能差异就返回 null，交给 Worker 路：
 * - 配置是普通对象；键都在 {@link ASSEMBLE_KEYS}、值都是平常值（数字 / 布尔 / 字符串，没有 `user` / `script` / `animation` 对象，所以没有绑定、脚本、关键帧）；
 * - `model` 的整数部分就是描述的 token；
 * - 场景是正交的、没有平面反射（透视场景会报 `camera:perspective:*`，反射名单要走会话的规则）；
 * - 每个形状的材质都有 `usable` 的模板。
 */
import type { ModelMaterialTemplate, SceneBundle, SceneLayer, SceneMesh, ScenePass } from "../compile/bundle";
import { normalizeConfig } from "../compile/config";
import { checkMeshAttributes } from "../compile/features";
import { layerUsesAudio, layerUsesMedia, type ObjectFragment } from "../compile/fragment";
import { layerShellValues } from "../compile/layerShell";
import { isSceneObject, type SceneObject } from "../compile/model";
import { layerLiteral, modelDataMesh, modelDataModel, modelDataSortClass, modelMaterialKey } from "./layer";
import type { ModelDataDesc } from "./types";

/**
 * 同步拼装认的配置键：`createLayer` 写的 `id`，Karin 部件用的 `name model origin angles scale visible alpha color brightness perspective solid`，
 * 以及 `parent`、`parallaxDepth`（图层壳的平常字段）、`colorBlendMode`（图层字面量取整的平常数字）、`castshadow`（投射阴影的平常布尔）。
 * 别的键（`effects`、`attachment`、`disablepropagation`、`clampuvs` 等）一律不拼：它们要么走能力检查、要么挂着登记，交给会话编。
 */
export const ASSEMBLE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "name",
  "model",
  "origin",
  "angles",
  "scale",
  "visible",
  "alpha",
  "color",
  "brightness",
  "perspective",
  "parent",
  "solid",
  "parallaxDepth",
  "colorBlendMode",
  "castshadow",
]);

/** 平常值：数字、布尔、字符串。带 `user` / `script` / `animation` 的对象、数组、null 都不算。 */
const isPlainValue = (value: unknown): boolean =>
  typeof value === "number" || typeof value === "boolean" || typeof value === "string";

/**
 * 建模型数据时的材质检查（`ModelDataStore.create` / `replace`，宿主与 dev 探针共用）：按 bundle 里的模板查。0 通过、1 材质读不到、2 着色器要的顶点属性格式给不出。
 * 没有模板（没进 precache）：此刻不知道着色器，创建照常成功，缺属性留给编译时报（不画 + 看板娘提示）。
 */
export function modelMaterialCheck(
  bundle: Pick<SceneBundle, "modelMaterials" | "programs"> | null | undefined,
  material: string,
  format: number,
): 0 | 1 | 2 {
  const key = modelMaterialKey(material);
  const template = key === null ? undefined : bundle?.modelMaterials?.[key];
  if (!template || !bundle) return 0;
  if (template.passes.length === 0) return 1;
  const issues = new Set<string>();
  for (const pass of [...template.passes, ...(template.shadow ? [template.shadow] : [])])
    if (pass.program !== null) checkMeshAttributes(bundle.programs[pass.program], format, issues);
  return issues.size > 0 ? 2 : 0;
}

/** 配置里 `model` 是数字时的 token（取整，同 `compileModel`）；不是数字时 null。配置不合法时也是 null。 */
export function modelTokenOf(config: string): number | null {
  try {
    const parsed: unknown = JSON.parse(config);
    if (!isSceneObject(parsed)) return null;
    const model = (parsed as Record<string, unknown>).model;
    return typeof model === "number" && Number.isFinite(model) ? Math.trunc(model) : null;
  } catch {
    return null;
  }
}

/** 把 pass 里（任意深度）以 `from` 开头的字符串值换成 `to` 开头；返回新值。 */
function rekeyPrefix<T>(value: T, from: string, to: string): T {
  if (typeof value === "string")
    return (
      value.startsWith(from) && (value.length === from.length || value[from.length] === "/")
        ? to + value.slice(from.length)
        : value
    ) as T;
  if (Array.isArray(value)) return value.map((item) => rekeyPrefix(item, from, to)) as T;
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = rekeyPrefix(item, from, to);
    return out as T;
  }
  return value;
}

/**
 * 模板的 pass 取成这个网格自己的一份：深拷贝，键 `modeldata/<n>/…` 换成 `objects/<object>/meshes/<mesh>/…`（模板的 pass 键是
 * `modeldata/<n>/passes/<k>`、阴影变体 `modeldata/<n>/shadow`），有 `material` 的（基础 pass；阴影变体没有）换成形状自己的（Worker 路用的就是它）。
 */
function meshPass(pass: ScenePass, object: number, mesh: number, material: string): ScenePass {
  const copy = structuredClone(pass);
  const match = /^modeldata\/(\d+)\//.exec(copy.key);
  const out = match ? rekeyPrefix(copy, `modeldata/${match[1]}`, `objects/${object}/meshes/${mesh}`) : copy;
  if (out.material !== undefined) out.material = material;
  return out;
}

export interface AssembleInput {
  /** `objects` 下标 */
  object: number;
  /** 配置里没写 `id` 时图层取的 id（`createLayer` 总会写，所以通常不用） */
  id: number;
  /** 运行中的父（`objects` 下标） */
  parent: number | null;
  /** 配置原文（`createLayer` 整理后的 JSON 文本，带 `id`） */
  config: string;
  desc: ModelDataDesc;
  bundle: Pick<SceneBundle, "modelMaterials" | "programs" | "general" | "reflection" | "audio">;
}

/**
 * 同步拼出模型数据层的片段；不满足同步条件（见文件头）返回 null，交给 Worker 路。片段形状同 `compileFragment`：和位置无关（`group` null、
 * `subtree` []），`bindings` / `scripts` / `animations` 为空、`sceneFlips` 为空、`reflected` 假；`unsupported` 是按形状格式查出的 `mdl:*` 键（排序）。
 */
export function assembleModelDataFragment(input: AssembleInput): ObjectFragment | null {
  const { object: index, parent, desc, bundle } = input;
  const templates = bundle.modelMaterials;
  // 透视场景 / 平面反射：能力检查与反射名单是会话的事（见文件头）
  if (!templates || bundle.general.perspective || bundle.reflection?.enabled === true) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.config);
  } catch {
    return null;
  }
  if (!isSceneObject(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) if (!ASSEMBLE_KEYS.has(key) || !isPlainValue(value)) return null;
  const model = record.model;
  if (typeof model !== "number" || Math.trunc(model) !== desc.token) return null;
  // 每个形状的材质都要有可用的模板
  const found: ModelMaterialTemplate[] = [];
  for (const shape of desc.shapes) {
    const key = modelMaterialKey(shape.material);
    const template = key === null ? undefined : templates[key];
    if (!template?.usable || template.passes.length === 0) return null;
    found.push(template);
  }
  const object = parsed as SceneObject;
  const shell = layerShellValues(object);
  const colorBlendMode = typeof record.colorBlendMode === "number" ? Math.trunc(record.colorBlendMode) : 0;
  const layer: SceneLayer = layerLiteral(object, index, parent, shell, colorBlendMode, input.id);
  if (record.solid === false) layer.solid = false;
  layer.perspective = record.perspective === true;
  // 网格：模板的 pass 改键，按形状格式查着色器输入（含阴影变体）
  const unsupported = new Set<string>();
  const meshes: SceneMesh[] = desc.shapes.map((shape, m) => {
    const template = found[m];
    const passes = template.passes.map((pass) => meshPass(pass, index, m, shape.material));
    const shadow = template.shadow ? meshPass(template.shadow, index, m, shape.material) : undefined;
    for (const pass of passes)
      if (pass.program !== null) checkMeshAttributes(bundle.programs[pass.program], shape.format, unsupported);
    if (shadow && shadow.program !== null)
      checkMeshAttributes(bundle.programs[shadow.program], shape.format, unsupported);
    return modelDataMesh(desc.token, m, shape, passes, shadow);
  });
  // 场景有阴影：模板编的时候定的（有阴影时每个模板都带这个标志，见 `compileModelMaterialTemplate`）
  const castsShadows = found.some((template) => template.castsShadows === true);
  layer.model = modelDataModel(desc, meshes, { castsShadows, castSetting: record.castshadow });
  layer.sortClass = modelDataSortClass(meshes);
  return {
    object: index,
    config: normalizeConfig(parsed),
    layer,
    bindings: [],
    scripts: [],
    animations: [],
    reflected: false,
    sceneFlips: [],
    // 同 `objectSlice`：`bundle.audio` 为假时（没声明开关）一定也是假；模板不带用户纹理，所以没有封面槽
    audio: bundle.audio === true && layerUsesAudio(layer, bundle.programs),
    media: layerUsesMedia(layer, []),
    unsupported: [...unsupported].sort(),
  };
}
