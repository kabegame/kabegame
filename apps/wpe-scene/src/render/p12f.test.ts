/**
 * P12f 点 5 的渲染侧纯函数（`render/puppet.ts`）：给定当前命令表与段，算出每个裁切模板该写的段、`count`、哪些槽位 `count = 0`，以及编码的绘制序列。
 *
 * - 手算的命令表：普通命令数 1 ↔ 2 变化、两条记录换序（`clip_two` 两种状态的形状）；
 * - 夹具回放：`puppet/fixtures/p12f-order.json` 的 `clip_move`、`clip_two` 按 WPE 的 dt 推进，采样帧的 `drawOrder(object)` 经
 *   `clipTemplateSegments` + `clipDrawSequence` 展开成的绘制（去掉清遮罩）与 WPE 抓帧逐个相同——就是渲染器编码时会画出来的那个序列。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet, type PuppetClipping } from "../compile/puppet";
import fixture from "../puppet/fixtures/p12f-order.json";
import { ScenePuppets } from "../puppet/player";
import { clipDrawSequence, clipTemplateSegments, indexUpload, puppetIndexCapacity } from "./puppet";

type Table = Pick<PuppetClipping, "commands" | "segments">;
const seg = (...values: number[]) => Uint16Array.from(values);

describe("clipTemplateSegments / clipDrawSequence：手算的命令表", () => {
  /** 普通 / 记录 0 / 记录 1 / 普通：两个普通命令，槽位 3 个（记录数 + 1）。 */
  const two: Table = {
    commands: [
      { kind: "normal", segment: 0 },
      { kind: "clip", record: 0, mask: 1, target: 2 },
      { kind: "clip", record: 1, mask: 3, target: 4 },
      { kind: "normal", segment: 5 },
    ],
    segments: [seg(1), seg(2, 2), seg(3, 3, 3), seg(4), seg(5, 5), seg(6, 6, 6, 6)],
  };

  it("两个普通命令：第 0、1 个槽位取各自的段，第 2 个槽位 count 0；遮罩 / 目标按记录号", () => {
    const out = clipTemplateSegments(two, 3, 2);
    expect(out.normals.map((item) => Array.from(item))).toEqual([[1], [6, 6, 6, 6], []]);
    expect(out.masks.map((item) => Array.from(item))).toEqual([[2, 2], [4]]);
    expect(out.targets.map((item) => Array.from(item))).toEqual([
      [3, 3, 3],
      [5, 5],
    ]);
    expect(clipDrawSequence(two.commands, 3, 2)).toEqual([
      { part: "normal", index: 0 },
      { part: "clear", index: 0 },
      { part: "mask", index: 0 },
      { part: "target", index: 0 },
      { part: "clear", index: 1 },
      { part: "mask", index: 1 },
      { part: "target", index: 1 },
      { part: "normal", index: 1 },
    ]);
  });

  it("普通命令数从 2 变 1、两条记录换序（记录 1 在前）：槽位 1、2 都空，记录号对应的遮罩 / 目标不变", () => {
    const moved: Table = {
      commands: [
        { kind: "normal", segment: 0 },
        { kind: "clip", record: 1, mask: 1, target: 2 },
        { kind: "clip", record: 0, mask: 3, target: 4 },
      ],
      segments: [seg(1), seg(2), seg(3, 3), seg(4, 4, 4), seg(5, 5, 5, 5)],
    };
    const out = clipTemplateSegments(moved, 3, 2);
    expect(out.normals.map((item) => item.length)).toEqual([1, 0, 0]);
    // 记录 1 先发射：遮罩 / 目标是第 1、2 段；记录 0 是第 3、4 段
    expect(out.masks.map((item) => item.length)).toEqual([3, 1]);
    expect(out.targets.map((item) => item.length)).toEqual([4, 2]);
    expect(clipDrawSequence(moved.commands, 3, 2).map((item) => `${item.part}${item.index}`)).toEqual([
      "normal0",
      "clear1",
      "mask1",
      "target1",
      "clear0",
      "mask0",
      "target0",
    ]);
  });

  it("命令表里没出现的记录：遮罩与目标都 count 0，序列里也没有它（不清遮罩）", () => {
    const one: Table = { commands: [{ kind: "clip", record: 1, mask: 0, target: 1 }], segments: [seg(7), seg(8, 8)] };
    const out = clipTemplateSegments(one, 3, 2);
    expect(out.masks.map((item) => item.length)).toEqual([0, 1]);
    expect(out.targets.map((item) => item.length)).toEqual([0, 2]);
    expect(out.normals.every((item) => item.length === 0)).toBe(true);
    expect(clipDrawSequence(one.commands, 3, 2).map((item) => `${item.part}${item.index}`)).toEqual([
      "clear1",
      "mask1",
      "target1",
    ]);
  });

  it("多出槽位 / 记录数的命令（合法的表不会有）忽略；段号越界当空段", () => {
    const odd: Table = {
      commands: [
        { kind: "normal", segment: 0 },
        { kind: "normal", segment: 1 },
        { kind: "clip", record: 5, mask: 0, target: 0 },
        { kind: "normal", segment: 9 },
      ],
      segments: [seg(1), seg(2)],
    };
    expect(clipTemplateSegments(odd, 1, 1).normals.map((item) => Array.from(item))).toEqual([[1]]);
    expect(clipDrawSequence(odd.commands, 1, 1)).toEqual([{ part: "normal", index: 0 }]);
    expect(clipTemplateSegments(odd, 3, 1).normals.map((item) => item.length)).toEqual([1, 1, 0]);
  });
});

