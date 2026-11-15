/**
 * P12b2-2 点 2、4：图像层 puppet 的纹理通道——`g_BlendMap` 运行时（`ScenePuppets.blendMap`，`.claude/plans/wpe-import/3-scene/phase12/phase-12b2-texchan-model.md`）。
 *
 * 样本 `fixtures/p12b2-tc.json`（生成脚本 `ignore/p12/b2/impl/mkfix_texchan.py`，WPE 抓帧 `ignore/p12/b2/gen/out`，实测报告 `ignore/p12/b2/meas/report.txt` 第 5 节）：
 * - 10 个图像层 puppet（覆盖、单个混合层、单个加法层、覆盖 + 加法、2 / 3 / 4 行、`DOUBLEBUFFERED` 0、覆盖全 0、没有 `animationlayers`），从第 1 帧起按日志 dt 推进，
 *   每个抓到的帧里 `g_BlendMap`（前 `4 × 行数` 个 float）逐位对 WPE；
 * - 规则：每帧不复位（单个混合层收敛到 v，不是 0.5·v）、加法层每帧累加 `fround(v·w)` 不钳制、覆盖层每帧重写、第 i 条轨道写第 i 个 float、超出 16 条的丢掉；
 * - 只在推进时写（`refresh` 不是 WPE 的更新，加法层不会被重复累加）、隐藏的层不写、重编译 `carryOver` 保留这 16 个 float、模型没有 `blendMap`。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, type ScenePuppet } from "../compile/puppet";
import tc from "./fixtures/p12b2-tc.json";
import { ScenePuppets, type PuppetSink } from "./player";
import { BLEND_MAP_FLOATS, blendChannels } from "./pose";

interface Draw {
  blendMap: number[];
  mvp: number[];
  texture1Resolution: number[];
  color4: number[];
}
interface FixtureObject {
  name: string;
  object: number;
  path: string;
  layers: unknown[];
  rows: number;
  draws: Record<string, Draw>;
}
interface Fixture {
  dt: number[];
  frames: number[];
  mdls: Record<string, string>;
  objects: FixtureObject[];
}
const fixture = tc as Fixture;
const byName = (name: string) => fixture.objects.find((item) => item.name === name)!;

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

function puppetOf(object: FixtureObject): ScenePuppet {
  const built = buildPuppet(parseMdl(mdlBytes(fixture.mdls[object.path])), object.layers, object.path);
  expect([...built.issues], object.name).toEqual([]);
  return built.puppet!;
}

const entries = () => fixture.objects.map((object) => ({ object: object.object, puppet: puppetOf(object) }));

/** 按日志的 dt 从第 1 帧推进，每个抓到的帧后回调一次。 */
function replay(puppets: ScenePuppets, at: (frame: number) => void, sink?: PuppetSink): void {
  const wanted = new Set(fixture.frames);
  const last = fixture.frames[fixture.frames.length - 1];
  for (let k = 1; k <= last; k++) {
    puppets.frame(fixture.dt[k - 1], sink);
    if (wanted.has(k)) at(k);
  }
}

describe("g_BlendMap 逐帧对 WPE（p12b2-tc：8 帧 × 10 个 puppet）", () => {
  it("从第 1 帧起按日志的 dt 推进，前 4 × 行数个 float 与 WPE 逐位相同（覆盖、混合、加法、2–4 行、没有层、全 0）", () => {
    const puppets = new ScenePuppets(entries());
    let compared = 0;
    replay(puppets, (k) => {
      for (const object of fixture.objects) {
        const want = object.draws[String(k)].blendMap;
        const got = puppets.blendMap(object.object)!;
        expect(want.length, object.name).toBe(4 * object.rows);
        for (let i = 0; i < want.length; i++)
          if (!Object.is(got[i], Math.fround(want[i])))
            expect.fail(`${object.name} 帧 ${k} [${i}]：得到 ${got[i]}，WPE ${Math.fround(want[i])}`);
        compared++;
      }
    });
    expect(compared).toBe(fixture.frames.length * fixture.objects.length);
  });

  it("行数 1–4：上传的 float 数是 4 / 8 / 12 / 16（前 4 × 行数个，其余的轨道值留在 16 个 float 里不上传）", () => {
    expect(fixture.objects.map((item) => [item.name, item.rows])).toEqual([
      ["tc_ovr", 1],
      ["tc_mix", 1],
      ["tc_add", 1],
      ["tc_ovradd", 1],
      ["tc_r2", 2],
      ["tc_r3", 3],
      ["tc_r4", 4],
      ["tc_db0", 1],
      ["tc_zero", 1],
      ["tc_nolayer", 1],
    ]);
    for (const name of ["tc_r2", "tc_r3", "tc_r4"]) {
      const object = byName(name);
      expect(puppetOf(object).animations[0].channels!.length, name).toBe(object.rows * 4);
    }
  });
});

