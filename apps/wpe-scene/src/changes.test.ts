/**
 * 活的场景图 L5 点 1：变更队列（`changes.ts`）。片段乱序到达也按 push 的先后 `arrive`；`drain` 严格按先后、队首没好就停；失败交给 `fail`；
 * `dispose` 之后不再 `arrive` / `warm`，交还已经备好的 `install`。L6：`recompile-object` 走同一条要片段的路。
 */
import { describe, expect, it } from "vitest";
import { SceneChangeQueue, type CreateChange, type RecompileChange } from "./changes";
import type { FragmentDelta } from "./compile/fragment";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const create = (object: number): CreateChange => ({ kind: "create", object, config: "{}", parent: null, bone: null });
const delta = (object: number) => ({ fragment: { object } }) as unknown as FragmentDelta;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SceneChangeQueue", () => {
  it("片段乱序到达：arrive 仍按 push 的先后；drain 按先后交出，队首没好就停", async () => {
    const compiles = new Map<number, ReturnType<typeof deferred<FragmentDelta>>>();
    const log: string[] = [];
    const queue = new SceneChangeQueue({
      compile: (change) => {
        const item = deferred<FragmentDelta>();
        compiles.set(change.object, item);
        log.push(`compile ${change.object}`);
        return item.promise;
      },
      arrive: (change) => void log.push(`arrive ${change.object}`),
      warm: async (change) => void log.push(`warm ${change.object}`),
    });
    queue.push(create(1));
    queue.push(create(2));
    // push 时立刻向会话要
    expect(log).toEqual(["compile 1", "compile 2"]);
    compiles.get(2)!.resolve(delta(2));
    await flush();
    // 2 先到也不先 arrive：要等 1
    expect(log).toEqual(["compile 1", "compile 2"]);
    const applied: number[] = [];
    expect(
      queue.drain(
        (change) => void applied.push((change as CreateChange).object),
        () => {},
      ),
    ).toBe(0);
    compiles.get(1)!.resolve(delta(1));
    await flush();
    expect(log).toEqual(["compile 1", "compile 2", "arrive 1", "warm 1", "arrive 2", "warm 2"]);
    expect(
      queue.drain(
        (change, value) => void applied.push((value as FragmentDelta).fragment.object),
        () => {},
      ),
    ).toBe(2);
    expect(applied).toEqual([1, 2]);
    expect(queue.size).toBe(0);
  });

  it("编失败、arrive 抛错：这一项交给 fail，后面的照常到达", async () => {
    const queue = new SceneChangeQueue({
      compile: async (change) => {
        if (change.object === 1) throw new Error("boom");
        return delta(change.object);
      },
      arrive: (change) => {
        if (change.object === 2) throw new Error("错位");
      },
    });
    queue.push(create(1));
    queue.push(create(2));
    queue.push(create(3));
    await queue.settled();
    const ok: number[] = [];
    const failed: string[] = [];
    queue.drain(
      (change) => void ok.push((change as CreateChange).object),
      (change, error) => void failed.push(`${(change as CreateChange).object}:${String(error)}`),
    );
    expect(failed).toEqual(["1:Error: boom", "2:Error: 错位"]);
    expect(ok).toEqual([3]);
  });

  it("warm 抛错不算失败；install 收备好的对象；reload 当场就绪", async () => {
    const queue = new SceneChangeQueue({
      compile: async (change) => delta(change.object),
      arrive: () => {},
      warm: async () => {
        throw new Error("预热失败");
      },
    });
    queue.push(create(1));
    queue.push({ kind: "install", object: 2 }, Promise.resolve("prepared"));
    queue.push({ kind: "reload", reason: "r" });
    await queue.settled();
    const seen: string[] = [];
    queue.drain(
      (change, value) =>
        void seen.push(change.kind === "create" ? `create` : change.kind === "install" ? String(value) : "reload"),
      () => void seen.push("fail"),
    );
    expect(seen).toEqual(["create", "prepared", "reload"]);
  });

  it("recompile-object（L6）：和 create 同一条路——立刻要片段、按 push 的先后到达、预热，drain 交出 FragmentDelta", async () => {
    const compiles = new Map<number, ReturnType<typeof deferred<FragmentDelta>>>();
    const log: string[] = [];
    const queue = new SceneChangeQueue({
      compile: (change) => {
        const item = deferred<FragmentDelta>();
        compiles.set(change.object, item);
        log.push(`compile ${change.kind} ${change.object}`);
        return item.promise;
      },
      arrive: (change) => void log.push(`arrive ${change.kind} ${change.object}`),
      warm: async (change) => void log.push(`warm ${change.object}`),
    });
    const recompile: RecompileChange = {
      kind: "recompile-object",
      object: 4,
      overrides: { font: "a.ttf" },
      parent: null,
      bone: null,
      config: "",
    };
    queue.push(create(1));
    queue.push(recompile);
    expect(log).toEqual(["compile create 1", "compile recompile-object 4"]);
    compiles.get(4)!.resolve(delta(4));
    await flush();
    // 重编的先回也要等前面的建层到达
    expect(log).toHaveLength(2);
    compiles.get(1)!.resolve(delta(1));
    await queue.settled();
    expect(log.slice(2)).toEqual(["arrive create 1", "warm 1", "arrive recompile-object 4", "warm 4"]);
    const seen: string[] = [];
    queue.drain(
      (change, value) => void seen.push(`${change.kind} ${(value as FragmentDelta).fragment.object}`),
      () => {},
    );
    expect(seen).toEqual(["create 1", "recompile-object 4"]);
  });

  it("dispose：交还已经备好的 install、之后到达的不再 arrive / warm、push 不收", async () => {
    const pending = deferred<FragmentDelta>();
    const log: string[] = [];
    const queue = new SceneChangeQueue({
      compile: () => pending.promise,
      arrive: (change) => void log.push(`arrive ${change.object}`),
      warm: async (change) => void log.push(`warm ${change.object}`),
    });
    queue.push(create(1));
    queue.push({ kind: "install", object: 2 }, Promise.resolve("p2"));
    await flush();
    expect(queue.busy).toBe(true);
    expect(queue.dispose()).toEqual(["p2"]);
    pending.resolve(delta(1));
    await flush();
    expect(log).toEqual([]);
    queue.push(create(3));
    expect(queue.size).toBe(0);
  });
});
