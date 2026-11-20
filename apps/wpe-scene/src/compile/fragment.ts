/**
 * 对象片段（活的场景图 L1，`.claude/plans/wpe-import/3-scene/live/phase-l1-session.md`）：一个对象自己的编译产物，和它在场景里的位置无关。
 *
 * 片段有两种来源，互为判据（L1 验收在全语料上逐字段比）：
 * - `compileFragment`（`bundle.ts` 的编译会话）：对新对象真编一遍，按调用前后各表的长度切出片段与增量；
 * - `rekeyFragment(fragmentOf(bundle, i), 新下标)`：从整场 bundle 里取出模板对象的片段再改键（P6d4 的克隆）。
 *
 * L6 起 `compileFragment` 也重编已有对象（单对象重编译，请求带 `overrides`）：片段形状同新对象，宿主拿它替换场景里的这个对象。判据同上：
 * `compileFragment({ object: i, overrides: {} })` 等于 `fragmentOf(bundle, i)`，带覆盖时等于「带同样 `scriptOverrides` 整场编」的 `fragmentOf`
 * （`ignore/live/l6/recompile.test.ts`）。
 *
 * **位置相关的量不进片段**（组归属、组的子树、挂点、灯的遗留槽位都取决于运行中的父链与别的对象，由 L3 的运行时派生量现算）：
 * `group` 为 null、`subtree` 为 []、没有 `attachment`、灯 `legacySlot` 为 -1。这样同一个配置在任何位置的片段都一样，片段缓存（L5）才能按规整配置命中。`groupUpload` 和位置无关（L7）：组合层不论有没有
 * 子层都带它（整场里没有子层的组合层的那份在全部对象之后编、程序在程序表尾；片段里在这个对象自己的程序之后，在片段的程序表里）。
 *
 * **`rekeyFragment` 的字段清单**（以点 4 的全语料对照为准，漏了会显示成 A、B 不同）：
 * - 字符串里的 `objects/<from>` 前缀（后面是 `/` 或字符串到尾）换成 `objects/<to>`（`rekeyValue` 深度遍历，只认前缀、不认包含）：
 *   - 图层：pass 键（基础 `objects/<i>/passes/<k>`、effect `…/effects/<j>/passes/<k>`、`passthrough`、`groupupload`、粒子 `particle/…`
 *     含子系统与第 r 个 renderer、文本 `text/background|glyphs|color|clearalpha`、模型网格 `meshes/<m>/passes|shadow`、sprite 的
 *     `sprite/…` 与 `occlusion/…`、puppet 的 `passes/0` / `puppetupload` / `texchan` / `puppetclip/<r>`）、文本的 `backgroundTarget`；
 *   - 绑定：目标的 `pass`、`path`（recompile）、`script`（script-property）；
 *   - 脚本：`id`、`owner.pass`（材质属主）、`target.pass` / `target.path`；
 *   - 关键帧：`id`、`owner`（路径去掉最后一段，如 `objects/3`，所以前缀后面可以直接到尾）、`target.pass` / `target.path`；
 * - 数字字段（只在等于 `from` 时换）：
 *   - 图层 `object`；图层 `id` 换成新 id；图层 `parent` 取新父；
 *   - 绑定 / 脚本 / 关键帧的目标里的 `object`（layer、rotation、effect、light、particle-instance、sound、text、camera、animation-layer）；
 *   - 脚本的 `layer`、脚本属主的 `object`（layer、animation-layer、effect 三种）与 `layer`（material 属主，对象下标）；
 *     animation-layer 属主 / 目标的 `layer` 是动画层 id（JSON 下标），不换；
 *   - 关键帧的 `object`；声音、灯的 `object`；
 * - 不换：`layerComposites` 的值与 `UserTextureReference.object`（指向别的图层）、纹理 / 程序 / 用户纹理的全局下标、关键帧的片段内 `parent`、
 *   `config`、类型化数组与 Map / Set 等非普通对象（原样共用）。
 */
import type { SceneAnimation } from "../animation/types";
import type { BindingTarget, SceneBinding } from "./bindings";
import type { SceneBundle, SceneLayer, ScenePass, SceneTexture } from "./bundle";
import { readsAudioUniforms } from "./features";
import type { SceneLightObject } from "./lights";
import { exportsMediaCallback } from "./scriptApi";
import type { SceneScript } from "./scripts";
import type { SceneSound } from "./sounds";
import type { UserTextureSource } from "./usertextures";
import type { TranslateResult } from "../wpesl2wgsl";
import { particleUsesAudio } from "../particles/audio";
import type { ModelDataDesc } from "../modeldata/types";

