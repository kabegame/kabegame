/**
 * `resizeScreen`：`ScriptRuntime.resizeScreen`（脚本派发）与 `ScreenResolution`（渲染器什么时候触发）。假 realm，同 `cursorEvent.test.ts` 的写法。
 * WPE 依据：exe 派发 wp.asm `0x14017f700`–`0x14017f7c8`，dll `CallCallback` 第 2 号分支 `0x18164e6fa`。
 */
import type { ScriptModule } from "./moduleFactory";
import { fakeModule } from "./testing/fakeModule";
import { describe, expect, it, vi } from "vitest";
import type { SceneScript } from "../compile/scripts";
import { MISSING_SCRIPT_CALLBACKS } from "../compile/scriptApi";
import { ScreenResolution } from "../render/screenResolution";
import { RUNTIME_CALLBACKS, ScriptRuntime, type ScriptRealm, type ScriptTarget } from "./runtime";

class Vec2 {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object };
  prototypes = { Vec2: Vec2.prototype, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown> | Error>();
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(_source: string, label: string): Promise<ScriptModule> {
    const result = this.modules.get(label);
    if (result instanceof Error) throw result;
    return fakeModule(result ?? {});
  }
  dispose() {}
}

const script = (id: string, owner: SceneScript["owner"], field = "alpha"): SceneScript => ({
  id,
  source: "",
  target: { kind: "layer", object: 0, field } as SceneScript["target"],
  valueType: "float",
  initial: 1,
  owner,
  layer: owner.kind === "general" ? null : owner.kind === "material" ? owner.layer : owner.object,
  scriptProperties: null,
  imports: [],
  errors: [],
});

function harness() {
  const realm = new FakeRealm();
  const written: unknown[] = [];
  const warnings: string[] = [];
  const runtime = new ScriptRuntime(realm, {
    report: {
      ready() {},
      fallback() {},
      debug() {},
      info() {},
      warn: (message: string) => void warnings.push(message),
      error: (message: string) => void warnings.push(message),
    },
    read: (_target: ScriptTarget) => [0.5],
    write: (_target, value) => {
      written.push(value);
      return true;
    },
  });
  return { realm, runtime, written, warnings };
}

describe("ScriptRuntime.resizeScreen", () => {
  it("运行时调用它，编译期不再报 script:callback:resizeScreen", () => {
    expect((RUNTIME_CALLBACKS as readonly string[]).includes("resizeScreen")).toBe(true);
    expect(MISSING_SCRIPT_CALLBACKS.includes("resizeScreen")).toBe(false);
  });

  it("全场景广播、按记录顺序：不分对象（general、effect、材质上的脚本都收），只发给已 init、导出了它的脚本", async () => {
    const h = harness();
    const calls: string[] = [];
    const listener = (id: string) => ({ resizeScreen: () => void calls.push(id) });
    for (const id of ["b", "a", "g", "m"]) h.realm.modules.set(id, listener(id));
    h.realm.modules.set("plain", { update: () => {} });
    h.realm.modules.set("notfn", { resizeScreen: 5 });
    h.realm.modules.set("bad", new Error("求值失败"));
    await h.runtime.load({
      list: [
        script("b", { kind: "layer", object: 1 }),
        script("bad", { kind: "layer", object: 0 }, "origin"),
        script("a", { kind: "effect", object: 0, effect: 0 }),
        script("plain", { kind: "layer", object: 0 }, "scale"),
        script("g", { kind: "general" }),
        script("notfn", { kind: "layer", object: 2 }),
        script("m", { kind: "material", pass: "objects/3/effects/0/passes/0", layer: 3 }),
      ],
    });
    h.runtime.resizeScreen(2560, 1440);
    expect(calls).toEqual(["b", "a", "g", "m"]);
    // 加载前（没有记录）不抛
    expect(() => harness().runtime.resizeScreen(1, 1)).not.toThrow();
  });

  it("参数：每个接收者各建一个 realm 的 Vec2，自有 x、y 是单精度值", async () => {
    const h = harness();
    const seen: unknown[] = [];
    h.realm.modules.set("one", { resizeScreen: (size: unknown) => void seen.push(size) });
    h.realm.modules.set("two", { resizeScreen: (size: unknown) => void seen.push(size) });
    await h.runtime.load({ list: [script("one", { kind: "general" }), script("two", { kind: "general" }, "zoom")] });
    h.runtime.resizeScreen(1920.3, 1080);
    expect(seen).toHaveLength(2);
    const [first, second] = seen as Vec2[];
    expect(first).toBeInstanceOf(Vec2);
    expect(Object.keys(first)).toEqual(["x", "y"]);
    expect(first).toEqual(new Vec2(Math.fround(1920.3), 1080));
    expect(second).not.toBe(first);
    first.x = 1;
    expect(second.x).toBe(Math.fround(1920.3));
  });

  it("返回值丢弃：回调返回数字也不写回字段", async () => {
    const h = harness();
    h.realm.modules.set("r", { resizeScreen: () => 0.25 });
    await h.runtime.load({ list: [script("r", { kind: "layer", object: 0 })] });
    h.written.length = 0;
    h.runtime.resizeScreen(800, 600);
    expect(h.written).toEqual([]);
  });

  it("回调抛错只禁用这个回调：之后不再调它，同一脚本的 update、别的脚本的 resizeScreen 照常", async () => {
    const h = harness();
    const calls: string[] = [];
    h.realm.modules.set("bad", {
      resizeScreen: () => {
        calls.push("bad-resize");
        throw new Error("boom");
      },
      update: () => void calls.push("bad-update"),
    });
    h.realm.modules.set("good", { resizeScreen: () => void calls.push("good-resize") });
    await h.runtime.load({ list: [script("bad", { kind: "general" }), script("good", { kind: "general" }, "zoom")] });
    h.runtime.resizeScreen(800, 600);
    h.runtime.resizeScreen(640, 480);
    h.runtime.frame(0.016);
    expect(calls).toEqual(["bad-resize", "good-resize", "good-resize", "bad-update"]);
    expect(h.warnings.some((line) => line.includes("resizeScreen") && line.includes("boom"))).toBe(true);
  });
});

