/**
 * 运行中建层的两条路（活的场景图 L5，`.claude/plans/wpe-import/3-scene/live/phase-l5-create-layer.md` 点 3、点 6）：宿主与 dev 探针共用这一份，
 * 各自只实现「接进场景」的那一侧（{@link LiveTarget}：登记表、状态、子系统、GPU）。
 *
 * `createLayer` 已经照 P6d3b 建好了壳（状态里有、登记表里没有），然后调 {@link LiveObjects.create}：
 * - **命中**片段缓存（键是规整配置）：`rekeyFragment` 改成新下标、新 id、新父 → `adopt`（登记表加、状态的壳换成编好的、子系统、绑定按当前属性重写、
 *   脚本）→ GPU：`prepareSync` + `install`（同步备不好、文本层还没排版时异步备，排 `install`）。都在 `createLayer` 返回之前做完，之后 `addScripts`
 *   跑新对象的 `init`，读到的已经是编好的状态。
 * - **没命中**：排 `create`，会话异步编；片段到达时场景级增量进登记表、在 GPU 上预热，下一帧开头（`drain`）`adopt`（脚本写入按对象重放）→ GPU →
 *   片段进缓存。到达前对象已删：只进缓存。
 *
 * 运行中出现的不支持项（片段的 `unsupported` 非空）：不装 GPU（不画），其余照装，`unsupported` 上报，记 `stats.unsupported`；场景不退回。
 * 片段带 `sceneFlips`、编片段失败、装 GPU 出错：`reload`（整场重载；结构里照记新建对象，重载后照样在）。
 */
import { planApply, type UserProperty } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { rekeyFragment, type FragmentDelta, type FragmentRequest, type ObjectFragment } from "../compile/fragment";
import type { SceneScalar } from "../compile/model";
import type { SceneStructure } from "../compile/protocol";
import type { SceneState } from "../render/state";
import { SceneChangeQueue, type CreateChange, type SceneChange } from "../changes";
import { FragmentCache, fragmentKey } from "../fragmentCache";
import { targetKey, type ScriptTarget } from "./runtime";

/**
 * 接进场景时这个对象的绑定按当前属性全集重写（L5，宿主与探针共用）：缓存里的片段（以及到达前属性又变了的片段）是按编它那一刻的属性编的初值。规则同
 * 编译期：不挂脚本的目标写属性值，挂脚本的目标留给脚本（编译期给它 JSON `value`）；`needsRecompile` 挡下的不写。返回写了的条数。
 */
export function rebindFragment(
  state: Pick<SceneState, "needsRecompile" | "write">,
  fragment: Pick<ObjectFragment, "bindings" | "scripts">,
  properties: ReadonlyMap<string, UserProperty>,
): number {
  if (fragment.bindings.length === 0 || properties.size === 0) return 0;
  const scripted = new Set(fragment.scripts.map((script) => targetKey(script.target as ScriptTarget)));
  const changes = new Map<string, SceneScalar>();
  for (const [key, property] of properties) changes.set(key, property.value as SceneScalar);
  let count = 0;
  for (const { binding, value } of planApply(fragment.bindings, changes).writes) {
    if (scripted.has(targetKey(binding.target as ScriptTarget))) continue;
    if (state.needsRecompile(binding, value)) continue;
    state.write(binding, value);
    count++;
  }
  return count;
}

/**
 * 登记表 `restructure` 的骨骼回调（宿主与探针共用）：当前挂点骨骼名取配置原文的 `attachment`，`override`（允许父排在后面）取 `structure.parents`
 * 是否带这个对象。
 */
export function configBone(
  bundle: Pick<SceneBundle, "configs">,
  structure: Pick<SceneStructure, "parents">,
  object: number,
): { name: string | null; override: boolean } {
  let name: string | null = null;
  const text = bundle.configs?.[object];
  if (typeof text === "string") {
    try {
      const attachment = (JSON.parse(text) as { attachment?: unknown }).attachment;
      if (typeof attachment === "string") name = attachment;
    } catch {
      // 配置原文总是合法 JSON；万一不是就当没有挂点
    }
  }
  return { name, override: structure.parents.some(([item]) => item === object) };
}

/** 运行中建层的计数（`SceneHostStats.created`）：`sync` 在 `createLayer` 返回前装完 GPU 的，`async` 之后才装上的，`unsupported` 带不支持项、没装 GPU 的。 */
export interface LiveCreateStats {
  sync: number;
  async: number;
  unsupported: number;
}

