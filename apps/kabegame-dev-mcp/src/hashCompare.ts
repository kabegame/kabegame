/**
 * 比两份画面哈希基线（`hash_baseline` 写出的文件，格式同旧 `hash-*.json`）。只读文件，不需要 vite。
 *
 * 场景按 `input.path` 对应（测试工程重新导入后图片 id 会变，目录不变）。算差异的：每档的 sha256、stable、postprocess、
 * bloomLevels、尺寸、格式，unsupported 按集合比；输入的 sceneAssets、用户属性、工程文件摘要；两边的 `time`。
 * 不算差异、单独列的：targetBytes、metadataId（值没变时只是换了行）、两边是同一份宿主产物的提醒。
 * 规则移植自 `ignore/p3c/step3/compare.mjs` 的哈希部分。
 */
import { readFileSync } from "node:fs";
import { comparablePath } from "../../../scripts/kabegame-dev/paths.ts";
import type { HashBaseline, HashLevelRecord, HashSceneRecord } from "../../../scripts/kabegame-dev/types.ts";

const LEVEL_FIELDS = ["sha256", "stable", "postprocess", "bloomLevels", "width", "height", "format"] as const;
const INPUT_FIELDS = ["sceneAssets", "userProperties", "projectFiles"] as const;

export interface BaselineDiff {
  /** `<目录>` 或 `<目录> <档位>`。 */
  where: string;
  field: string;
  a: unknown;
  b: unknown;
}

export interface CompareResult {
  /** 没有任何差异，且至少比了一组。 */
  same: boolean;
  /** 比了多少组（场景 × 档位）。 */
  cells: number;
  /** 对上的场景：目录与两边的图片 id。 */
  pairs: Array<{ path: string; a: string; b: string }>;
  diffs: BaselineDiff[];
  onlyInA: Array<{ id: string; path: string }>;
  onlyInB: Array<{ id: string; path: string }>;
  /** 单独列，不算差异。 */
  targetBytes: Array<{ where: string; a: number; b: number }>;
  metadataMoved: Array<{ path: string; a: unknown; b: unknown }>;
  hostBuild: { a: string | null; b: string | null; sameEntry: boolean };
  recordedAt: { a: string | null; b: string | null };
}

type Baseline = Pick<HashBaseline, "scenes"> & Partial<Omit<HashBaseline, "scenes">>;

/** 读基线文件：`hash_baseline` 写的原始基线，或任务结果 `{ ok, unstable, baseline }` 都认。 */
export function loadBaseline(file: string): Baseline {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`读不了基线 ${file}：${(error as Error).message}`);
  }
  const wrapped = (data as { baseline?: unknown })?.baseline;
  const baseline = (wrapped && typeof wrapped === "object" ? wrapped : data) as Baseline;
  if (!baseline || typeof baseline !== "object" || !baseline.scenes || typeof baseline.scenes !== "object") {
    throw new Error(`${file} 不是画面哈希基线（没有 scenes）`);
  }
  return baseline;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (list: unknown) => (Array.isArray(list) ? [...list].map(String).sort() : []);

function byPath(baseline: Baseline) {
  const map = new Map<string, { id: string; path: string; scene: HashSceneRecord }>();
  const duplicates: Array<{ id: string; path: string }> = [];
  for (const [id, scene] of Object.entries(baseline.scenes)) {
    const p = scene?.input?.path;
    const key = p ? comparablePath(p) : `(无路径 ${id})`;
    if (map.has(key)) duplicates.push({ id, path: p ?? "" });
    else map.set(key, { id, path: p ?? "", scene });
  }
  return { map, duplicates };
}

