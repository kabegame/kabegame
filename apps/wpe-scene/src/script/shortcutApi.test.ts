/**
 * P11d：`engine.openUserShortcut` 的门禁（p11-REPORT「P11d 补测」门禁表）与 `engine.userProperties` 里快捷方式项的形状。
 * 假 realm（`SyntaxError` 是 realm 自己的类，证明抛的是它），运行时、API、令牌用真的；宿主一侧的取令牌 / 查属性在这里用同样的逻辑替身，
 * 真宿主的接线见 `host.shortcut.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { mergeProperties, type UserProperty } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import type { SceneScript } from "../compile/scripts";
import { SceneState } from "../render/state";
import { ShortcutToken } from "../shortcut/token";
import { ScriptApi, scriptUserProperties } from "./api";
import { ScriptRuntime, type ScriptRealm } from "./runtime";

class RealmSyntaxError extends SyntaxError {}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, SyntaxError: RealmSyntaxError };
  prototypes = { Vec2: {}, Vec3: {}, Vec4: {}, Mat3: {}, Mat4: {} };
  modules = new Map<string, Record<string, unknown>>();
  internal = {
    updateScriptProperties() {},
    // 同 WPE `convertUserProperties`：快捷方式项取 `{isbound, commandtype, file}`（缺的字段不出现在 JSON 里，读出来是 undefined）
    convertUserProperties: (json: string) =>
      Object.fromEntries(
        Object.entries(
          JSON.parse(json) as Record<string, { type: string; value: unknown } & Record<string, unknown>>,
        ).map(([key, item]) => [
          key,
          item.type === "usershortcut"
            ? { isbound: item.isbound, commandtype: item.commandtype, file: item.file }
            : item.value,
        ]),
      ),
  };
  async importModule(_source: string, label: string): Promise<Record<string, unknown>> {
    return this.modules.get(label) ?? {};
  }
  dispose() {}
}

const script = (id: string): SceneScript => ({
  id,
  source: "",
  target: { kind: "layer", object: 0, field: "alpha" } as SceneScript["target"],
  valueType: "float",
  initial: 1,
  owner: { kind: "layer", object: 0 },
  layer: 0,
  scriptProperties: null,
  imports: [],
  errors: [],
});

function harness(properties: Record<string, UserProperty>) {
  const realm = new FakeRealm();
  const token = new ShortcutToken();
  const full = new Map<string, UserProperty>();
  mergeProperties(full, properties);
  const posted: string[] = [];
  const warnings: string[] = [];
  let runtime!: ScriptRuntime;
  const api = new ScriptApi(realm, {
    bundle: () => ({}) as SceneBundle,
    state: () => ({}) as SceneState,
    screenResolution: () => [100, 100],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write: () => true,
    activeCallback: () => runtime.activeCallback,
    // 宿主的逻辑：先取令牌，没有 → 2；再查属性（`type` 与 `isbound`）
    openUserShortcut: (name) => {
      if (!token.take()) return 2;
      const property = full.get(name);
      if (property?.type !== "usershortcut" || property.isbound !== true) return 0;
      posted.push(name);
      return 1;
    },
  });
  runtime = new ScriptRuntime(realm, {
    report: {
      ready() {},
      fallback() {},
      debug() {},
      info() {},
      warn: (message: string) => void warnings.push(message),
      error: (message: string) => void warnings.push(message),
    },
    read: () => [0.5],
    write: () => true,
    enterScript: (item) => api.enterScript(item),
    setProperties: (props) => api.setProperties(props),
  });
  api.attachRuntime(runtime);
  api.setProperties(full);
  const engine = realm.global.engine as { openUserShortcut(...args: unknown[]): unknown };
  return { realm, api, runtime, token, posted, warnings, engine, full };
}

const BOUND: UserProperty = {
  type: "usershortcut",
  value: "0123456789abcdef",
  isbound: true,
  commandtype: "file",
  file: "notepad.exe",
};
const UNBOUND: UserProperty = { type: "usershortcut", value: "", isbound: false };

/** 左键按下：这一帧按下沿发令牌（`beginFrame` → 回调 → `endFrame`）。 */
function press(h: ReturnType<typeof harness>, during: () => void, down = true) {
  h.token.beginFrame(down);
  during();
  h.token.endFrame(down);
}

