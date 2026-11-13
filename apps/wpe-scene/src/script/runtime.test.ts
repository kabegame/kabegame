import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene } from "../compile/bundle";
import { collectScripts, type SceneScript } from "../compile/scripts";
import { parseScene } from "../compile/model";
import type { SceneReader } from "../compile/fs";
import { Wpesl2wgsl } from "../wpesl2wgsl";
import { ScriptRuntime, type ScriptRealm } from "./runtime";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

class Vec2 {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
class Vec3 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
  ) {}
}
class Vec4 {
  constructor(
    public x: number,
    public y: number,
    public z: number,
    public w: number,
  ) {}
}

class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = {};
  prototypes = { Vec2: Vec2.prototype, Vec3: Vec3.prototype, Vec4: Vec4.prototype, Mat3: {}, Mat4: {} };
  imports: string[] = [];
  events: string[] = [];
  disposed = false;
  modules = new Map<string, Record<string, unknown> | Error>();
  internal = {
    updateScriptProperties: (module: Record<string, unknown>, json: string) => {
      this.events.push(`properties:${JSON.stringify(JSON.parse(json))}`);
      Object.assign(module.scriptProperties as object, JSON.parse(json));
    },
    convertUserProperties: (json: string) => {
      this.events.push(`convert:${json}`);
      return Object.fromEntries(
        Object.entries(JSON.parse(json) as Record<string, { type: string; value: unknown }>).map(([key, value]) => [
          key,
          value.type === "color"
            ? new Vec3(...(String(value.value).split(" ").map(Number) as [number, number, number]))
            : value.value,
        ]),
      );
    },
  };
  async importModule(_source: string, label: string): Promise<Record<string, unknown>> {
    this.imports.push(label);
    this.events.push(`import:${label}`);
    const result = this.modules.get(label);
    if (result instanceof Error) throw result;
    return result ?? {};
  }
  dispose(): void {
    this.disposed = true;
  }
}

const script = (id: string, overrides: Partial<SceneScript> = {}): SceneScript => ({
  id,
  source: `export const id = "${id}"`,
  target: { kind: "layer", object: 0, field: "alpha" },
  valueType: "float",
  initial: 1,
  owner: { kind: "layer", object: 0 },
  layer: 0,
  scriptProperties: null,
  imports: [],
  errors: [],
  ...overrides,
});

function harness(realm = new FakeRealm()) {
  let clock = 0;
  const values = new Map<string, number[] | boolean | string>();
  const logs: string[] = [];
  const contexts: (string | null)[] = [];
  const report = {
    ready() {},
    fallback() {},
    debug() {},
    info(message: string) {
      logs.push(`info:${message}`);
    },
    warn(message: string) {
      logs.push(`warn:${message}`);
    },
    error(message: string) {
      logs.push(`error:${message}`);
    },
  };
  const runtime = new ScriptRuntime(realm, {
    report,
    now: () => clock,
    write(target, value, source) {
      values.set(target.kind === "layer" ? target.field : source, value);
      realm.events.push(`write:${source}`);
      return true;
    },
    read(target) {
      return values.get(target.kind === "layer" ? target.field : "") ?? null;
    },
    enterScript(owner) {
      contexts.push(owner?.id ?? null);
    },
    setProperties(full) {
      realm.events.push(`full:${[...full.keys()].join(",")}`);
    },
  });
  return {
    realm,
    runtime,
    values,
    logs,
    contexts,
    setClock: (value: number) => {
      clock = value;
    },
  };
}

