/**
 * P12f 点 4/5：puppet 绘制顺序的逐帧回放（`p12f-order` 的 16 个 puppet）。
 *
 * 夹具 `fixtures/p12f-order.json`（生成脚本 `ignore/p12/f/fix/mkfix_f.py`）：每个 puppet 的 mdl（gzip + base64）与 `animationlayers` 原值、WPE 日志的逐帧 dt
 * （第 k 帧在下标 k − 1）、脚本阶段的动作（第 210 帧：hide 的第 0 层设不可见、destroy 的第 0 层删掉，所以第 211 帧起的推进看到改过的层表）、
 * 采样帧 240 / 242 / 248 / 252 在 WPE 抓帧里的绘制（每次绘制是槽号列表：每 6 个索引一个四边形，槽 = 首索引 // 4；裁切 puppet 的普通命令是一次绘制、
 * 裁切命令是遮罩段 + 目标段两次）与 hist3 时钟骨骼的 T.x（= loop 的 lo + frac）。
 *
 * 做法：每个 puppet `parseMdl` + `buildPuppet`，建运行时，从第 1 帧按 dt 推进；采样帧先核对 hist3 的时钟，再把 `drawOrder(object)` 展开成绘制逐个比。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, type ScenePuppet } from "../compile/puppet";
import fixture from "./fixtures/p12f-order.json";
import { fileIndices } from "./drawOrder";
import { ScenePuppets, type PuppetLayerFields, type PuppetSink } from "./player";

interface FixturePuppet {
  name: string;
  object: number;
  mdl: string;
  layers: unknown[];
}
interface Fixture {
  puppets: FixturePuppet[];
  dt: number[];
  actions: { frame: number; puppet: string; op: "hide-layer" | "destroy-layer"; layer: number }[];
  clock: Record<string, number>;
  expect: Record<string, Record<string, number[][]>>;
}
const data = fixture as unknown as Fixture;
const SAMPLES = [240, 242, 248, 252];

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

function load(item: FixturePuppet): ScenePuppet {
  const { puppet, issues } = buildPuppet(parseMdl(mdlBytes(item.mdl)), item.layers, "p");
  expect([...issues], item.name).toEqual([]);
  return puppet!;
}

/** 当前绘制展开成「每次绘制的槽号列表」（每 6 个索引一个四边形，槽 = 首索引 // 4）。 */
function draws(runtime: ScenePuppets, object: number): number[][] {
  const out = runtime.drawOrder(object)!;
  const slots = (indices: Uint16Array): number[] => {
    expect(indices.length % 6).toBe(0);
    const list: number[] = [];
    for (let k = 0; k < indices.length; k += 6) list.push(indices[k] >> 2);
    return list;
  };
  if (!out.clipping) return [slots(out.indices)];
  const result: number[][] = [];
  for (const command of out.clipping.commands) {
    if (command.kind === "normal") result.push(slots(out.clipping.segments[command.segment]));
    else {
      result.push(slots(out.clipping.segments[command.mask]));
      result.push(slots(out.clipping.segments[command.target]));
    }
  }
  return result;
}

/** hide 的层从第 211 帧起不可见（脚本设 `visible = false`）；别的层用 def 的值。 */
function sinkFor(hidden: Set<number>): PuppetSink {
  return {
    animationLayer(object) {
      return hidden.has(object) ? ({ rate: 1, blend: 1, visible: false } satisfies PuppetLayerFields) : undefined;
    },
  };
}

const byName = new Map(data.puppets.map((item) => [item.name, item]));

