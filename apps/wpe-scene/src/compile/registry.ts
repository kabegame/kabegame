/**
 * 登记表（活的场景图 L3a，`.claude/plans/wpe-import/3-scene/live/phase-l3a-registry-state.md`）：宿主手里那份活的 bundle 的增删入口。
 *
 * 加载时「bundle → 状态」是一次性的（`SceneState.fromBundle`），组、子树、挂点在编译收尾里定死。运行中增删对象要走同样的路，所以这里把
 * 「一个对象的全部条目」（图层、对象级绑定、脚本、关键帧、声音、灯、配置原文、反射名单、粒子序号）与「场景级只增表」（程序、纹理、用户纹理来源、
 * 场景级绑定、资源路径）的增删收成一处。登记表改的就是 `bundle` 自己的数组，消费者照旧读 `bundle.layers` 等「现读」的表，自动接上。
 *
 * 判据是「从空开始逐个加」等于「整场一次」（`ignore/live/l3/registry.test.ts` 在全语料上比）：{@link SceneRegistry.emptyOf} 取整场 bundle 的场景级
 * 部分，按 `objects` 顺序 `addObject` 每个对象的切片（`fragment.ts` 的 `objectSlice`），再 {@link SceneRegistry.restructure} 一次。
 *
 * **位置相关的量不进片段**（组归属、子树、挂点、灯的遗留槽位）：灯槽由 `addObject` 现分配，组与挂点由 `restructure` 按状态里运行中的父与子表重算。
 */
import type { SceneAnimation } from "../animation/types";
import type { SceneState } from "../render/state";
import type { SceneBinding } from "./bindings";
import { applyAttachments, applyGroupRules, type SceneBundle, type SceneLayer } from "./bundle";
import type { FragmentDelta, ObjectFragment } from "./fragment";
import type { SceneScript } from "./scripts";

/**
 * 遗留灯的槽数（同 `lights.ts` 的 `LEGACY_SLOTS`，那边没有导出；`registry.test.ts` 用 `compileLightObjects` 核对两边的分配规则一致）。
 */
const LEGACY_LIGHT_SLOTS = 4;

/** `objects/<i>/…` 的 `i`（字符串不是这个形状时 null）。 */
function objectOfPath(path: unknown): number | null {
  if (typeof path !== "string") return null;
  const match = /^objects\/(\d+)\//.exec(path);
  return match ? Number(match[1]) : null;
}

/**
 * 绑定属于哪个对象：目标里有数字 `object` 取它，否则取 `pass` / `path` / `script` 里第一个 `objects/<i>/` 前缀的 `i`；都没有（泛光、`general`、
 * 场景级的 `user-texture` 等）为 null。和 `fragment.ts` 的 `bindingOwnedBy` 同一规则的反向（那边是「是否属于某个对象」）。
 */
export function bindingOwner(binding: SceneBinding): number | null {
  const target = binding.target as unknown as Record<string, unknown>;
  if (typeof target.object === "number") return target.object;
  for (const key of ["pass", "path", "script"]) {
    const owner = objectOfPath(target[key]);
    if (owner !== null) return owner;
  }
  return null;
}

/** 脚本属于哪个对象：id 是 `objects/<i>/…`；`general` 的脚本为 null。 */
export function scriptOwner(script: SceneScript): number | null {
  return objectOfPath(script.id);
}

/** 原地只留满足条件的项（数组本身不换：消费者可能持有它）。 */
function retain<T>(list: T[], keep: (item: T) => boolean): void {
  let write = 0;
  for (let read = 0; read < list.length; read++) if (keep(list[read])) list[write++] = list[read];
  list.length = write;
}

/**
 * 对象的条目在一张按所属对象排序的表里的插入位置：第一个所属对象大于 `object` 的项之前，没有就是表尾（场景级的项 `owner` 为 null，不参与）。
 * 整场编译按 `objects` 顺序登记这些表（脚本 / 关键帧的更新顺序、声音 / 灯的顺序都靠它），所以替换中间的对象时条目要插回原来的位置，不能追加。
 */