export function compareBaselines(a: Baseline, b: Baseline): CompareResult {
  const result: CompareResult = {
    same: false,
    cells: 0,
    pairs: [],
    diffs: [],
    onlyInA: [],
    onlyInB: [],
    targetBytes: [],
    metadataMoved: [],
    hostBuild: {
      a: a.hostBuild?.entry ?? null,
      b: b.hostBuild?.entry ?? null,
      sameEntry: !!a.hostBuild?.entry && a.hostBuild.entry === b.hostBuild?.entry,
    },
    recordedAt: { a: a.recordedAt ?? null, b: b.recordedAt ?? null },
  };
  const diff = (where: string, field: string, x: unknown, y: unknown) =>
    result.diffs.push({ where, field, a: x, b: y });
  if (!same(a.time, b.time)) diff("基线", "time", a.time, b.time);

  const left = byPath(a);
  const right = byPath(b);
  for (const d of left.duplicates) diff(d.path, "重复", `A 里 ${d.id} 与另一张同目录`, null);
  for (const d of right.duplicates) diff(d.path, "重复", null, `B 里 ${d.id} 与另一张同目录`);

  for (const [key, x] of left.map) {
    const y = right.map.get(key);
    if (!y) {
      result.onlyInA.push({ id: x.id, path: x.path });
      continue;
    }
    result.pairs.push({ path: x.path, a: x.id, b: y.id });
    const ia = x.scene.input ?? ({} as HashSceneRecord["input"]);
    const ib = y.scene.input ?? ({} as HashSceneRecord["input"]);
    for (const field of INPUT_FIELDS) {
      if (!same(ia[field], ib[field])) diff(x.path, `输入 ${field}`, ia[field], ib[field]);
    }
    if (!same(ia.metadataId, ib.metadataId)) {
      result.metadataMoved.push({ path: x.path, a: ia.metadataId, b: ib.metadataId });
    }
    const levels = [...new Set([...Object.keys(x.scene.levels ?? {}), ...Object.keys(y.scene.levels ?? {})])];
    for (const level of levels) {
      const where = `${x.path} ${level}`;
      const la: HashLevelRecord | undefined = x.scene.levels?.[level];
      const lb: HashLevelRecord | undefined = y.scene.levels?.[level];
      if (!la || !lb) {
        diff(where, "档位", la ? "有" : "无", lb ? "有" : "无");
        continue;
      }
      result.cells++;
      for (const field of LEVEL_FIELDS) if (!same(la[field], lb[field])) diff(where, field, la[field], lb[field]);
      if (!same(sorted(la.unsupported), sorted(lb.unsupported))) {
        diff(where, "unsupported", sorted(la.unsupported), sorted(lb.unsupported));
      }
      if (la.targetBytes !== lb.targetBytes) result.targetBytes.push({ where, a: la.targetBytes, b: lb.targetBytes });
    }
  }
  for (const [key, y] of right.map) if (!left.map.has(key)) result.onlyInB.push({ id: y.id, path: y.path });

  result.same = result.cells > 0 && !result.diffs.length && !result.onlyInA.length && !result.onlyInB.length;
  return result;
}

const short = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "（无）";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

/** 给人看的结论（差异最多列 `maxDiffs` 条）。 */
export function formatCompare(result: CompareResult, maxDiffs = 100): string {
  const lines: string[] = [];
  const scenes = result.pairs.length;
  if (result.same) {
    lines.push(`相同：${scenes} 张场景、${result.cells} 组（场景 × 档位）的哈希、unsupported、尺寸与输入全部相同`);
  } else {
    const problems = result.diffs.length + result.onlyInA.length + result.onlyInB.length;
    lines.push(`有差异：${problems} 处（对上 ${scenes} 张、比了 ${result.cells} 组）`);
  }
  const { a, b, sameEntry } = result.hostBuild;
  lines.push(
    `宿主产物：A ${a ?? "?"}（${result.recordedAt.a ?? "?"}），B ${b ?? "?"}（${result.recordedAt.b ?? "?"}）`,
  );
  if (sameEntry) lines.push("提醒：两边是同一份宿主产物，相同只说明结果可复现，不能证明实现没有改变结果");
  for (const item of result.onlyInA) lines.push(`只在 A：${item.id} ${item.path}`);
  for (const item of result.onlyInB) lines.push(`只在 B：${item.id} ${item.path}`);
  for (const item of result.diffs.slice(0, maxDiffs)) {
    lines.push(`差异 ${item.where} ${item.field}：${short(item.a)} → ${short(item.b)}`);
  }
  if (result.diffs.length > maxDiffs) lines.push(`……还有 ${result.diffs.length - maxDiffs} 条差异没列出`);
  if (result.metadataMoved.length) {
    lines.push(
      "metadataId 变了（不算差异；上面没报输入差异就是属性值没变）：" +
        result.metadataMoved.map((m) => `${m.path}: ${m.a} → ${m.b}`).join("，"),
    );
  }
  if (result.targetBytes.length) {
    lines.push(
      "targetBytes 变了（不算差异）：" + result.targetBytes.map((t) => `${t.where}: ${t.a} → ${t.b}`).join("，"),
    );
  }
  return lines.join("\n");
}