describe("g_BlendMap 的规则（p12b2-tc 实测）", () => {
  const last = fixture.frames[fixture.frames.length - 1];
  const final = (name: string) => byName(name).draws[String(last)].blendMap;

  it("每帧不复位：单个混合层 0.5 收敛到 v（0.8, 0.4, 1, 0.2）；复位的话每帧都是 0.5·v", () => {
    const [a, b, c, d] = final("tc_mix");
    expect(a).toBeCloseTo(0.8, 6);
    expect(b).toBeCloseTo(0.4, 6);
    expect(c).toBeCloseTo(1, 6);
    expect(d).toBeCloseTo(0.2, 6);
  });

  it("加法层每帧累加 fround(v·w) 且不钳制：0.5 权重、v = (0.01, 0.02, 0, 0.001)，第 1 个通道早已超过 1", () => {
    const [a, b, c, d] = final("tc_add");
    expect(b).toBeGreaterThan(1.5);
    expect(a).toBeCloseTo(b / 2, 4);
    expect(c).toBe(0);
    expect(d).toBeGreaterThan(0);
    // 覆盖层每帧重写，不累加：0.3 覆盖 + 1.0 的加法 0.1 是 0.4，不随帧数涨
    for (const frame of fixture.frames)
      expect(byName("tc_ovradd").draws[String(frame)].blendMap[0]).toBeCloseTo(0.4, 6);
  });

  it("没有 animationlayers / 覆盖全 0：恒为 0（DOUBLEBUFFERED 下通道片元全丢）；DOUBLEBUFFERED 0 的 (0.5, 1.5, 0, 1) 原样（不钳制）", () => {
    expect(final("tc_nolayer")).toEqual([0, 0, 0, 0]);
    expect(final("tc_zero")).toEqual([0, 0, 0, 0]);
    expect(final("tc_db0")).toEqual([0.5, 1.5, 0, 1]);
  });

  it("没有动画层的 puppet：blendMap 是 16 个 0（不是 null），推进后仍是 0", () => {
    const puppets = new ScenePuppets(entries());
    const object = byName("tc_nolayer").object;
    expect(Array.from(puppets.blendMap(object)!)).toEqual(new Array(BLEND_MAP_FLOATS).fill(0));
    replay(puppets, () => {});
    expect(Array.from(puppets.blendMap(object)!)).toEqual(new Array(BLEND_MAP_FLOATS).fill(0));
  });

  it("第 i 条轨道写第 i 个 float：4 行 16 条轨道（(k + 1) / 16）写满 16 个 float，覆盖层和轨道值一一对应", () => {
    const want = byName("tc_r4").draws[String(last)].blendMap;
    expect(want.map((value) => Math.round(value * 16))).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });
});