describe("p12f-order：逐帧的绘制顺序与 WPE 抓帧逐个相同", () => {
  it("夹具：16 个 puppet、357 帧 dt、四个采样帧", () => {
    expect(data.puppets).toHaveLength(16);
    expect(data.dt.length).toBeGreaterThanOrEqual(252);
    expect(Object.keys(data.expect).map(Number)).toEqual(SAMPLES);
  });

  it("从第 1 帧按 dt 推进到 252：hist3 的时钟对上，每个采样帧每个 puppet 的绘制逐个相同", () => {
    const puppets = new ScenePuppets(data.puppets.map((item) => ({ object: item.object, puppet: load(item) })));
    const hidden = new Set<number>();
    const sink = sinkFor(hidden);
    const hist3 = byName.get("hist3")!;
    let compared = 0;
    for (let k = 1; k <= 252; k++) {
      puppets.frame(data.dt[k - 1], sink);
      // 脚本阶段的动作：下一帧的推进才看到
      for (const action of data.actions.filter((item) => item.frame === k)) {
        const object = byName.get(action.puppet)!.object;
        if (action.op === "hide-layer") hidden.add(object);
        else {
          expect(puppets.destroyLayers(object, { index: action.layer })).toBe(true);
          puppets.settle();
        }
      }
      if (!SAMPLES.includes(k)) continue;
      // 时钟：hist3 的层（id 2001 → 唯一的层）当前帧 = loop 的 lo + frac
      const id = puppets.ids(hist3.object)[0];
      const frame = puppets.control(hist3.object, id)!.getFrame();
      expect(frame, `帧 ${k} hist3 时钟`).toBeCloseTo(data.clock[String(k)], 3);
      for (const [name, want] of Object.entries(data.expect[String(k)])) {
        const object = byName.get(name)!.object;
        expect(draws(puppets, object), `帧 ${k} ${name}`).toEqual(want);
        compared++;
      }
    }
    // 240 帧 16 个 + 242 / 248 帧各 4 个 + 252 帧 5 个
    expect(compared).toBe(16 + 4 + 4 + 5);
  });

  it("没有层写过的 puppet（hide 之后）顺序保持：第 240 帧与第 211 帧开始前的顺序相同", () => {
    const puppets = new ScenePuppets([{ object: byName.get("hide")!.object, puppet: load(byName.get("hide")!) }]);
    const object = byName.get("hide")!.object;
    const hidden = new Set<number>();
    for (let k = 1; k <= 240; k++) {
      puppets.frame(data.dt[k - 1], sinkFor(hidden));
      if (k === 210) {
        hidden.add(object);
        // 隐藏前已经重排过：这个 puppet 的轨道每圈都会写
        expect(puppets.drawOrder(object)!.version).toBeGreaterThan(0);
      }
    }
    const versionAfter = puppets.drawOrder(object)!.version;
    const indices = Array.from(puppets.drawOrder(object)!.indices);
    puppets.frame(data.dt[240], sinkFor(hidden));
    expect(puppets.drawOrder(object)!.version).toBe(versionAfter);
    expect(Array.from(puppets.drawOrder(object)!.indices)).toEqual(indices);
  });
});