function orderedPosition<T>(list: readonly T[], object: number, ownerOf: (item: T) => number | null): number {
  const at = list.findIndex((item) => {
    const owner = ownerOf(item);
    return owner !== null && owner > object;
  });
  return at < 0 ? list.length : at;
}

/**
 * 原地只留满足条件的关键帧并把联动的 `parent`（表内下标）换成新表里的下标。联动的父与子同属一个对象（`collectObjectAnimations`），所以
 * 按对象整体保留 / 删除时父总是跟着子；父不在保留集里（理论上不会）时置 null。
 */
function retainAnimations(list: SceneAnimation[], keep: (animation: SceneAnimation) => boolean): void {
  const positions = new Map<number, number>();
  list.forEach((animation, index) => {
    if (keep(animation)) positions.set(index, positions.size);
  });
  retain(list, keep);
  for (const animation of list)
    animation.parent = animation.parent === null ? null : (positions.get(animation.parent) ?? null);
}

/** 宿主手里那份活的 bundle 的增删入口（L3a）。改的就是 bundle 自己的数组，现读的消费者自动接上。 */
export class SceneRegistry {
  private revision = 0;
  /** 粒子序号：对象 → 第几个粒子图层（按加进来的先后，删掉的不回收），`createParticleTree` 定随机种子用 */
  private readonly ordinals = new Map<number, number>();
  private nextOrdinal = 0;
  private cameraCache: { revision: number; list: SceneLayer[] } | null = null;

  constructor(readonly bundle: SceneBundle) {
    for (const layer of bundle.layers) if (layer.particle) this.ordinals.set(layer.object, this.nextOrdinal++);
  }

  /** 增删改一次加一 */
  get version(): number {
    return this.revision;
  }

  /**
   * 整场 bundle 去掉全部对象条目（图层、对象级绑定、脚本、关键帧、声音、灯、对象的配置原文、反射名单、子表）后的空登记表：对照测试与 L4 的
   * `populate` 用。场景级的表与位（程序、纹理、泛光、灯光计数、`unsupported`、`audio` / `media` 等）原样带上；会被增删改动的数组都拷一份，
   * 不动传入的 bundle。不属于任何图层的绑定 / 脚本 / 关键帧 / 声音 / 灯（场景级，或对象没有图层）保留。
   */
  static emptyOf(bundle: SceneBundle): SceneRegistry {
    const layered = new Set(bundle.layers.map((layer) => layer.object));
    const keepOwner = (owner: number | null): boolean => owner === null || !layered.has(owner);
    const out: SceneBundle = {
      ...bundle,
      layers: [],
      programs: [...bundle.programs],
      textures: [...bundle.textures],
      bindings: bundle.bindings.filter((binding) => keepOwner(bindingOwner(binding))),
      scripts: { ...bundle.scripts, list: bundle.scripts.list.filter((script) => keepOwner(scriptOwner(script))) },
    };
    if (bundle.userTextures) out.userTextures = [...bundle.userTextures];
    if (bundle.animations) {
      out.animations = bundle.animations.map((animation) => ({ ...animation }));
      retainAnimations(out.animations, (item) => keepOwner(item.object));
    }
    if (bundle.sounds) out.sounds = bundle.sounds.filter((sound) => !layered.has(sound.object));
    const lights = bundle.lightObjects?.filter((light) => !layered.has(light.object));
    if (lights?.length) out.lightObjects = lights;
    else delete out.lightObjects;
    if (bundle.configs) out.configs = bundle.configs.map((config, object) => (layered.has(object) ? null : config));
    if (bundle.children) out.children = [];
    if (bundle.reflection) out.reflection = { ...bundle.reflection, ...(bundle.reflection.list ? { list: [] } : {}) };
    return new SceneRegistry(out);
  }