describe("engine.openUserShortcut：回调类别（realm 的 SyntaxError，文本照抄 WPE）", () => {
  it("模块求值、宿主直接调用（不在任何回调里）都抛 SyntaxError", () => {
    const h = harness({ s1: BOUND });
    expect(() => h.engine.openUserShortcut("s1")).toThrow(RealmSyntaxError);
    expect(() => h.engine.openUserShortcut("s1")).toThrow("Cannot execute user command outside of cursor callbacks.");
    h.runtime.cursorEvent(0, "cursorDown", [0, 0, 0], [0, 0, 0]); // 没加载脚本：不抛
  });

  it("update / init / cursorEnter / cursorLeave / cursorMove 里调都抛；cursorMove 不捕获时禁用该回调（日志含 SyntaxError）", async () => {
    const h = harness({ s1: BOUND });
    const outcomes: Record<string, unknown> = {};
    const attempt = (name: string) => () => {
      try {
        h.engine.openUserShortcut("s1");
        outcomes[name] = "returned";
      } catch (error) {
        outcomes[name] = error instanceof RealmSyntaxError ? (error as Error).message : String(error);
      }
    };
    h.realm.modules.set("a", {
      init: attempt("init"),
      update: attempt("update"),
      cursorEnter: attempt("cursorEnter"),
      cursorLeave: attempt("cursorLeave"),
    });
    h.realm.modules.set("b", {
      cursorMove: () => {
        h.engine.openUserShortcut("s1");
      },
    });
    await h.runtime.load({ list: [script("a"), script("b")] });
    h.runtime.frame(1 / 60);
    h.runtime.cursorEvent(0, "cursorEnter", [0, 0, 0], [0, 0, 0]);
    h.runtime.cursorEvent(0, "cursorLeave", [0, 0, 0], [0, 0, 0]);
    h.runtime.cursorEvent(0, "cursorMove", [0, 0, 0], [0, 0, 0]);
    const outside = "Cannot execute user command outside of cursor callbacks.";
    expect(outcomes).toEqual({ init: outside, update: outside, cursorEnter: outside, cursorLeave: outside });
    expect(h.warnings.join("\n")).toMatch(/cursorMove 出错：Cannot execute user command outside/);
    // cursorMove 被禁用：再移动不再调
    const before = h.warnings.length;
    h.runtime.cursorEvent(0, "cursorMove", [0, 0, 0], [0, 0, 0]);
    expect(h.warnings.length).toBe(before);
  });

  it("计时器回调里调（即使是光标回调里设的）也抛：回调类别是 timer", async () => {
    const h = harness({ s1: BOUND });
    let thrown: unknown = null;
    h.realm.modules.set("a", {
      cursorDown: () => {
        (h.realm.global.engine as { setTimeout(fn: () => void, ms: number): void }).setTimeout(() => {
          try {
            h.engine.openUserShortcut("s1");
          } catch (error) {
            thrown = error;
          }
        }, 0);
      },
    });
    await h.runtime.load({ list: [script("a")] });
    press(h, () => h.runtime.cursorEvent(0, "cursorDown", [0, 0, 0], [0, 0, 0]));
    h.runtime.frame(0.016);
    expect(thrown).toBeInstanceOf(RealmSyntaxError);
  });
});