/** 接进场景的那一侧（宿主 / 探针各一份）。`P` 是备好的 GPU 对象。 */
export interface LiveTarget<P> {
  /** 对象还在场景里（状态里有、没删掉）：片段到达、异步备好时判断要不要装 */
  alive(object: number): boolean;
  /** 片段到达（按先后，同步）：场景级增量进登记表；抛错时这一项按编片段失败处理 */
  applyDelta(delta: FragmentDelta): void;
  /**
   * 非 GPU 部分（宿主：`addCompiledObject`）：登记表（没有时加、有时换）→ 状态（壳换成编好的）→ 组与挂点 → 绑定按当前属性重写 → 子系统 → 脚本
   * （定型的条目、重放这个对象建出以来的写入）。`delta` 的场景级部分已在到达时进了登记表，这里只登记用户纹理来源等宿主侧的表。
   * 返回要等的异步部分（文本排版、用户纹理解码）。
   */
  adopt(input: FragmentDelta | { fragment: ObjectFragment }): Promise<void>;
  /** 有没有 GPU 场景（首次加载 `init` 期间没有：建场景时从 bundle 一起建） */
  gpu(): boolean;
  /** 同步备好（缺程序、缺 A2C 管线时 null）；出错抛 */
  prepareSync(layer: SceneLayer): P | null;
  /** 异步备好；出错 reject */
  prepare(layer: SceneLayer): Promise<P>;
  /** 在帧边界装上；出错抛 */
  install(prepared: P): void;
  discard(prepared: P): void;
  /** 片段到达后的预热：备一次再放弃，程序与管线进场景的缓存（不碰正在画的）。没有 GPU 场景时什么都不做 */
  warm(layer: SceneLayer): Promise<void>;
  /** 运行中出现的不支持项（这个对象不画） */
  unsupported(object: number, keys: readonly string[]): void;
  /** 整场重载 */
  reload(reason: string): void;
  /** 编片段的请求要的当前属性全集（裸值） */
  properties(): Record<string, unknown>;
}

