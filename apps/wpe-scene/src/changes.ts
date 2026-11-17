/**
 * 宿主的场景变更队列（活的场景图 L5，`.claude/plans/wpe-import/3-scene/live/phase-l5-create-layer.md` 点 1）。
 *
 * 对象级的改动排进来，异步的那一段（向编译会话要片段、在 GPU 上备对象）在帧外做，做好的在下一帧 `beforeFrame` 开头（脚本之前）按排进来的先后
 * 交给宿主装上（`drain`，同步）。场景级的改动（`reload`）也排在这里，按先后交给宿主整场重载。
 *
 * - `create`：`push` 时立刻向会话要片段（会话在 Worker 里串行处理）。片段到达后**按 push 的先后一个接一个**交给 `arrive`（场景级增量进登记表：
 *   增量的 `from` 要和登记表的表长对齐，不能乱序），再交给 `warm`（在 GPU 上预热这个对象要的程序与管线，不碰正在画的；可以并行）。
 * - `install`：GPU 异步备好的对象（命中缓存但不能同步备好、文本层等排版），`task` 是备它的 Promise。
 * - `reload`：整场重载（编片段失败、片段带 `sceneFlips`、装的时候出错，由调用方转成这一种）。
 *
 * `drain` 严格按先后：队首还没好就停（后面的即使好了也等），所以装的顺序与排进来的顺序一致，结果可复现。
 * 队列属于一个场景（一个会话、一份登记表）：换场景时 `dispose`，没交出去的结果交还调用方放弃，之后到达的不再交给 `arrive` / `warm`。
 */
import type { FragmentDelta } from "./compile/fragment";

/** 宿主的场景变更（L5）：对象级改动排进来，编好的在下一帧 beforeFrame 开头（脚本之前）按先后装上；场景级的整场重载。 */
export type SceneChange =
  | { kind: "create"; object: number; config: string; parent: number | null; bone: string | null }
  | { kind: "install"; object: number }
  | { kind: "reload"; reason: string };

export type CreateChange = Extract<SceneChange, { kind: "create" }>;

export interface SceneChangeHooks {
  /** 向会话要片段（会话自己串行）。 */
  compile(change: CreateChange): Promise<FragmentDelta>;
  /** 片段到达（按 push 的先后，一个接一个，同步）：场景级增量进登记表。抛错时这一项失败（交给 `drain` 的 `fail`）。 */
  arrive(change: CreateChange, delta: FragmentDelta): void;
  /** 到达之后的预热（异步，可以并行；不该抛错，抛了也只当预热失败、不影响这一项）。没有 GPU 场景时直接返回。 */
  warm?(change: CreateChange, delta: FragmentDelta): Promise<void>;
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

interface Entry {
  change: SceneChange;
  result: Settled | null;
  done: Promise<void>;
}

export class SceneChangeQueue {
  private readonly entries: Entry[] = [];
  /** 片段到达的串行链：`arrive` 按 push 的先后调 */
  private arrivals: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly hooks: SceneChangeHooks) {}

  /** 还没交出去的项数（含还没好的）。 */
  get size(): number {
    return this.entries.length;
  }

  /** 队里有没有还没好的项。 */
  get busy(): boolean {
    return this.entries.some((entry) => entry.result === null);
  }

  /**
   * 排进一项。`create` 立刻向会话要片段；`install` 要给备它的 `task`；`reload` 当场就绪。队列已 `dispose` 时什么都不做（`task` 的结果没人收，
   * 调用方负责：换场景时旧场景整个销毁）。
   */
  push(change: SceneChange, task?: Promise<unknown>): void {
    if (this.disposed) return;
    const entry: Entry = { change, result: null, done: Promise.resolve() };
    this.entries.push(entry);
    let work: Promise<unknown>;
    if (change.kind === "reload") work = Promise.resolve();
    else if (change.kind === "install") {
      if (!task) throw new Error("install 要给备对象的 Promise");
      work = task;
    } else {
      // 同步抛的（会话已关等）也当这一项失败，不让它挂在队里（`settled` 会一直等）
      let compiled: Promise<FragmentDelta>;
      try {
        compiled = this.hooks.compile(change);
      } catch (error) {
        compiled = Promise.reject(error);
      }
      // 先挂上：到达链排到它之前 reject 不算未处理
      compiled.catch(() => {});
      const arrived = this.arrivals.then(async () => {
        const delta = await compiled;
        if (!this.disposed) this.hooks.arrive(change, delta);
        return delta;
      });
      // 链上一项失败不挡后面的到达（失败的那项自己交给 `fail`；会话坏了后面的也会失败）
      this.arrivals = arrived.then(
        () => {},
        () => {},
      );
      work = arrived.then(async (delta) => {
        if (!this.disposed && this.hooks.warm) {
          try {
            await this.hooks.warm(change, delta);
          } catch {
            // 预热只是让装入时能同步备好；失败时装入照样按同步 → 异步的顺序试
          }
        }
        return delta;
      });
    }
    entry.done = work.then(
      (value) => {
        entry.result = { ok: true, value };
      },
      (error: unknown) => {
        entry.result = { ok: false, error };
      },
    );
  }

  /**
   * 帧边界（`beforeFrame` 开头）：按先后把已经好了的项交出去，队首没好就停。`apply` 收成功的（`create` 收 `FragmentDelta`，`install` 收备好的对象，
   * `reload` 收 undefined），`fail` 收失败的。返回交出去的项数。
   */
  drain(
    apply: (change: SceneChange, value: unknown) => void,
    fail: (change: SceneChange, error: unknown) => void,
  ): number {
    let count = 0;
    while (this.entries.length > 0 && this.entries[0].result !== null) {
      const { change, result } = this.entries.shift()!;
      count++;
      if (result!.ok) apply(change, result!.value);
      else fail(change, result!.error);
    }
    return count;
  }

  /** 等到调用这一刻队里的项都好了（成功或失败）；探针在 `init` 之后、首帧之前与读回之前用，宿主不用（帧循环里不能等）。 */
  async settled(): Promise<void> {
    while (this.busy) await Promise.all(this.entries.map((entry) => entry.done));
  }

  /**
   * 换场景、退回、销毁：之后的 `push` 不收、之后到达的片段不再 `arrive` / `warm`。返回还没交出去、已经成功的 `install` 结果（备好的对象），
   * 调用方放弃它们（旧场景随之销毁时可以不管）。
   */
  dispose(): unknown[] {
    this.disposed = true;
    const prepared = this.entries
      .filter((entry) => entry.change.kind === "install" && entry.result?.ok === true)
      .map((entry) => (entry.result as { ok: true; value: unknown }).value);
    this.entries.length = 0;
    return prepared;
  }
}