describe("绘制顺序运行时：refresh、carryOver", () => {
  const entry = (name: string) => {
    const item = byName.get(name)!;
    return { object: item.object, puppet: load(item) };
  };
  const advance = (puppets: ScenePuppets, frames: number) => {
    for (let k = 1; k <= frames; k++) puppets.frame(data.dt[k - 1]);
  };

  it("建运行时与 refresh 不写不排：版本 0、索引是文件顺序", () => {
    const { object, puppet } = entry("w0");
    const puppets = new ScenePuppets([{ object, puppet }]);
    const out = puppets.drawOrder(object)!;
    expect(out.version).toBe(0);
    const initial = Array.from(out.indices);
    // 初值是文件里的原样索引
    expect(initial).toEqual(Array.from(fileIndices(puppet.mesh.indices)));
    puppets.refresh();
    puppets.refresh();
    expect(puppets.drawOrder(object)!.version).toBe(0);
    expect(Array.from(puppets.drawOrder(object)!.indices)).toEqual(initial);
    // 推进一帧才真的重排（w0：权重 0 也写、基数算两次，第一帧就换序）
    puppets.frame(data.dt[0]);
    expect(puppets.drawOrder(object)!.version).toBe(1);
    expect(Array.from(puppets.drawOrder(object)!.indices)).not.toEqual(initial);
    // 之后 refresh 不动它
    const after = Array.from(puppets.drawOrder(object)!.indices);
    puppets.refresh();
    expect(puppets.drawOrder(object)!.version).toBe(1);
    expect(Array.from(puppets.drawOrder(object)!.indices)).toEqual(after);
  });

  it("没有 dynamic（没有 bit3）的 puppet 没有绘制顺序输出", () => {
    const { object, puppet } = entry("hist3");
    const stripped: ScenePuppet = { ...puppet, order: puppet.order ? { ...puppet.order, dynamic: false } : null };
    expect(new ScenePuppets([{ object, puppet: stripped }]).drawOrder(object)).toBeNull();
  });

  it("carryOver：节点表相同时接回当前顺序，版本接着旧的 +1；输出与旧的相同", () => {
    const { object, puppet } = entry("hist3");
    const first = new ScenePuppets([{ object, puppet }]);
    advance(first, 242);
    const old = first.drawOrder(object)!;
    expect(old.version).toBeGreaterThan(0);
    const oldVersion = old.version;
    const oldIndices = Array.from(old.indices);
    const second = new ScenePuppets([{ object, puppet }]);
    expect(second.drawOrder(object)!.version).toBe(0);
    second.carryOver(first);
    expect(second.drawOrder(object)!.version).toBe(oldVersion + 1);
    expect(Array.from(second.drawOrder(object)!.indices)).toEqual(oldIndices);
    // 之后继续推进，两边同一帧的结果相同（顺序是历史相关的，接回才对得上）
    for (let k = 243; k <= 252; k++) {
      first.frame(data.dt[k - 1]);
      second.frame(data.dt[k - 1]);
    }
    expect(draws(second, object)).toEqual(draws(first, object));
    expect(draws(second, object)).toEqual(data.expect["252"].hist3);
  });

  it("carryOver：带裁切的 puppet 命令表按接回的顺序重建", () => {
    const { object, puppet } = entry("clip_move");
    const first = new ScenePuppets([{ object, puppet }]);
    advance(first, 242);
    const second = new ScenePuppets([{ object, puppet }]);
    second.carryOver(first);
    expect(draws(second, object)).toEqual(data.expect["242"].clip_move);
  });

  it("carryOver：节点表变了（mdl 换了）从组表顺序重来，版本不接", () => {
    const { object, puppet } = entry("hist3");
    const first = new ScenePuppets([{ object, puppet }]);
    advance(first, 242);
    expect(first.drawOrder(object)!.version).toBeGreaterThan(0);
    const changed: ScenePuppet = {
      ...puppet,
      order: { ...puppet.order!, nodes: puppet.order!.nodes.map((node) => ({ ...node, base: node.base + 1 })) },
    };
    const second = new ScenePuppets([{ object, puppet: changed }]);
    second.carryOver(first);
    expect(second.drawOrder(object)!.version).toBe(0);
    expect(Array.from(second.drawOrder(object)!.indices)).toEqual(
      Array.from(new ScenePuppets([{ object, puppet }]).drawOrder(object)!.indices),
    );
  });

  it("不 carryOver（清空脚本存储）：顺序回到组表顺序，推进后重新开始", () => {
    const { object, puppet } = entry("hist3");
    const first = new ScenePuppets([{ object, puppet }]);
    advance(first, 242);
    const fresh = new ScenePuppets([{ object, puppet }]);
    expect(fresh.drawOrder(object)!.version).toBe(0);
    expect(Array.from(fresh.drawOrder(object)!.indices)).not.toEqual(Array.from(first.drawOrder(object)!.indices));
  });
});