describe("脚本运行时（FakeRealm）", () => {
  it("顺序求值、隔离失败、属性先于 init、首次全量颜色转换、计时器先于 update", async () => {
    const h = harness();
    h.realm.modules.set("bad", new Error("求值失败"));
    h.realm.modules.set("one", {
      scriptProperties: { speed: 0 },
      init: () => {
        h.realm.events.push("init");
        return 2;
      },
      applyUserProperties: (delta: Record<string, unknown>) => {
        expect(delta.tint).toBeInstanceOf(Vec3);
        h.realm.events.push("apply");
      },
      update: () => {
        h.realm.events.push("update");
      },
    });
    await h.runtime.load({ list: [script("one", { scriptProperties: { speed: 3 } }), script("bad"), script("last")] });
    expect(h.realm.imports).toEqual(["one", "bad", "last"]);
    expect(h.realm.events.indexOf('properties:{"speed":3}')).toBeLessThan(h.realm.events.indexOf("init"));
    h.runtime.applyUserProperties(
      { tint: { type: "color", value: "1 0 0" } },
      new Map([["tint", { type: "color", value: "1 0 0" }]]),
    );
    h.runtime.setTimeout(() => h.realm.events.push("timer"), 10, "one");
    h.runtime.frame(0.01);
    expect(h.realm.events.indexOf("init")).toBeLessThan(h.realm.events.indexOf("apply"));
    expect(h.realm.events.indexOf("timer")).toBeLessThan(h.realm.events.indexOf("update"));
    expect(h.logs.filter((line) => line.includes("求值失败"))).toHaveLength(1);
  });

  it("增量更新只命中对应 scriptProperties，先更新后 apply，全集先变且 init 不重跑", async () => {
    const h = harness();
    let init = 0;
    h.realm.modules.set("one", {
      scriptProperties: { speed: 1 },
      init: () => {
        init++;
      },
      applyUserProperties: (delta: object) => {
        expect(delta).toEqual({ speed: 9 });
        h.realm.events.push("apply");
      },
    });
    await h.runtime.load({ list: [script("one", { scriptProperties: { speed: 1 } })] });
    h.realm.events.length = 0;
    h.realm.events.push("direct");
    h.runtime.applyUserProperties(
      { speed: { type: "slider", value: 9 } },
      new Map([
        ["speed", { type: "slider", value: 9 }],
        ["other", { type: "bool", value: true }],
      ]),
      [{ property: "speed", target: { kind: "script-property", script: "one", key: "speed" } }],
    );
    expect(h.realm.events.slice(0, 4)).toEqual([
      "direct",
      "full:speed,other",
      'properties:{"speed":9}',
      'convert:{"speed":{"type":"slider","value":9}}',
    ]);
    expect(init).toBe(1);
  });

  it("返回值按标量、向量、布尔和角度转换，错误类型及其它回调的返回值忽略", async () => {
    const h = harness();
    const cases = [
      script("scalar"),
      script("vector", { target: { kind: "layer", object: 0, field: "origin" }, valueType: "vec3", initial: "0 0 0" }),
      script("visible", { target: { kind: "layer", object: 0, field: "visible" }, valueType: "bool", initial: true }),
      script("angles", {
        target: { kind: "layer", object: 0, field: "angles" },
        valueType: "angles",
        initial: "0 0 0",
      }),
    ];
    h.realm.modules.set("scalar", { init: () => 4, update: () => undefined });
    h.realm.modules.set("vector", { init: () => ({ x: 1, y: 2, z: 3 }), update: () => 5 });
    h.realm.modules.set("visible", { init: () => false, update: () => 0 });
    h.realm.modules.set("angles", { init: () => ({ x: 180, y: 0, z: 0 }), update: () => "bad" });
    await h.runtime.load({ list: cases });
    expect(h.values.get("alpha")).toEqual([4]);
    expect(h.values.get("origin")).toEqual([1, 2, 3]);
    expect(h.values.get("visible")).toBe(false);
    expect((h.values.get("angles") as number[])[0]).toBeCloseTo(Math.PI);
    h.runtime.frame(0.1);
    expect(h.values.get("origin")).toEqual([5, 5, 5]);
    expect(h.values.get("visible")).toBe(false);
  });

  it("计时器按帧推进、顺序触发、周期对齐、取消并保持脚本归属", async () => {
    const h = harness();
    await h.runtime.load({ list: [script("one")] });
    const seen: string[] = [];
    h.runtime.setTimeout(() => seen.push(`a:${h.runtime.currentScript?.id}`), 100, "one");
    const cancel = h.runtime.setTimeout(() => seen.push("cancelled"), 100, "one");
    h.runtime.clearTimeout(cancel);
    h.runtime.setTimeout(() => seen.push("b"), 100, "one");
    h.runtime.setInterval(() => seen.push("repeat"), 100, "one");
    h.runtime.frame(0.05);
    expect(seen).toEqual([]);
    h.runtime.frame(0.05);
    expect(seen).toEqual(["a:one", "b", "repeat"]);
    // 一帧跨过多个周期（超出 0.25 s）只触发一次，剩余对齐到下一个周期点（0.05 s 后）
    h.runtime.frame(0.35);
    expect(seen).toEqual(["a:one", "b", "repeat", "repeat"]);
    h.runtime.frame(0.04);
    expect(seen.filter((item) => item === "repeat")).toHaveLength(2);
    h.runtime.frame(0.02);
    expect(seen.filter((item) => item === "repeat")).toHaveLength(3);
  });

  it("setInterval 的长期频率不随帧间隔漂移", async () => {
    const h = harness();
    await h.runtime.load({ list: [script("one")] });
    let fires = 0;
    h.runtime.setInterval(() => fires++, 1000, "one");
    // 60 fps 跑 10.05 s（多 3 帧容浮点累积误差）：每次触发都有不足一帧的超出，周期仍是 1 s
    for (let i = 0; i < 603; i++) h.runtime.frame(1 / 60);
    expect(fires).toBe(10);
  });

  it("抛错只禁用所属回调，报错位置可读，其他脚本继续", async () => {
    const h = harness();
    let bad = 0,
      good = 0,
      applies = 0;
    h.realm.modules.set("bad", {
      update: () => {
        bad++;
        throw { message: "boom", stack: "at blob:file:///scene:3:7" };
      },
      applyUserProperties: () => {
        applies++;
      },
    });
    h.realm.modules.set("good", {
      update: () => {
        good++;
      },
    });
    await h.runtime.load({ list: [script("bad"), script("good")] });
    h.runtime.frame(0.1);
    h.runtime.frame(0.1);
    h.runtime.applyUserProperties({}, new Map());
    expect([bad, good, applies]).toEqual([1, 2, 1]);
    expect(h.logs.some((line) => line.includes("boom (line 3, col 7)"))).toBe(true);
  });

  it("callFor（P9b 视频结束回调）：进入那段脚本的上下文并恢复；出错只记诊断不禁用；不认识的脚本、停止之后不调", async () => {
    const h = harness();
    let updates = 0;
    h.realm.modules.set("one", {
      update: () => {
        updates++;
        // 嵌在别的脚本里调用时，结束后回到外层脚本
        h.runtime.callFor("two", () => seen.push(`nested:${h.runtime.currentScript?.id}`));
        seen.push(`after:${h.runtime.currentScript?.id}`);
      },
    });
    const seen: string[] = [];
    await h.runtime.load({ list: [script("one"), script("two")] });
    h.contexts.length = 0;
    h.runtime.callFor("two", () => seen.push(`call:${h.runtime.currentScript?.id}`));
    expect(seen).toEqual(["call:two"]);
    expect(h.contexts).toEqual(["two", null]);
    expect(h.runtime.currentScript).toBeNull();
    h.runtime.callFor("one", () => {
      throw { message: "boom", stack: "at blob:file:///scene:4:2" };
    });
    h.runtime.callFor("one", () => seen.push("again"));
    h.runtime.frame(0.1);
    h.runtime.frame(0.1);
    expect(updates).toBe(2);
    expect(seen).toEqual(["call:two", "again", "nested:two", "after:one", "nested:two", "after:one"]);
    const diagnostics = h.runtime.diagnostics as {
      id: string;
      disabled: string[];
      errors: string[];
      calls: Record<string, { count: number }>;
    }[];
    const one = diagnostics.find((item) => item.id === "one")!;
    expect(one.disabled).toEqual([]);
    expect(one.errors).toEqual(["ended: boom (line 4, col 2)"]);
    expect(one.calls.ended.count).toBe(2);
    expect(diagnostics.find((item) => item.id === "two")!.calls.ended.count).toBe(3);
    expect(h.logs).toContain("warn:场景脚本 one ended 出错：boom (line 4, col 2)");
    h.runtime.callFor("missing", () => seen.push("missing"));
    h.runtime.destroy();
    h.runtime.callFor("two", () => seen.push("halted"));
    expect(seen).toHaveLength(6);
  });

  it("15 秒边界只通过注入时钟测，超限回调返回值仍写回然后全停", async () => {
    const h = harness();
    let elapsed = 14_999;
    let calls = 0;
    h.realm.modules.set("one", {
      update: () => {
        calls++;
        h.setClock(elapsed);
        return calls;
      },
    });
    await h.runtime.load({ list: [script("one")] });
    h.runtime.frame(0.1);
    expect(h.runtime.stopped).toBe(false);
    elapsed = 30_000;
    h.runtime.frame(0.1);
    h.runtime.frame(0.1);
    expect(calls).toBe(2);
    expect(h.values.get("alpha")).toEqual([2]);
    expect(h.logs.filter((line) => line.startsWith("error:"))).toHaveLength(1);
  });

  it("重编译重放最后脚本写入，用户绑定覆盖后移除该目标", async () => {
    const h = harness();
    let init = 0;
    h.realm.modules.set("one", {
      init: () => {
        init++;
        return 7;
      },
    });
    await h.runtime.load({ list: [script("one")] });
    h.values.clear();
    h.runtime.replayWrites();
    expect(h.values.get("alpha")).toEqual([7]);
    h.runtime.forgetWrite("objects/0/alpha");
    h.values.set("alpha", [9]);
    h.runtime.replayWrites();
    expect(h.values.get("alpha")).toEqual([9]);
    expect(init).toBe(1);
  });

  it("不支持的写回目标只记录一次", async () => {
    const h = harness();
    h.realm.modules.set("one", { update: () => 3 });
    await h.runtime.load({ list: [script("one", { target: { kind: "unsupported", path: "objects/0/text" } })] });
    h.runtime.frame(0.1);
    h.runtime.frame(0.1);
    expect(h.logs.filter((line) => line.includes("写回目标暂不支持"))).toHaveLength(1);
  });
});