describe("模板索引缓冲的容量与上传", () => {
  it("容量 = 总索引数 × 2，补到 4 的倍数、至少 4", () => {
    expect(puppetIndexCapacity(0)).toBe(4);
    expect(puppetIndexCapacity(1)).toBe(4);
    expect(puppetIndexCapacity(2)).toBe(4);
    expect(puppetIndexCapacity(3)).toBe(8);
    expect(puppetIndexCapacity(6)).toBe(12);
  });

  it("上传字节补到 4 的倍数（奇数个 u16 多一个 0、不进 count）；空段是 4 字节的 0；超出容量的截掉", () => {
    const odd = indexUpload(seg(1, 2, 3), 12);
    expect(odd.count).toBe(3);
    expect(Array.from(new Uint16Array(odd.bytes.buffer))).toEqual([1, 2, 3, 0]);
    const empty = indexUpload(seg(), 4);
    expect(empty.count).toBe(0);
    expect(empty.bytes.byteLength).toBe(4);
    const cut = indexUpload(seg(1, 2, 3, 4, 5), 6);
    expect(cut.count).toBe(3);
    expect(Array.from(new Uint16Array(cut.bytes.buffer, 0, 3))).toEqual([1, 2, 3]);
  });
});

// ———— 夹具回放 ————

interface FixturePuppet {
  name: string;
  object: number;
  mdl: string;
  layers: unknown[];
}
const data = fixture as unknown as {
  puppets: FixturePuppet[];
  dt: number[];
  expect: Record<string, Record<string, number[][]>>;
};
const SAMPLES = [240, 242, 248, 252];
const byName = new Map(data.puppets.map((item) => [item.name, item]));

/** 渲染器编码时会画的绘制序列（`clipDrawSequence` 展开，去掉清遮罩），每次绘制是槽号列表（每 6 个索引一个四边形，槽 = 首索引 // 4）。 */
function encoded(runtime: ScenePuppets, object: number, records: number): { draws: number[][]; normals: number } {
  const order = runtime.drawOrder(object)!;
  const clipping = order.clipping!;
  const slots = (indices: Uint16Array): number[] => {
    const list: number[] = [];
    for (let k = 0; k < indices.length; k += 6) list.push(indices[k] >> 2);
    return list;
  };
  const out = clipTemplateSegments(clipping, records + 1, records);
  const draws: number[][] = [];
  let normals = 0;
  for (const { part, index } of clipDrawSequence(clipping.commands, records + 1, records)) {
    if (part === "clear") continue;
    if (part === "normal") normals++;
    draws.push(slots((part === "normal" ? out.normals : part === "mask" ? out.masks : out.targets)[index]));
  }
  return { draws, normals };
}

describe("夹具回放：模板展开的绘制与 WPE 抓帧逐个相同（clip_move、clip_two）", () => {
  for (const name of ["clip_move", "clip_two"]) {
    it(`${name}：第 240 / 242 / 248 / 252 帧`, () => {
      const item = byName.get(name)!;
      const { puppet, issues } = buildPuppet(
        parseMdl(new Uint8Array(gunzipSync(Buffer.from(item.mdl, "base64")))),
        item.layers,
        "p",
      );
      expect([...issues]).toEqual([]);
      const records = puppet!.clipping!.records.length;
      const puppets = new ScenePuppets([{ object: item.object, puppet: puppet! }]);
      const normalCounts = new Set<number>();
      let compared = 0;
      for (let k = 1; k <= 252; k++) {
        puppets.frame(data.dt[k - 1]);
        if (!SAMPLES.includes(k) || !data.expect[String(k)][name]) continue;
        const { draws, normals } = encoded(puppets, item.object, records);
        expect(draws, `帧 ${k}`).toEqual(data.expect[String(k)][name]);
        normalCounts.add(normals);
        compared++;
      }
      expect(compared).toBeGreaterThan(0);
      // clip_move 的普通命令数在 1 与 2 之间变（槽位数 记录数 + 1 要装得下），clip_two 一直是 2
      expect([...normalCounts].sort()).toEqual(name === "clip_move" ? [1, 2] : [2]);
    });
  }
});
