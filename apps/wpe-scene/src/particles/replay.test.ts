/**
 * 固定数据回放（P4a 步骤 3）：从 WPE 的 RenderDoc 轨迹截出的短片段（`fixtures/`，来源写在每个文件的 `source`，由
 * `apps/wpe-scene/scripts/fixtures/make_replay_fixtures.py` 生成），按同一 dt 序列步进模拟器、逐帧比。不依赖 `ignore/`。
 * P4b 步骤 4 加了 `positionoffsetrandom` 的两段（`p4b-posoffset60` / `10`，同目录的 `make_noise_fixtures.py` 生成），带每帧的
 * 场景时间 `times`（日志 runtime 列）。
 *
 * 配对同 `ignore/p4/cmp_track.py`：按帧号、同一系统内按数组（槽）顺序；另要求每帧粒子数、系统出现与否都相同。
 * 限：位置 1e-3（坐标大于 1000 的系统 2e-3，float32 精度），尺寸 1e-3，颜色、alpha 2e-3，旋转 1e-3。
 */
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../compile/model";
import { parseParticle } from "../compile/particles";
import { particleTrack, type ParticleTrackParticle } from "./track";
import fps10 from "./fixtures/fps10.json";
import fps60 from "./fixtures/fps60.json";
import p4a2 from "./fixtures/p4a2.json";
import posoffset10 from "./fixtures/p4b-posoffset10.json";
import posoffset60 from "./fixtures/p4b-posoffset60.json";
import s15 from "./fixtures/s15.json";
import s60 from "./fixtures/s60.json";

interface Fixture {
  source: string;
  tag: string;
  passes: 1 | 2;
  systems: Record<string, { particle: JsonObject; instanceoverride?: unknown }>;
  dts: number[];
  /** 每帧的场景时间（`g_Time`），和 `dts` 等长；没有时按 `dts` 累加。 */
  times?: number[];
  frames: { frame: number; systems: Record<string, ParticleTrackParticle[]> }[];
}

const FIXTURES = [fps60, fps10, s15, s60, p4a2, posoffset60, posoffset10] as unknown as Fixture[];
const LIMITS = { size: 1e-3, color: 2e-3, alpha: 2e-3, rot: 1e-3 };

function maxDiff(a: number | number[], b: number | number[]): number {
  return Array.isArray(a)
    ? Math.max(...a.map((v, i) => Math.abs(v - (b as number[])[i])))
    : Math.abs(a - (b as number));
}

describe("固定数据回放：和 WPE 逐帧比", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.tag}（${fixture.passes} 遍）：${Object.keys(fixture.systems).join("、")}`, () => {
      const layers = Object.entries(fixture.systems).map(([name, entry], object) => ({
        object,
        name,
        particle: parseParticle(entry.particle, {
          file: `${name}.json`,
          orthographic: true,
          instanceoverride: entry.instanceoverride,
        }),
      }));
      const track = particleTrack({
        layers,
        dts: fixture.dts,
        times: fixture.times,
        frames: fixture.frames.map((frame) => frame.frame),
        passes: fixture.passes,
      });
      expect(track.skipped).toEqual({});
      const worst: Record<string, Record<string, number>> = {};
      track.frames.forEach((simFrame, i) => {
        const truth = fixture.frames[i];
        expect(simFrame.frame).toBe(truth.frame);
        expect(Object.keys(simFrame.systems).sort(), `第 ${truth.frame} 帧出现的系统`).toEqual(
          Object.keys(truth.systems).sort(),
        );
        for (const [name, expected] of Object.entries(truth.systems)) {
          const actual = simFrame.systems[name];
          expect(actual.length, `${name} 第 ${truth.frame} 帧的粒子数`).toBe(expected.length);
          const coordinate = Math.max(
            ...fixture.frames.flatMap((f) => (f.systems[name] ?? []).flatMap((p) => p.pos.map(Math.abs))),
          );
          const limits = { pos: coordinate > 1000 ? 2e-3 : 1e-3, ...LIMITS };
          expected.forEach((particle, j) => {
            for (const key of ["pos", "size", "color", "alpha", "rot"] as const) {
              const diff = maxDiff(particle[key], actual[j][key]);
              worst[name] ??= {};
              worst[name][key] = Math.max(worst[name][key] ?? 0, diff);
              expect(diff, `${name} 第 ${truth.frame} 帧第 ${j} 个粒子的 ${key}`).toBeLessThanOrEqual(limits[key]);
            }
          });
        }
      });
      expect(Object.keys(worst).sort()).toEqual(Object.keys(fixture.systems).sort());
    });
  }
});
