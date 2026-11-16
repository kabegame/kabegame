// L3b 点 4：`ScriptRuntime.replayWritesFor`：只重放目标在这些对象上的写入（键 `objects/<i>/` 前缀），顺序同 `replayWrites`。
import type { ScriptModule } from "./moduleFactory";
import { fakeModule } from "./testing/fakeModule";
import { describe, expect, it } from "vitest";
import { ScriptRuntime, type ScriptRealm } from "./runtime";

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = {};
  prototypes = { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(): Promise<ScriptModule> {
    return fakeModule({});
  }
  dispose() {}
}

const report = { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} };

function harness() {
  const writes: string[] = [];
  const runtime = new ScriptRuntime(new FakeRealm(), {
    report,
    write(target, value, source) {
      const key =
        target.kind === "layer" || target.kind === "sound"
          ? `objects/${target.object}/${target.field}`
          : target.kind === "general"
            ? `general/${target.key}`
            : source;
      writes.push(`${key}=${JSON.stringify(value)}:${source}`);
      return true;
    },
    read: () => null,
  });
  return { runtime, writes };
}

describe("ScriptRuntime.replayWritesFor（L3b）", () => {
  it("只重放目标在这些对象上的写入，顺序同 replayWrites；objects/1 不误伤 objects/12；全库的 general 写入不重放", () => {
    const { runtime, writes } = harness();
    runtime.rememberWrite({ kind: "layer", object: 1, field: "alpha" }, [0.1]);
    runtime.rememberWrite({ kind: "layer", object: 12, field: "alpha" }, [0.2]);
    runtime.rememberWrite({ kind: "general", key: "zoom" } as never, [3]);
    runtime.rememberWrite({ kind: "layer", object: 1, field: "origin" }, [1, 2, 3]);
    runtime.rememberWrite({ kind: "layer", object: 2, field: "alpha" }, [0.3]);
    runtime.replayWritesFor(new Set([1]));
    expect(writes).toEqual(["objects/1/alpha=[0.1]:script-replay", "objects/1/origin=[1,2,3]:script-replay"]);
    writes.length = 0;
    runtime.replayWritesFor(new Set([2, 12]));
    expect(writes).toEqual(["objects/12/alpha=[0.2]:script-replay", "objects/2/alpha=[0.3]:script-replay"]);
    // 空集合与没有写入的对象什么都不重放
    writes.length = 0;
    runtime.replayWritesFor(new Set());
    runtime.replayWritesFor(new Set([99]));
    expect(writes).toEqual([]);
    // 对照：replayWrites 重放全部（含 general）
    runtime.replayWrites();
    expect(writes).toHaveLength(5);
  });

  it("重放的是当前值：同一目标后写覆盖先写", () => {
    const { runtime, writes } = harness();
    runtime.rememberWrite({ kind: "layer", object: 4, field: "alpha" }, [0.1]);
    runtime.rememberWrite({ kind: "layer", object: 4, field: "alpha" }, [0.9]);
    runtime.replayWritesFor(new Set([4]));
    expect(writes).toEqual(["objects/4/alpha=[0.9]:script-replay"]);
  });
});
