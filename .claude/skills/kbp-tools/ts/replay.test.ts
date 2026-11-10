/**
 * kbp replay 的 vitest 入口：每个案例一个 it。参数经环境变量（kbp.py 设）：
 *   KBP_SRC    产品源码目录（快照的 src/），绝对路径
 *   KBP_DATA   数据目录（cases/、proj/、tracks/、out/）
 *   KBP_OUT    报告目录
 *   KBP_CASES  逗号分隔的案例名
 * 每个案例写 <KBP_OUT>/<名字>.txt、.json（结果）与 <名字>.meta.json（源码、耗时、错误）。案例「有失败」不让测试失败（那是结果）；
 * 案例跑不下去（钩子或产品接口出错）才失败，错误写进 meta。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadCase, needsApprox, registerMocks, runCase, slash } from "./replayLib";

const SRC = slash(path.resolve(process.env.KBP_SRC ?? "apps/wpe-scene/src"));
const DATA = path.resolve(process.env.KBP_DATA ?? "ignore/p4");
const OUT = path.resolve(process.env.KBP_OUT ?? path.join(DATA, "out", "replay"));
const CASES = (process.env.KBP_CASES ?? "").split(",").filter(Boolean);

if (!CASES.length) it("没有案例", () => expect.fail("KBP_CASES 为空"));

for (const name of CASES) {
  it(name, async () => {
    const started = performance.now();
    const meta: Record<string, unknown> = { case: name, src: SRC, data: DATA };
    mkdirSync(OUT, { recursive: true });
    try {
      const spec = loadCase(DATA, name);
      vi.resetModules();
      registerMocks(SRC, needsApprox(spec));
      const report = await runCase(SRC, DATA, spec, OUT);
      meta.ok = report.ok;
      meta.sections = report.sections.length;
    } catch (error) {
      meta.error = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
      throw error;
    } finally {
      meta.seconds = Number(((performance.now() - started) / 1000).toFixed(2));
      writeFileSync(path.join(OUT, `${name}.meta.json`), JSON.stringify(meta, null, 1) + "\n");
    }
  });
}