describe("ScreenResolution（渲染器什么时候触发 resizeScreen）", () => {
  it("第一次量只记下、不通知（WPE 首次创建不调）；之后变了才通知，回调里读到的已是新值", () => {
    const seen: [number, number, [number, number]][] = [];
    const tracker: ScreenResolution = new ScreenResolution((width, height) =>
      seen.push([width, height, tracker.current]),
    );
    expect(tracker.current).toEqual([1, 1]);
    tracker.measure(1920, 1080);
    expect(tracker.current).toEqual([1920, 1080]);
    expect(seen).toEqual([]);
    // 定期核对量到同一个值：不通知
    tracker.measure(1920, 1080);
    expect(seen).toEqual([]);
    tracker.measure(2560, 1080);
    tracker.measure(2560, 1440);
    tracker.measure(2560, 1440);
    expect(seen).toEqual([
      [2560, 1080, [2560, 1080]],
      [2560, 1440, [2560, 1440]],
    ]);
  });

  it("seed（渲染器建好之前、脚本 init 里读的那次）：只在没量过时记下、不通知；之后渲染器量到的不同才通知，相同不通知", () => {
    const onChange = vi.fn();
    const same = new ScreenResolution(onChange);
    same.seed(2880, 1620);
    // 已有值时 seed 不动（别在脚本的调用里触发回调）
    same.seed(100, 100);
    expect(same.current).toEqual([2880, 1620]);
    same.measure(2880, 1620);
    expect(onChange).not.toHaveBeenCalled();
    const moved = new ScreenResolution(onChange);
    moved.seed(2880, 1620);
    // init 之后、渲染器建好之前布局变了：渲染器的第一次量就要补一次 resizeScreen
    moved.measure(1920, 1080);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1920, 1080);
    // 渲染器量过之后 seed 不动
    moved.seed(5, 5);
    expect(moved.current).toEqual([1920, 1080]);
  });

  it("第一次量到的就是 1×1 也不通知；没有回调时照常记值", () => {
    const onChange = vi.fn();
    const tracker = new ScreenResolution(onChange);
    tracker.measure(1, 1);
    tracker.measure(1, 1);
    expect(onChange).not.toHaveBeenCalled();
    const silent = new ScreenResolution();
    silent.measure(10, 20);
    silent.measure(30, 40);
    expect(silent.current).toEqual([30, 40]);
  });
});