/** 运行中编一个对象的请求（L1；L2 起经 Worker 传）。 */
export interface FragmentRequest {
  /**
   * `objects` 下标。新下标（≥ 会话里的对象数，中间空位补 null）是运行中建的新对象（L1）；已有下标是单对象重编译（L6），要带 `overrides`，
   * 没带时抛错
   */
  object: number;
  /** 配置原文（JSON 文本）。数组配置编成分组节点，同 P6d3b 的 `structure.created`。单对象重编译时不读（会话用开会话时留的原文） */
  config: string;
  /**
   * 单对象重编译的覆盖（L6）：这个对象累计的全部覆盖（不是增量），值同 `scriptOverrides`；路径**相对对象**（`font`、`effects/0/visible`），
   * 不带 `objects/<i>/` 前缀。属性绑定的值不在这里，会话按 `properties` 取。新对象不读
   */
  overrides?: Record<string, number[] | boolean | string>;
  /** 运行中的父（`objects` 下标）与挂点骨骼名：父写进 `parents[object]`，骨骼名写进对象 JSON 的 `attachment`（同 `structure.parents`） */
  parent: number | null;
  bone: string | null;
  /** 当前属性全集（用户值）：会话按它重算 `properties`，绑定按它取值 */
  properties: Record<string, unknown>;
  /**
   * 脚本模型数据的描述（P14，token → 描述）：配置里 `model` 是整数 token 时宿主带上它的描述（新建与单对象重编译都带），按 token 覆盖会话里的；
   * 查不到的 token 不带，编出不画的层（S16）。描述里没有字节，结构化克隆很小。
   */
  modelData?: Record<number, ModelDataDesc>;
}

/** 一个对象的编译产物（L1）。下标都是全局的；键是绝对路径 `objects/<object>/…`，克隆由 `rekeyFragment` 改。 */
export interface ObjectFragment {
  object: number;
  /** 规整配置（`normalizeConfig`，去顶层 id、键排序）：片段缓存的键 */
  config: string;
  /** 和位置无关：`group` null、`subtree` []、没有 `attachment` */
  layer: SceneLayer;
  /** 对象级绑定（目标指向这个对象的），按登记顺序；`user-texture` 这种按属性名全场去重的不在这里，在 `FragmentDelta.bindings` */
  bindings: SceneBinding[];
  /** 定型后的脚本条目：材质常量目标已补 uniforms / members，动画层字段脚本已按 `animationLayerDefs` 过滤 */
  scripts: SceneScript[];
  /** 关键帧；`parent` 是片段内的下标 */
  animations: SceneAnimation[];
  sound?: SceneSound;
  /** 灯；`legacySlot` 为 -1，由 L3 的登记表按「排在最后取第一个空槽」分配 */
  light?: SceneLightObject;
  /** 反射名单用：场景平面反射开着、`reflected` 不为 false、自己不是读反射图的模型 */
  reflected: boolean;
  /** 会翻转场景级不变量的原因（`effect-access`、`reflection:planar`、`mip-framebuffer`、`lights`、`legacy-lights`、`volumetrics`）；非空时宿主整场重载 */
  sceneFlips: string[];
  /** 只会从假变真、宿主可以运行中补订阅的场景位 */
  audio: boolean;
  media: boolean;
  /** 这个对象带来的不支持项（排序）；`fragmentOf` 取不到，给 [] */
  unsupported: string[];
}

/** 随片段发给主线程的场景级新表项：都只增，`from` 是第一项的下标。 */
export interface FragmentDelta {
  fragment: ObjectFragment;
  programs: { from: number; list: TranslateResult[] };
  textures: { from: number; list: SceneTexture[] };
  userTextures: { from: number; list: UserTextureSource[] };
  /** 场景级绑定（`user-texture`，第一次出现的属性） */
  bindings: SceneBinding[];
  /** 新出现的、在 WPE assets 里存在的脚本资源路径 */
  assetPaths: string[];
}

// ———— 遍历辅助 ————

/** 普通对象（原型是 `Object.prototype` 或 null）：类型化数组、Map、Set 等不算，遍历与改键都原样共用。 */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 图层里全部的 `ScenePass`（基础 / effect / passthrough / 组上屏 / 粒子 / 文本 / 模型网格 / puppet 等任何位置）：有 `key` 字符串与 `uniforms` 的普通对象。 */
export function layerPasses(layer: SceneLayer): ScenePass[] {
  const out: ScenePass[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isPlain(value)) return;
    if (typeof value.key === "string" && "program" in value && "uniforms" in value)
      out.push(value as unknown as ScenePass);
    for (const item of Object.values(value)) visit(item);
  };
  visit(layer);
  return out;
}