describe("绘制顺序：哪些层会写（可见性与权重，合成 puppet）", () => {
  // 以 w0 的 mdl 为底（2 个节点：骨骼 0 基数 100、骨骼 1 基数 150 + 偏移，3 根骨骼，动画长 20），换成两条自己的绘制顺序轨道：
  // 轨道 A：骨骼 0 取 0、骨骼 1 取 −50 → 覆盖后键 100 / 100，已非降序，不重排；
  // 轨道 B：骨骼 0 取 100、骨骼 1 取 0 → 覆盖后键 200 / 150，要反过来。
  const base = load(byName.get("w0")!);
  const frames = 21;
  const track = (values: [number, number, number]) =>
    Float32Array.from({ length: frames * 3 }, (_, i) => values[i % 3]);
  const withTrack = (values: [number, number, number]) => ({
    ...base.animations[0],
    drawOrder: track(values),
    drawOrderMask: Uint8Array.of(1, 1, 1),
  });
  const layerDef = (entry: number, blend: number, visible = true) => ({
    ...base.layers[0],
    entry,
    blend,
    visible,
    name: `L${entry}`,
  });
  const object = 3;
  const make = (layers: ReturnType<typeof layerDef>[]) =>
    new ScenePuppets([
      {
        object,
        puppet: {
          ...base,
          animations: [withTrack([0, -50, 0]), withTrack([100, 0, 0])],
          layers: layers.map((l, i) => ({ ...l, animation: i === 0 ? 0 : 1 })),
        },
      },
    ]);
  const first6 = (puppets: ScenePuppets) => Array.from(puppets.drawOrder(object)!.indices.subarray(0, 6));

  it("不可见的层不写：可见层的键全相等不重排，隐藏层的轨道（会反序）被忽略；改成可见后才反序、version 1", () => {
    const puppets = make([layerDef(0, 1), layerDef(1, 1)]);
    const file = Array.from(puppets.drawOrder(object)!.indices);
    let bVisible = false;
    const sink: PuppetSink = {
      animationLayer: (_o, id) => (id === 1 ? { rate: 1, blend: 1, visible: bVisible } : undefined),
    };
    for (let k = 0; k < 10; k++) puppets.frame(0.05, sink);
    expect(puppets.drawOrder(object)!.version).toBe(0);
    expect(Array.from(puppets.drawOrder(object)!.indices)).toEqual(file);
    // 区分性：第 1 层可见后（排在后面的覆盖层盖掉第 0 层）键 200 / 150，反序
    bVisible = true;
    puppets.frame(0.05, sink);
    expect(puppets.drawOrder(object)!.version).toBe(1);
    expect(first6(puppets)).toEqual(file.slice(6, 12));
  });

  it("可见、权重 0（blend 0）的层照写照触发：混合不改 cur，基数算两次，键 200 / 150 → 反序", () => {
    const puppets = make([layerDef(0, 0), layerDef(1, 1, false)].slice(0, 1));
    // 单层用轨道 A 时键相等；换成 B 的轨道，blend 0 的混合 cur 不变（= 基数 [100, 0, 0]）→ 键 200 / 150
    const blended = new ScenePuppets([
      {
        object,
        puppet: { ...base, animations: [withTrack([100, 0, 0])], layers: [{ ...layerDef(0, 0), animation: 0 }] },
      },
    ]);
    const file = Array.from(blended.drawOrder(object)!.indices);
    blended.frame(0.05);
    expect(blended.drawOrder(object)!.version).toBe(1);
    expect(first6(blended)).toEqual(file.slice(6, 12));
    // 对照：同一层不可见时不触发
    const hidden = new ScenePuppets([
      {
        object,
        puppet: { ...base, animations: [withTrack([100, 0, 0])], layers: [{ ...layerDef(0, 0, false), animation: 0 }] },
      },
    ]);
    hidden.frame(0.05);
    expect(hidden.drawOrder(object)!.version).toBe(0);
    expect(puppets.drawOrder(object)!.version).toBe(0);
  });
});