/** 配置原文里的 `id`（`createLayer` 写进去的）；没有或不是数字时 null。 */
function configId(config: string): number | null {
  try {
    const id = (JSON.parse(config) as { id?: unknown }).id;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** 挂点骨骼名：配置里的 `attachment`（字符串）且有父时才算（同会话 `compileFragment` 的规则）。 */
function boneOf(config: string, parent: number | null): string | null {
  if (parent === null) return null;
  try {
    const attachment = (JSON.parse(config) as { attachment?: unknown }).attachment;
    return typeof attachment === "string" ? attachment : null;
  } catch {
    return null;
  }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * 进缓存的那一份：图层浅拷一层。装入后登记表的 `restructure` 会改图层的 `parent` / `group` / `subtree` / `attachment`、换 `effects` 数组（不改里面的对象），
 * 缓存里的要保持「和位置无关」的样子（`fragment.ts` 文件头）。
 */
export function cacheCopy(fragment: ObjectFragment): ObjectFragment {
  return { ...fragment, layer: { ...fragment.layer } };
}

/** 排进队列的异步 GPU 对象：备的那一层与备好的对象。 */
interface PendingInstall<P> {
  layer: SceneLayer;
  prepared: P;
}

/** 一个场景（一个会话、一份登记表）的运行中建层：片段缓存 + 变更队列 + 两条路。换场景时 `dispose`，新场景另建一个。 */
export class LiveObjects<P> {
  readonly queue: SceneChangeQueue;
  private disposed = false;

  constructor(
    private readonly target: LiveTarget<P>,
    /** 向会话要片段（宿主：`CompileSessionClient.compileFragment`） */
    compile: (request: FragmentRequest) => Promise<FragmentDelta>,
    readonly stats: LiveCreateStats = { sync: 0, async: 0, unsupported: 0 },
    /** 片段缓存（属于同一个会话）；缺省新建。探针的 `prewarmFragments` 交来预跑时编好的 */
    readonly cache: FragmentCache = new FragmentCache(),
  ) {
    this.queue = new SceneChangeQueue({
      compile: (change) => compile(this.request(change)),
      arrive: (_change, delta) => this.target.applyDelta(delta),
      warm: async (change, delta) => {
        // 不装的不预热：带不支持项、带 sceneFlips、到达前已删的
        const { fragment } = delta;
        if (fragment.unsupported.length || fragment.sceneFlips.length || !this.target.alive(change.object)) return;
        if (this.target.gpu()) await this.target.warm(fragment.layer);
      },
    });
  }

  /** 会话的片段请求：配置原文、运行中的父与挂点、当前属性全集（发请求那一刻的）。 */
  request(change: CreateChange): FragmentRequest {
    return {
      object: change.object,
      config: change.config,
      parent: change.parent,
      bone: change.bone,
      properties: this.target.properties(),
    };
  }

  /**
   * `createLayer` 建好壳之后调（`object` 是壳的下标、`config` 是带 `id` 的配置原文、`parent` 是壳的父）。命中缓存时当场接进场景（GPU 能同步备好就
   * 当场装），返回 `"sync"`（GPU 也装了）、`"pending"`（GPU 排了异步）、`"unsupported"`（不装 GPU）或 `"reload"`（出错，已请求整场重载）；没命中时
   * 排进队列，返回 `"queued"`。
   */
  create(
    object: number,
    config: string,
    parent: number | null,
  ): "sync" | "pending" | "unsupported" | "reload" | "queued" {
    const change: CreateChange = { kind: "create", object, config, parent, bone: boneOf(config, parent) };
    if (this.disposed) return "queued";
    const key = fragmentKey(config);
    const template = key === null ? undefined : this.cache.get(key);
    const id = configId(config);
    if (!template || id === null) {
      this.queue.push(change);
      return "queued";
    }
    const fragment = rekeyFragment(template, { object, id, parent });
    return this.land({ fragment }, true);
  }

  /**
   * 接进场景：`adopt` → 不支持项判定 → GPU（同步备好就装，否则排 `install`）。`sync` 为真时是 `createLayer` 当场（命中缓存），计数记进 `sync`；
   * 否则是片段到达之后。
   */
  private land(
    input: FragmentDelta | { fragment: ObjectFragment },
    sync: boolean,
  ): "sync" | "pending" | "unsupported" | "reload" {
    const { fragment } = input;
    const object = fragment.object;
    if (fragment.sceneFlips.length) {
      this.target.reload(`createLayer ${object} 翻转了场景级不变量（${fragment.sceneFlips.join("、")}）`);
      return "reload";
    }
    let pending: Promise<void>;
    try {
      pending = this.target.adopt(input);
    } catch (error) {
      this.target.reload(`createLayer ${object} 接入失败：${reasonOf(error)}`);
      return "reload";
    }
    // 先挂上：只有排 `install` 时才等它
    pending.catch(() => {});
    if (fragment.unsupported.length) {
      this.stats.unsupported++;
      this.target.unsupported(object, fragment.unsupported);
      return "unsupported";
    }
    // 没有 GPU 场景（首次加载 `init` 期间）：建场景时从 bundle 一起建
    if (!this.target.gpu()) return sync ? "sync" : "pending";
    const layer = fragment.layer;
    // 文本层要等排版（`state.texts`）才备得对：一律异步
    if (!layer.text) {
      try {
        const prepared = this.target.prepareSync(layer);
        if (prepared) {
          this.target.install(prepared);
          if (sync) this.stats.sync++;
          else this.stats.async++;
          return "sync";
        }
      } catch (error) {
        this.target.reload(`createLayer ${object} 装 GPU 失败：${reasonOf(error)}`);
        return "reload";
      }
    }
    this.queue.push(
      { kind: "install", object },
      pending.then(async (): Promise<PendingInstall<P>> => ({ layer, prepared: await this.target.prepare(layer) })),
    );
    return "pending";
  }

  /** 帧边界（`beforeFrame` 开头，脚本之前）：按先后装上已经好了的。 */
  drain(): number {
    if (this.disposed) return 0;
    return this.queue.drain(
      (change, value) => this.apply(change, value),
      (change, error) => this.fail(change, error),
    );
  }

  private apply(change: SceneChange, value: unknown): void {
    if (change.kind === "reload") {
      this.target.reload(change.reason);
      return;
    }
    if (change.kind === "install") {
      const { layer, prepared } = value as PendingInstall<P>;
      if (!this.target.alive(change.object) || !this.target.gpu()) {
        this.target.discard(prepared);
        return;
      }
      try {
        // 备好之后、装之前状态可能又变了（effect 开关等，装上之后 `sync` 不会因此重建）：程序与管线已经进了缓存，按现在的状态同步再备一次；
        // 备不好（缺 A2C 管线）才装异步备的
        const fresh = this.target.prepareSync(layer);
        if (fresh) {
          this.target.discard(prepared);
          this.target.install(fresh);
        } else this.target.install(prepared);
        this.stats.async++;
      } catch (error) {
        this.target.reload(`createLayer ${change.object} 装 GPU 失败：${reasonOf(error)}`);
      }
      return;
    }
    const delta = value as FragmentDelta;
    const key = fragmentKey(change.config);
    // 装入之前取一份：装入会改图层的位置字段
    const copy = key !== null && delta.fragment.sceneFlips.length === 0 ? cacheCopy(delta.fragment) : null;
    // 到达前已删：只进缓存（建删循环下一轮就命中）
    if (!this.target.alive(change.object)) {
      if (copy) this.cache.put(key!, copy);
      return;
    }
    const result = this.land(delta, false);
    if (copy && result !== "reload") this.cache.put(key!, copy);
  }

  private fail(change: SceneChange, error: unknown): void {
    const what = change.kind === "create" ? "编片段" : change.kind === "install" ? "备 GPU 对象" : "变更";
    this.target.reload(`createLayer ${"object" in change ? change.object : ""} ${what}失败：${reasonOf(error)}`);
  }

  /** 等队里的都好了（探针用：`init` 之后、首帧之前）。 */
  settled(): Promise<void> {
    return this.queue.settled();
  }

  /** 换场景、退回、销毁：队里没交出去的放弃（备好的 GPU 对象交还 `discard`）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.queue.dispose()) this.target.discard((item as PendingInstall<P>).prepared);
    this.cache.clear();
  }
}