describe("blendChannels：三种叠法（纯函数）", () => {
  const track = (a: number, b: number) => Float32Array.from([a, b, b]);

  it("覆盖 lerp(lo, hi, f)、混合 lerp(cur, v, w)、加法 cur + fround(v·w)（float32 逐步）", () => {
    const map = new Float32Array(BLEND_MAP_FLOATS);
    blendChannels(map, [track(0, 1), track(0, 1), track(0, 1)], 0, 1, 0.25, 1, false);
    expect(Array.from(map.subarray(0, 3))).toEqual([0.25, 0.25, 0.25]);
    map[1] = 0.5;
    blendChannels(map, [track(0, 1), track(1, 1), track(2, 2)], 0, 1, 0.5, 0.5, false);
    // 混合：lerp(cur, v, 0.5) = (1 − 0.5)·cur + v·0.5
    expect(Array.from(map.subarray(0, 3))).toEqual([Math.fround(0.5 * 0.25 + 0.5 * 0.5), 0.75, 1.125]);
    const added = new Float32Array(BLEND_MAP_FLOATS);
    blendChannels(added, [track(0.01, 0.01)], 0, 1, 0, 0.5, true);
    blendChannels(added, [track(0.01, 0.01)], 0, 1, 0, 0.5, true);
    expect(added[0]).toBe(Math.fround(Math.fround(Math.fround(0.01) * 0.5) + Math.fround(Math.fround(0.01) * 0.5)));
  });

  it("加法不钳制（超过 1、低于 0 都原样）；覆盖也不钳制", () => {
    const map = new Float32Array(BLEND_MAP_FLOATS);
    for (let i = 0; i < 5; i++) blendChannels(map, [track(1, 1), track(-1, -1)], 0, 1, 0, 1, true);
    expect(Array.from(map.subarray(0, 2))).toEqual([5, -5]);
    blendChannels(map, [track(1.5, 1.5), track(-0.3, -0.3)], 0, 1, 0, 1, false);
    expect(Array.from(map.subarray(0, 2))).toEqual([1.5, Math.fround(-0.3)]);
  });

  it("超出 16 条的轨道丢掉（WPE 越界写，语料 0），不写越界、不抛", () => {
    const map = new Float32Array(BLEND_MAP_FLOATS);
    blendChannels(
      map,
      Array.from({ length: 20 }, (_, i) => track(i + 1, i + 1)),
      0,
      1,
      0,
      1,
      false,
    );
    expect(Array.from(map)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it("权重恰为 1 才是覆盖：0.999 的非加法层是混合（保留 1 − w 的旧值）", () => {
    const map = new Float32Array(BLEND_MAP_FLOATS).fill(1);
    blendChannels(map, [track(0, 0)], 0, 1, 0, Math.fround(0.999), false);
    expect(map[0]).toBeCloseTo(0.001, 6);
  });
});

describe("ScenePuppets.blendMap：状态与时机", () => {
  const additive = byName("tc_add");
  const make = () => new ScenePuppets([{ object: additive.object, puppet: puppetOf(additive) }]);

  it("只在推进时写：refresh（建场景、探针 seek）不是 WPE 的更新，加法层不会被重复累加", () => {
    const puppets = make();
    puppets.frame(fixture.dt[0]);
    const once = Array.from(puppets.blendMap(additive.object)!);
    expect(once[0]).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) puppets.refresh();
    expect(Array.from(puppets.blendMap(additive.object)!)).toEqual(once);
    puppets.frame(fixture.dt[1]);
    expect(puppets.blendMap(additive.object)![0]).toBeGreaterThan(once[0]);
  });

  it("隐藏的层不写（visible 取状态里的值），没有可见层时保持上一帧", () => {
    const puppets = make();
    puppets.frame(fixture.dt[0]);
    const before = Array.from(puppets.blendMap(additive.object)!);
    const hidden: PuppetSink = { animationLayer: () => ({ rate: 1, blend: 0.5, visible: false }) };
    for (let k = 1; k < 5; k++) puppets.frame(fixture.dt[k], hidden);
    expect(Array.from(puppets.blendMap(additive.object)!)).toEqual(before);
  });

  it("carryOver（重编译）保留 16 个 float；没有上一份或同一份时不动", () => {
    const previous = make();
    for (let k = 0; k < 10; k++) previous.frame(fixture.dt[k]);
    const kept = Array.from(previous.blendMap(additive.object)!);
    expect(kept[0]).toBeGreaterThan(0);
    const next = make();
    expect(Array.from(next.blendMap(additive.object)!)).toEqual(new Array(BLEND_MAP_FLOATS).fill(0));
    next.carryOver(previous);
    expect(Array.from(next.blendMap(additive.object)!)).toEqual(kept);
    next.carryOver(next);
    next.carryOver(null);
    expect(Array.from(next.blendMap(additive.object)!)).toEqual(kept);
  });

  it("不是图像层 puppet 的对象、模型：blendMap 为 null（模型不处理通道轨道）", () => {
    const puppet = puppetOf(additive);
    const puppets = new ScenePuppets([{ object: 3, puppet, kind: "model" }]);
    expect(puppets.blendMap(3)).toBeNull();
    expect(puppets.blendMap(99)).toBeNull();
  });
});