/** 这个图层读音频：粒子用音频模块，或任一 pass 的程序读音频频谱 uniform（`bundle.audio` 的逐对象版，不含 `project.json` 的开关）。 */
export function layerUsesAudio(layer: SceneLayer, programs: readonly TranslateResult[]): boolean {
  if (layer.particle !== null && layer.particle !== undefined && particleUsesAudio(layer.particle)) return true;
  return layerPasses(layer).some((pass) => pass.program !== null && readsAudioUniforms(programs[pass.program]));
}

/** 这个图层或它的脚本用媒体集成：有 system 来源的用户纹理槽（封面），或会执行的脚本导出五个媒体回调之一（`bundle.media` 的逐对象版）。 */
export function layerUsesMedia(layer: SceneLayer, scripts: readonly SceneScript[]): boolean {
  return (
    layerPasses(layer).some((pass) => (pass.userTextures ?? []).some((slot) => slot.source.kind === "system")) ||
    scripts.some((script) => !script.errors.length && exportsMediaCallback(script.source))
  );
}

/** 绑定属于这个对象：目标里的 `object` 是它，或 `pass` / `path` / `script` 以 `objects/<i>/` 开头。 */
export function bindingOwnedBy(binding: SceneBinding, object: number): boolean {
  const target = binding.target as unknown as Record<string, unknown>;
  if (typeof target.object === "number") return target.object === object;
  const prefix = `objects/${object}/`;
  for (const key of ["pass", "path", "script"])
    if (typeof target[key] === "string" && (target[key] as string).startsWith(prefix)) return true;
  return false;
}

// ———— 取片段 ————

/** 取不了片段的原因；null 表示能取。 */
export function fragmentBlocker(bundle: SceneBundle, object: number): string | null {
  const layer = bundle.layers.find((item) => item.object === object);
  if (!layer) return "missing";
  // 克隆不被依赖（名字表只含加载时的对象），计划不同（盘点 §7.3）
  if (layer.dependedOn) return "depended";
  // HDR 下 `TEX<n>FORMAT` 按 `entry.object < owner` 定，随下标变（盘点 §1.2）
  if (
    bundle.general.postprocess.hdr &&
    layerPasses(layer).some((pass) => Object.keys(pass.layerComposites ?? {}).length > 0)
  )
    return "hdr-layer-composites";
  return null;
}

/**
 * 从整场 bundle 里取一个对象的片段（不做 {@link fragmentBlocker} 检查，L3a：登记表的逐个加对照要取全部对象）。各表按「属于这个对象」过滤：图层按
 * `object`，绑定按 {@link bindingOwnedBy}，脚本与关键帧按 `objects/<i>/` 前缀的 id（关键帧的 `parent` 换成片段内下标），声音、灯按 `object`。
 * 位置相关的字段清成和 `compileFragment` 相同的空值（`group` / `subtree` / `attachment` / 灯的 `legacySlot`）；
 * `groupUpload` 原样保留。`reflected` 取 `bundle.reflection?.list` 是否含它；`unsupported`、`sceneFlips` 为 []；`audio`、`media` 现算（同
 * `compileFragment`）。对象不在 `bundle.layers` 里返回 null。
 */
export function objectSlice(bundle: SceneBundle, object: number): ObjectFragment | null {
  const source = bundle.layers.find((item) => item.object === object);
  if (!source) return null;
  const layer: SceneLayer = {
    ...source,
    group: null,
    subtree: [],
  };
  delete layer.attachment;
  const prefix = `objects/${object}/`;
  const scripts = bundle.scripts.list.filter((script) => script.id.startsWith(prefix));
  // 关键帧：登记顺序里属于这个对象的那些，`parent` 从 `bundle.animations` 下标换成片段内下标
  const all = bundle.animations ?? [];
  const positions = new Map<number, number>();
  all.forEach((animation, index) => {
    if (animation.object === object) positions.set(index, positions.size);
  });
  const animations = all
    .filter((animation) => animation.object === object)
    .map((animation) => ({
      ...animation,
      parent: animation.parent === null ? null : (positions.get(animation.parent) ?? null),
    }));
  const light = bundle.lightObjects?.find((item) => item.object === object);
  const sound = bundle.sounds?.find((item) => item.object === object);
  return {
    object,
    config: bundle.configs?.[object] ?? "",
    layer,
    bindings: bundle.bindings.filter((binding) => bindingOwnedBy(binding, object)),
    scripts,
    animations,
    ...(sound ? { sound } : {}),
    ...(light ? { light: { ...light, legacySlot: -1 } } : {}),
    reflected: bundle.reflection?.list?.includes(object) ?? false,
    sceneFlips: [],
    // `bundle.audio` 为假时（没声明 `supportsaudioprocessing`）这个对象一定也是假
    audio: bundle.audio === true && layerUsesAudio(layer, bundle.programs),
    media: layerUsesMedia(layer, scripts),
    unsupported: [],
  };
}

