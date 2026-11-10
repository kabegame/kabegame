// P4b 步骤 4：TS 噪声实现与同目录的 noise_ref.py（Claude 照 rea C1–C3 独立写的 Python 参考）对拍。这一半生成随机 float32 输入、
// 用产品代码算结果，写 JSON；另一半 noise_xcheck.py 读它、用 noise_ref 算、逐位比较。运行（仓库根）：
//   node node_modules/vitest/vitest.mjs run --config apps/wpe-scene/scripts/fixtures/vitest.config.ts
//   python -X utf8 -I apps/wpe-scene/scripts/fixtures/noise_xcheck.py
// 输出路径取环境变量 NOISE_XCHECK_JSON，缺省 ignore/fixtures/noise-xcheck-ts.json（约 29 MB，不入库）。
// 对拍只证明两份实现一致，真值仍来自 WPE 轨迹（src/particles/noise.test.ts、replay.test.ts）。
// 原件：ignore/p4/b4/xcheck.test.ts（这里改成静态导入产品代码，输出路径参数化）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { snoise1, snoise2, snoise3 } from "../../src/particles/noise";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT = resolve(process.env.NOISE_XCHECK_JSON ?? join(REPO, "ignore/fixtures/noise-xcheck-ts.json"));

it("xcheck inputs", () => {
  const f32 = Math.fround;
  // 可复现的伪随机（mulberry32）
  let state = 12345;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const ranges = [1, 10, 100, 1000, 30000];
  const value = (i: number) => {
    const kind = i % 7;
    const range = ranges[i % ranges.length];
    if (kind === 0) return Math.round((next() * 2 - 1) * range); // 整数
    if (kind === 1) return Math.round((next() * 2 - 1) * range * 2) / 2; // 半整数
    return f32((next() * 2 - 1) * range);
  };
  const n = 200000;
  const one: number[][] = [];
  const two: number[][] = [];
  const three: number[][] = [];
  for (let i = 0; i < n; i++) {
    const x = f32(value(i));
    one.push([x, snoise1(x)]);
    const y = f32(value(i + 3));
    two.push([x, y, snoise2(x, y)]);
    let z = f32(value(i + 5));
    let w = y;
    // 每 5 个造一组坐标相等的输入（顶点顺序的相等分支）：b = c、a = b、a = c，或三者相等
    if (i % 5 === 0) z = y;
    if (i % 10 === 1) w = x;
    if (i % 20 === 2) {
      w = x;
      z = x;
    }
    three.push([x, w, z, snoise3(x, w, z)]);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ snoise1: one, snoise2: two, snoise3: three }));
});