  /** 场景级只增表：`from` 必须等于当前长度，否则抛错（增量错位说明会话与主线程不同步）。 */
  applyDelta(delta: Omit<FragmentDelta, "fragment">): void {
    const { bundle } = this;
    const userTextures = (bundle.userTextures ??= []);
    for (const [name, table, part] of [
      ["programs", bundle.programs, delta.programs],
      ["textures", bundle.textures, delta.textures],
      ["userTextures", userTextures, delta.userTextures],
    ] as const)
      if (part.from !== table.length) throw new Error(`增量错位：${name} 从 ${part.from} 起，现有 ${table.length} 项`);
    bundle.programs.push(...delta.programs.list);
    bundle.textures.push(...delta.textures.list);
    userTextures.push(...delta.userTextures.list);
    bundle.bindings.push(...delta.bindings);
    this.revision++;
  }

  /** 空闲的灯槽：现有灯占用的槽之外取第一个，满了取 0（同 `compileLightObjects`）。 */
  private freeLightSlot(): number {
    const taken = new Array<boolean>(LEGACY_LIGHT_SLOTS).fill(false);
    for (const light of this.bundle.lightObjects ?? [])
      if (light.legacySlot >= 0 && light.legacySlot < LEGACY_LIGHT_SLOTS) taken[light.legacySlot] = true;
    const free = taken.indexOf(false);
    return free < 0 ? 0 : free;
  }

  /**
   * 加一个对象的全部条目。图层默认追加在 `bundle.layers` 尾（`at` 给了就插到那个位置）；绑定、脚本、关键帧、声音、灯插在各表里按所属对象排序的位置（加新对象时就是表尾），灯的 `legacySlot`
   * 现分配（`slot` 给了就用它）；关键帧的 `parent` 从片段内下标换成表内下标；`configs[object]` 写入；反射开着且片段 `reflected` 时进名单；有粒子的
   * 图层领下一个粒子序号。片段的 `audio` / `media` 为真时把场景位置真（只会从假变真）。对象已在时抛错。
   */
  private insert(fragment: ObjectFragment, options: { at?: number; slot?: number; ordinal?: number } = {}): void {
    const { bundle } = this;
    const object = fragment.object;
    if (bundle.layers.some((layer) => layer.object === object)) throw new Error(`对象 ${object} 已在登记表里`);
    if (options.at === undefined) bundle.layers.push(fragment.layer);
    else bundle.layers.splice(options.at, 0, fragment.layer);
    bundle.bindings.splice(orderedPosition(bundle.bindings, object, bindingOwner), 0, ...fragment.bindings);
    bundle.scripts.list.splice(orderedPosition(bundle.scripts.list, object, scriptOwner), 0, ...fragment.scripts);
    // 关键帧：插到位置 `at`，片段内的 `parent` 加 `at`，原表里指向 `at` 及之后的联动父跟着后移
    const animations = (bundle.animations ??= []);
    if (fragment.animations.length > 0) {
      const at = orderedPosition(animations, object, (item) => item.object);
      for (const animation of animations)
        if (animation.parent !== null && animation.parent >= at) animation.parent += fragment.animations.length;
      animations.splice(
        at,
        0,
        ...fragment.animations.map((animation) => ({
          ...animation,
          parent: animation.parent === null ? null : animation.parent + at,
        })),
      );
    }
    if (fragment.sound) {
      const sounds = (bundle.sounds ??= []);
      sounds.splice(
        orderedPosition(sounds, object, (item) => item.object),
        0,
        fragment.sound,
      );
    }
    if (fragment.light) {
      const lights = (bundle.lightObjects ??= []);
      lights.splice(
        orderedPosition(lights, object, (item) => item.object),
        0,
        {
          ...fragment.light,
          legacySlot: options.slot ?? this.freeLightSlot(),
        },
      );
    }
    const configs = (bundle.configs ??= []);
    while (configs.length <= object) configs.push(null);
    if (fragment.config !== "") configs[object] = fragment.config;
    if (fragment.reflected && bundle.reflection?.enabled === true) {
      const list = (bundle.reflection.list ??= []);
      list.push(object);
      list.sort((a, b) => a - b);
    }
    if (fragment.layer.particle) this.ordinals.set(object, options.ordinal ?? this.nextOrdinal++);
    if (fragment.audio) bundle.audio = true;
    if (fragment.media) bundle.media = true;
    this.cameraCache = null;
    this.revision++;
  }