describe("脚本运行时的销毁", () => {
  it("加载途中销毁：还没跑的 init 不再跑", async () => {
    const realm = new FakeRealm();
    const { runtime } = harness(realm);
    const init = vi.fn();
    let finish!: (module: Record<string, unknown>) => void;
    realm.importModule = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const loading = runtime.load({ list: [script("a")] });
    runtime.destroy();
    finish({ init });
    await loading;
    expect(init).not.toHaveBeenCalled();
    expect(realm.disposed).toBe(true);
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const corpus = !!root && existsSync(wasm);
const reader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    try {
      return new Uint8Array(readFileSync(path).subarray(start, end));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
};

describe.skipIf(!corpus)("本机语料：脚本收集", () => {
  it("vortex、bedroom、shimmering 的坐标、目标与说明符", async () => {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const compile = (name: string) =>
      compileScene({
        projectDir: join(root!, "projects", "defaultprojects", name),
        sceneAssets: [join(root!, "assets")],
        reader,
        translator,
        exhaustive: true,
        postprocess: "enabled",
      });
    const vortex = await compile("razer_vortex");
    expect(vortex.scripts.list).toHaveLength(3);
    expect(
      vortex.scripts.list.every(
        (item) =>
          item.owner.kind === "material" &&
          item.target.kind === "constant" &&
          item.target.material === "colormode" &&
          item.initial === 0,
      ),
    ).toBe(true);
    const bedroom = await compile("razer_bedroom");
    expect(bedroom.scripts.list).toHaveLength(6);
    expect(
      bedroom.scripts.list.every(
        (item) =>
          item.target.kind === "constant" &&
          item.target.material === "color" &&
          item.valueType === "vec3" &&
          item.imports[0] === "WEColor",
      ),
    ).toBe(true);
    const shimmering = await compile("shimmering_particles");
    expect(shimmering.scripts.list).toHaveLength(1);
    expect(shimmering.scripts.list[0].owner.kind).toBe("general");
    expect(shimmering.scripts.list[0].target).toEqual({ kind: "bloom", field: "strength" });
  }, 120000);

  it("全部本机场景都生成脚本表并统计说明符与错误", async () => {
    const defaults = join(root!, "projects", "defaultprojects");
    const workshop = join(root!, "..", "..", "workshop", "content", "431960");
    const projects = readdirSync(defaults)
      .map((name) => join(defaults, name))
      .filter((dir) => {
        if (!existsSync(join(dir, "project.json"))) return false;
        if (existsSync(join(dir, "scene.pkg")) || existsSync(join(dir, "scene.json"))) return true;
        try {
          const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
          return (
            typeof project.file === "string" && project.file.endsWith(".json") && existsSync(join(dir, project.file))
          );
        } catch {
          return false;
        }
      });
    if (existsSync(workshop))
      projects.push(
        ...readdirSync(workshop)
          .map((id) => join(workshop, id))
          .filter((dir) => existsSync(join(dir, "scene.pkg"))),
      );
    let scenes = 0,
      segments = 0;
    const imports = new Set<string>();
    const errors: string[] = [];
    for (const dir of projects) {
      const bundle = await compileScene({
        projectDir: dir,
        sceneAssets: [join(root!, "assets")],
        reader,
        translator: null,
        postprocess: "disabled",
      });
      if (bundle.scripts.list.length) scenes++;
      segments += bundle.scripts.list.length;
      for (const item of bundle.scripts.list) {
        item.imports.forEach((name) => imports.add(name));
        item.errors.forEach((error) => errors.push(`${dir}: ${item.id}: ${error}`));
      }
    }
    console.info(
      `P3b 脚本语料：场景 ${projects.length}，含脚本 ${scenes}，段数 ${segments}，说明符 ${[...imports].sort().join(",")}，错误 ${errors.length}${errors.length ? `：${errors.join("；")}` : ""}`,
    );
    expect(segments).toBeGreaterThan(0);
  }, 120000);
});

describe("说明符与全量遍历", () => {
  it("非裸名记错，注释不误报，未启用 effect 与不可见层仍收集", async () => {
    const source = "// import 'Ignored'\nimport 'WEColor'; import './bad.js';";
    const scene = parseScene(
      JSON.stringify({
        objects: [
          {
            visible: false,
            effects: [
              { visible: false, passes: [{ constantshadervalues: { color: { script: source, value: "1 0 0" } } }] },
            ],
          },
        ],
      }),
    );
    const scripts = await collectScripts(scene, {}, []);
    expect(scripts.list).toHaveLength(1);
    expect(scripts.list[0].imports).toEqual(["WEColor"]);
    expect(scripts.list[0].errors).toHaveLength(1);
  });
});