describe("engine.openUserShortcut：令牌与属性", () => {
  async function withCallbacks(h: ReturnType<typeof harness>, exports: Record<string, () => unknown>) {
    h.realm.modules.set("a", exports);
    await h.runtime.load({ list: [script("a")] });
  }
  const fire = (h: ReturnType<typeof harness>, callback: "cursorDown" | "cursorUp" | "cursorClick") =>
    h.runtime.cursorEvent(0, callback, [0, 0, 0], [0, 0, 0]);

  it("已配好的快捷方式返回 true 并交出属性名；同一次点击里 Down / Up / Click 共用一个令牌，第二次调用抛错", async () => {
    const h = harness({ s1: BOUND });
    const results: unknown[] = [];
    const second: unknown[] = [];
    await withCallbacks(h, {
      cursorDown: () => void results.push(h.engine.openUserShortcut("s1")),
      cursorClick: () => {
        try {
          h.engine.openUserShortcut("s1");
          second.push("returned");
        } catch (error) {
          second.push(error instanceof RealmSyntaxError ? (error as Error).message : String(error));
        }
      },
    });
    press(h, () => fire(h, "cursorDown"));
    press(h, () => {}); // 按住
    press(h, () => fire(h, "cursorClick"), false);
    expect(results).toEqual([true]);
    expect(h.posted).toEqual(["s1"]);
    expect(second).toEqual(["Cannot execute more than one user command per cursor click."]);
  });

  it("cursorClick 连调两次：第一次 true，第二次抛错；cursorUp 先调、cursorClick 再调同样（共用一个令牌）", async () => {
    const h = harness({ s1: BOUND });
    const log: string[] = [];
    const call = (label: string) => {
      try {
        log.push(`${label}:${String(h.engine.openUserShortcut("s1"))}`);
      } catch (error) {
        log.push(`${label}:${(error as Error).message}`);
      }
    };
    await withCallbacks(h, {
      cursorClick: () => {
        call("click1");
        call("click2");
      },
    });
    press(h, () => {});
    press(h, () => fire(h, "cursorClick"), false);
    expect(log).toEqual(["click1:true", "click2:Cannot execute more than one user command per cursor click."]);

    const h2 = harness({ s1: BOUND });
    const log2: string[] = [];
    h2.realm.modules.set("a", {
      cursorUp: () => {
        try {
          log2.push(`up:${String(h2.engine.openUserShortcut("s1"))}`);
        } catch (error) {
          log2.push(`up:${(error as Error).message}`);
        }
      },
      cursorClick: () => {
        try {
          log2.push(`click:${String(h2.engine.openUserShortcut("s1"))}`);
        } catch (error) {
          log2.push(`click:${(error as Error).message}`);
        }
      },
    });
    await h2.runtime.load({ list: [script("a")] });
    press(h2, () => {});
    press(
      h2,
      () => {
        fire(h2, "cursorUp");
        fire(h2, "cursorClick");
      },
      false,
    );
    expect(log2).toEqual(["up:true", "click:Cannot execute more than one user command per cursor click."]);
  });

  it("参数缺失或不是字符串原始值：返回 false、不消耗令牌（之后再调仍能用）", async () => {
    const h = harness({ s1: BOUND });
    const results: unknown[] = [];
    await withCallbacks(h, {
      cursorDown: () => {
        results.push(h.engine.openUserShortcut());
        results.push(h.engine.openUserShortcut(123));
        results.push(h.engine.openUserShortcut(null));
        results.push(h.engine.openUserShortcut({ toString: () => "s1" }));
        results.push(h.engine.openUserShortcut("s1"));
      },
    });
    press(h, () => fire(h, "cursorDown"));
    expect(results).toEqual([false, false, false, false, true]);
    expect(h.posted).toEqual(["s1"]);
  });

  it("不存在的属性、没配好的快捷方式、别的类型的属性：false，但令牌已消耗（第二次抛错）", async () => {
    const h = harness({
      s1: BOUND,
      empty: UNBOUND,
      text: { type: "textinput", value: "file:x:C:\\a.exe", isbound: true },
    });
    for (const name of ["nope", "empty", "text"]) {
      const log: string[] = [];
      h.realm.modules.set("a", {
        cursorDown: () => {
          log.push(String(h.engine.openUserShortcut(name)));
          try {
            h.engine.openUserShortcut("s1");
            log.push("returned");
          } catch (error) {
            log.push((error as Error).message);
          }
        },
      });
      await h.runtime.load({ list: [script("a")] });
      press(h, () => fire(h, "cursorDown"));
      press(h, () => {}, false);
      expect(log, name).toEqual(["false", "Cannot execute more than one user command per cursor click."]);
    }
    expect(h.posted).toEqual([]);
  });

  it("没有点击（令牌是空的）时在光标回调里调：抛「同一次点击」那条", async () => {
    const h = harness({ s1: BOUND });
    let message = "";
    await withCallbacks(h, {
      cursorUp: () => {
        try {
          h.engine.openUserShortcut("s1");
        } catch (error) {
          message = (error as Error).message;
        }
      },
    });
    press(h, () => fire(h, "cursorUp"), false);
    expect(message).toBe("Cannot execute more than one user command per cursor click.");
  });
});