  addObject(fragment: ObjectFragment): void {
    this.insert(fragment);
  }

  /**
   * 删掉一个对象的全部条目：图层、对象级绑定、脚本、关键帧（联动的 `parent` 重排下标）、声音、灯（槽空出来，下一盏新灯取最小的空槽）、反射名单里的项、
   * 粒子序号（序号不回收）。`configs` 保留（已删对象的 `getInitialLayerConfig` 由 API 层拦）。不在时返回 false。
   */
  removeObject(object: number): boolean {
    const { bundle } = this;
    const at = bundle.layers.findIndex((layer) => layer.object === object);
    if (at < 0) return false;
    this.take(object);
    this.revision++;
    return true;
  }

  /** 摘掉一个对象的全部条目（不动版本号）。 */
  private take(object: number): void {
    const { bundle } = this;
    const at = bundle.layers.findIndex((layer) => layer.object === object);
    if (at >= 0) bundle.layers.splice(at, 1);
    retain(bundle.bindings, (binding) => bindingOwner(binding) !== object);
    retain(bundle.scripts.list, (script) => scriptOwner(script) !== object);
    if (bundle.animations) retainAnimations(bundle.animations, (item) => item.object !== object);
    if (bundle.sounds) retain(bundle.sounds, (sound) => sound.object !== object);
    if (bundle.lightObjects) {
      retain(bundle.lightObjects, (light) => light.object !== object);
      if (bundle.lightObjects.length === 0) delete bundle.lightObjects;
    }
    if (bundle.reflection?.list) retain(bundle.reflection.list, (item) => item !== object);
    this.ordinals.delete(object);
    this.cameraCache = null;
  }

  /**
   * 换成新编的同一对象：图层留在 `bundle.layers` 的原位置（下标不变），其余表先摘再插回按所属对象排序的位置（脚本 / 关键帧的更新顺序不变；子计划写的是「追加」），灯沿用原来的槽、粒子沿用原来的序号。
   * 对象不在时抛错。
   */
  replaceObject(fragment: ObjectFragment): void {
    const { bundle } = this;
    const object = fragment.object;
    const at = bundle.layers.findIndex((layer) => layer.object === object);
    if (at < 0) throw new Error(`对象 ${object} 不在登记表里`);
    const slot = bundle.lightObjects?.find((light) => light.object === object)?.legacySlot;
    const ordinal = this.ordinals.get(object);
    this.take(object);
    this.insert(fragment, {
      at,
      ...(slot !== undefined && slot >= 0 ? { slot } : {}),
      ...(ordinal !== undefined ? { ordinal } : {}),
    });
  }

  /** 反射名单（`objects` 下标，按 `objects` 顺序）；场景没开平面反射时 null。名单在 `addObject` / `removeObject` 里随片段的 `reflected` 维护。 */
  reflectionList(): readonly number[] | null {
    const reflection = this.bundle.reflection;
    return reflection?.planar && reflection.enabled ? (reflection.list ?? []) : null;
  }

  /** 粒子序号（加进来的先后，删掉的不回收）；不是粒子图层 / 不在表里为 0（同 `GpuScene` 的 `?? 0`）。 */
  particleOrdinal(object: number): number {
    return this.ordinals.get(object) ?? 0;
  }

  /** 相机图层（同 `cameraObjectLayers`），按版本缓存。 */
  cameraLayers(): SceneLayer[] {
    if (this.cameraCache?.revision !== this.revision)
      this.cameraCache = { revision: this.revision, list: this.bundle.layers.filter((layer) => !!layer.camera) };
    return this.cameraCache.list;
  }