/**
 * 从整场 bundle 里取一个对象的片段（克隆模板用）：有 {@link fragmentBlocker} 时返回 null，否则同 {@link objectSlice}。
 */
export function fragmentOf(bundle: SceneBundle, object: number): ObjectFragment | null {
  if (fragmentBlocker(bundle, object) !== null) return null;
  return objectSlice(bundle, object);
}

// ———— 改键 ————

/** 把字符串里的 `objects/<from>` 前缀换成 `objects/<to>`（只认前缀，且后面是 `/` 或到尾：关键帧的属主路径是 `objects/3`，下一个字符不能是数字）。 */
function rekeyString(value: string, from: string, to: string): string {
  return value.startsWith(from) && (value.length === from.length || value[from.length] === "/")
    ? to + value.slice(from.length)
    : value;
}

/** 深度改键：字符串换前缀，普通对象与数组递归（返回新对象），其余（类型化数组、Map、Set、数字）原样。 */
function rekeyValue<T>(value: T, from: string, to: string): T {
  if (typeof value === "string") return rekeyString(value, from, to) as T;
  if (Array.isArray(value)) return value.map((item) => rekeyValue(item, from, to)) as T;
  if (isPlain(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = rekeyValue(value[key], from, to);
    return out as T;
  }
  return value;
}

/** 目标里的 `object` 等于旧下标就换（animation-layer 目标的 `layer` 是动画层 id，不动）。 */
function rekeyTarget<T extends BindingTarget | SceneScript["target"]>(target: T, from: number, to: number): T {
  const record = target as unknown as Record<string, unknown>;
  return record.object === from ? ({ ...record, object: to } as unknown as T) : target;
}

function rekeyScript(script: SceneScript, from: string, to: string, fromObject: number, toObject: number): SceneScript {
  const out = rekeyValue(script, from, to);
  out.target = rekeyTarget(out.target, fromObject, toObject);
  if (out.layer === fromObject) out.layer = toObject;
  const owner = out.owner;
  if (owner.kind === "layer" || owner.kind === "animation-layer" || owner.kind === "effect") {
    if (owner.object === fromObject) out.owner = { ...owner, object: toObject };
  } else if (owner.kind === "material" && owner.layer === fromObject) {
    out.owner = { ...owner, layer: toObject };
  }
  return out;
}

/**
 * 改键（克隆）。规则见文件头：`objects/<from>/` 前缀换成 `objects/<to>/`，数字下标等于旧下标时换，`id` 换成新 id，`parent` 取新父；
 * 位置相关的字段保持空值。只读入参、返回新对象（类型化数组等非普通对象原样共用）。
 */
export function rekeyFragment(
  fragment: ObjectFragment,
  to: { object: number; id: number; parent: number | null },
): ObjectFragment {
  const fromObject = fragment.object;
  const from = `objects/${fromObject}`;
  const next = `objects/${to.object}`;
  const layer = rekeyValue(fragment.layer, from, next);
  layer.object = to.object;
  layer.id = to.id;
  layer.parent = to.parent;
  const object = <T extends { object: number }>(item: T): T => rekeyValue({ ...item, object: to.object }, from, next);
  return {
    ...fragment,
    object: to.object,
    layer,
    bindings: fragment.bindings.map((binding) => {
      const out = rekeyValue(binding, from, next);
      out.target = rekeyTarget(out.target, fromObject, to.object);
      return out;
    }),
    scripts: fragment.scripts.map((script) => rekeyScript(script, from, next, fromObject, to.object)),
    animations: fragment.animations.map((animation) => {
      const out = rekeyValue(animation, from, next);
      out.target = rekeyTarget(out.target, fromObject, to.object);
      if (out.object === fromObject) out.object = to.object;
      return out;
    }),
    ...(fragment.sound ? { sound: object(fragment.sound) } : {}),
    ...(fragment.light ? { light: object(fragment.light) } : {}),
    sceneFlips: [...fragment.sceneFlips],
    unsupported: [...fragment.unsupported],
  };
}