describe("快捷方式项在脚本里的形状", () => {
  it("engine.userProperties 里快捷方式项是 {}（三个字段都是 undefined），别的项照常", async () => {
    const h = harness({ s1: BOUND, empty: UNBOUND, speed: { type: "slider", value: 2 } });
    h.realm.modules.set("a", {});
    await h.runtime.load({ list: [script("a")] });
    const seen = (h.realm.global.engine as { userProperties: Record<string, Record<string, unknown> | number> })
      .userProperties;
    for (const key of ["s1", "empty"]) {
      const item = seen[key] as Record<string, unknown>;
      expect(item.isbound, key).toBeUndefined();
      expect(item.commandtype, key).toBeUndefined();
      expect(item.file, key).toBeUndefined();
      expect(JSON.parse(JSON.stringify(item)), key).toEqual({});
    }
    expect(seen.speed).toBe(2);
  });

  it("scriptUserProperties 只剥快捷方式的 isbound / commandtype / file，保留 type 与 value", () => {
    const full = new Map<string, UserProperty>();
    mergeProperties(full, { s1: BOUND, speed: { type: "slider", value: 2 } });
    expect(full.get("s1")).toEqual(BOUND);
    expect(scriptUserProperties(full)).toEqual({
      s1: { type: "usershortcut", value: BOUND.value },
      speed: { type: "slider", value: 2 },
    });
  });

  it("applyUserProperties 的增量收到 {isbound, commandtype, file}：未绑定只有 isbound", async () => {
    const h = harness({ s1: BOUND, empty: UNBOUND });
    let delta: Record<string, unknown> | null = null;
    h.realm.modules.set("a", { applyUserProperties: (props: Record<string, unknown>) => (delta = props) });
    await h.runtime.load({ list: [script("a")] });
    h.runtime.applyUserProperties(Object.fromEntries(h.full), h.full);
    expect(JSON.parse(JSON.stringify(delta))).toEqual({
      s1: { isbound: true, commandtype: "file", file: "notepad.exe" },
      empty: { isbound: false },
    });
  });
});

describe("mergeProperties 保留快捷方式的后端字段", () => {
  it("只保留已给出的字段（不补 undefined 键），别的类型不带；值没变不算变化", () => {
    const full = new Map<string, UserProperty>();
    const changes = mergeProperties(full, {
      s1: { ...BOUND, junk: 1 } as UserProperty,
      other: { type: "slider", value: 1, isbound: true } as UserProperty,
      empty: UNBOUND,
    });
    expect([...changes.keys()].sort()).toEqual(["empty", "other", "s1"]);
    expect(full.get("s1")).toEqual(BOUND);
    expect(Object.keys(full.get("empty")!)).toEqual(["type", "value", "isbound"]);
    expect(full.get("other")).toEqual({ type: "slider", value: 1 });
    expect(mergeProperties(full, { s1: BOUND }).size).toBe(0);
    // 值（键）变了才是变化，新字段随之更新
    const next = { ...BOUND, value: "ffffffffffffffff", file: "calc.exe" };
    expect([...mergeProperties(full, { s1: next }).keys()]).toEqual(["s1"]);
    expect(full.get("s1")).toEqual(next);
  });
});