  /**
   * 组与挂点的运行时重算：
   * 1. 图层 `parent` 同步成状态里运行中的父（状态里没有的图层不动）；
   * 2. `bundle.children` 按状态的子表重写（只含进了登记表的对象，按图层顺序排父），`assignGroups` 按它写回每个图层的 `group` / `subtree`；
   * 3. `attachment` 按当前的父与 `bones(object)`（当前挂点骨骼名；`override` 为真时允许父排在后面，同 `structure.parents`）重算；
   * 4. 把图层 effect 的「带不支持项」同步进状态的 effect 开关表（`syncEffectSupport`，`needsRecompile` 读它；不动 `enabled`）。
   * 返回（L7）：`issues` 是组内用法的不支持项（对象 → 键，`groupChildIssues`；整场 `unsupported` 里 `model:passthrough:children:*` 就是它们的并集），
   * `changed` 是派生量变了的图层（重算前后逐个比 {@link structureKey}；之前不在登记表里的也算）。只有 `parent` 变了而派生量没变的（顶层之间换父）
   * 不算：渲染器读状态里的父，不用重排。调用方（宿主、dev 探针）把它交给渲染器当帧重排，`issues` 按「那个对象不画」处理。
   */
  restructure(
    state: Pick<SceneState, "layers" | "childrenOf" | "syncEffectSupport">,
    bones: (object: number) => { name: string | null; override: boolean },
  ): RestructureResult {
    const { bundle } = this;
    const layers = bundle.layers;
    const before = structureKeys(layers);
    for (const layer of layers) {
      const live = state.layers.get(layer.object);
      if (live) layer.parent = live.parent;
    }
    const present = new Set(layers.map((layer) => layer.object));
    const children = new Map<number, number[]>();
    for (const layer of layers) {
      const list = state.childrenOf(layer.object).filter((child) => present.has(child));
      if (list.length > 0) children.set(layer.object, list);
    }
    bundle.children = [...children].map(([parent, list]) => [parent, [...list]]);
    applyAttachments(layers, (layer) => bones(layer.object));
    const issues = applyGroupRules(layers, children);
    for (const layer of layers) if (state.layers.has(layer.object)) state.syncEffectSupport(layer);
    this.cameraCache = null;
    this.revision++;
    const changed = new Set<number>();
    for (const [object, key] of structureKeys(layers)) if (before.get(object) !== key) changed.add(object);
    return { changed, issues };
  }
}

/** `SceneRegistry.restructure` 的结果（L7）。 */
export interface RestructureResult {
  /** 派生量（组、组的层数、子树、挂点、直接父是不是组）变了的图层，含之前不在登记表里的；渲染器对这些图层当帧重排。 */
  changed: Set<number>;
  /** 组内用法的不支持项（对象 → 键，`groupChildIssues`）：全部在组里的图层的，不只是变了的。 */
  issues: Map<number, string[]>;
}

/**
 * 一个图层的位置相关派生量（L7，`restructure` 前后比较用）：替它作画的组、组的层数（嵌套组换了归属时，组里的子孙 `group` 不变、层数变了，合成 RT
 * 要换按层数分开的池）、子树、挂点（父 + 骨骼）、直接父是不是组（P5f：层首拷贝只看直接父，组内换到分组节点下面时组归属不变、拷贝变了）。
 */
function structureKey(layer: SceneLayer, byObject: ReadonlyMap<number, SceneLayer>): string {
  let depth = 0;
  const seen = new Set<number>();
  for (let group = layer.group ?? null; group !== null && !seen.has(group); depth++) {
    seen.add(group);
    group = byObject.get(group)?.group ?? null;
  }
  const directGroupChild = layer.group != null && layer.parent === layer.group;
  const attachment = layer.attachment ? [layer.attachment.parent, layer.attachment.bone] : null;
  return JSON.stringify([layer.group ?? null, depth, layer.subtree ?? [], attachment, directGroupChild]);
}

/** 全部图层的 {@link structureKey}（对象 → 键）。 */
function structureKeys(layers: readonly SceneLayer[]): Map<number, string> {
  const byObject = new Map(layers.map((layer) => [layer.object, layer]));
  return new Map(layers.map((layer) => [layer.object, structureKey(layer, byObject)]));
}
