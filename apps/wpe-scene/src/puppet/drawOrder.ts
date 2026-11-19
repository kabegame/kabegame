/**
 * puppet 绘制组的绘制顺序（P12f，纯函数：无 GPU、无状态）。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase12/rea-p12f-draworder.md` 第 1–6 节与「对实现的含义」，实测 `ignore/p12/f/meas/REPORT.md`
 * （参考实现 `predict.py` 的 `Pup.step` 与 `clipping`）。
 * - 节点 = 网格 0 的一个绘制组（`FUN_14020ae00`）：`base` = 骨骼基数 + 组偏移（i32 加法，加载时算一次）；节点表保持组表顺序，加载时不排序；
 * - 键 = `cvttss2si(fround(fround(base) + cur[骨骼]))`，全程 float32、向零取整（NaN 与越界得 `−2147483648`）；
 * - `cur` 是 WPE 的 `P+0x280`：每帧复位成骨骼基数，再被每个可见层的绘制顺序轨道改写（覆盖 / 混合 / 加法，只取 lo 帧）；
 * - 重排：当前顺序已非降序什么都不做；否则**稳定**排序（只比键，并列保持当前顺序），结果跨帧保留。不是 `meshDrawOrder` 的 `std::sort`；
 * - 裁切命令表按「当前顺序里的位置」建（`clippingTable`），位置 p 的节点是 `order[p]`，编译期传组表顺序即 P12b1 的结果。
 */
import type { PuppetClipping } from "../compile/puppet";

const f = Math.fround;

/** 绘制组节点（rea-F 第 1 节）：base = 骨骼基数 + 组偏移（i32，加载时算一次）。 */
export interface DrawNode {
  base: number;
  bone: number;
  start: number;
  count: number;
}

/** 裁切记录（P12b1 的字段 + 嵌套父记录下标，rea-F 5.3）；list1 / list2 是节点下标（= 组表下标 = 项号）。 */
export interface DrawRecord {
  name: string;
  flags: number;
  list1: number[];
  list2: number[];
  parent: number;
}

/** x86 `cvttss2si`：向零取整，NaN 与 |x| ≥ 2³¹ 得 −2147483648。 */
export function cvttss2si(x: number): number {
  return x !== x || x >= 2147483648 || x < -2147483648 ? -2147483648 : Math.trunc(x) | 0;
}

/**
 * 一层写一次（rea-F 2.2，`0x1401ff280` 覆盖 / `0x1401ff762` 混合 / `0x1401fff35` 加法）：`mask[i]` 为 0 的骨骼跳过；`v = track[lo × tracks + i]`
 * （只取 lo 帧，不插值）；全程 float32：
 * - 覆盖：`cur = v`；
 * - 混合：`cur = f(f(f(1 − w)·cur) + f(v·w))`（`FUN_140178e00` 的运算顺序）；
 * - 加法：`s = f(f(f(v − f(base))·w) + cur)`，`cur = clamp(s, min(cur, v), max(cur, v))`，按汇编的比较顺序写（相等取 v、NaN 的走向同汇编），减的是骨骼基数。
 * 返回有没有写（有任一骨骼写过 = WPE 的 `r14 |= 4`：权重 0、暂停、单次层停在末帧都照写照置位）。
 */
export function blendDrawOrder(
  cur: Float32Array,
  base: Int32Array,
  track: Float32Array,
  mask: Uint8Array,
  tracks: number,
  lo: number,
  w: number,
  mode: "override" | "mix" | "add",
): boolean {
  let wrote = false;
  for (let i = 0; i < tracks; i++) {
    if (mask[i] === 0 || i >= cur.length) continue;
    const v = track[lo * tracks + i];
    const c = cur[i];
    if (mode === "override") cur[i] = v;
    else if (mode === "mix") cur[i] = f(f(f(1 - w) * c) + f(v * w));
    else {
      const s = f(f(f(v - f(base[i])) * w) + c);
      const hi = c > v ? c : v;
      const low = v > c ? c : v;
      const t = hi > s ? s : hi;
      cur[i] = low > t ? low : t;
    }
    wrote = true;
  }
  return wrote;
}

/**
 * 重排（rea-F 第 3 节，`0x140205507`）：先按**当前顺序**重算全部键（`keys` 按节点下标存），再判当前顺序是否非降序
 * （`is_sorted_until`，相邻 `keys[后] < keys[前]` 才算乱；相等算排好）：已非降序返回 false、不动 `order`；否则稳定排序（只比键）写回 `order` 并返回 true。
 */
export function reorder(order: Int32Array, nodes: readonly DrawNode[], cur: Float32Array, keys: Int32Array): boolean {
  for (let n = 0; n < nodes.length; n++) keys[n] = cvttss2si(f(f(nodes[n].base) + cur[nodes[n].bone]));
  let sorted = true;
  for (let k = 1; k < order.length; k++)
    if (keys[order[k]] < keys[order[k - 1]]) {
      sorted = false;
      break;
    }
  if (sorted) return false;
  // 稳定排序：JS `Array.prototype.sort` 自 ES2019 稳定，只比键，并列保持排序前（= 当前节点）顺序
  const next = Array.from(order).sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : 0));
  for (let k = 0; k < next.length; k++) order[k] = next[k];
  return true;
}

/** 按节点顺序拼整张网格的 u16 索引（WPE 重排时写主索引缓冲：各节点的 `[起点, 起点 + 数)` 依次接起来）。越过文件索引末尾的部分丢掉。 */
export function orderedIndices(
  order: ArrayLike<number>,
  nodes: readonly DrawNode[],
  indices: Uint16Array,
): Uint16Array {
  const out: number[] = [];
  for (let p = 0; p < order.length; p++) {
    const { start, count } = nodes[order[p]];
    for (let i = 0; i < count && start + i < indices.length; i++) out.push(indices[start + i]);
  }
  return Uint16Array.from(out);
}

/** mdl 索引字节（可能没对齐，一律小端 u16）拷成 `Uint16Array`。 */
export function fileIndices(bytes: Uint8Array): Uint16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint16Array(bytes.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

/**
 * 裁切命令表（`FUN_14020b720`，rea-F 第 5 节；原 `compile/puppet.ts` 的 `buildClipping` 的核心）：位置 p 的节点是 `order[p]`，`list1` / `list2` 按节点下标查，
 * 段内容按 `nodes[order[p]]` 的 start / count 取。编译期传组表顺序（结果与 P12b1 逐段相同），运行时传当前顺序。
 * - 每条记录：目标位置（`list1` 的节点所在位置）、首末遮罩位置（`list2`）、遮罩段 = 首末遮罩位置之间的全部位置减去本记录的目标，末遮罩位置沿嵌套链取最大；
 * - 沿位置走：不是目标的节点（含遮罩节点本身）累积成普通段，走到某条记录的末遮罩位置时先把累积的普通段落成一段，再发射这条记录
 *   （遮罩段 + 目标段，一条记录的多个 `list1` 节点合成一个目标段）；同一位置发射多条记录时按最小目标位置稳定排序；
 * - 纯目标节点不进普通段。记录 flags 非 0 的细节（bit2 / bit3）不复刻（编译期照报 `puppet:clipping:flags`）。
 */
export function clippingTable(
  order: ArrayLike<number>,
  nodes: readonly DrawNode[],
  records: readonly DrawRecord[],
  indices: Uint16Array,
): Pick<PuppetClipping, "commands" | "segments"> {
  const count = order.length;
  const target = nodes.map(() => false);
  const maskNode = nodes.map(() => false);
  for (const record of records) {
    for (const node of record.list1) target[node] = true;
    for (const node of record.list2) maskNode[node] = true;
  }
  interface Entry {
    record: number;
    minTarget: number;
    first: number;
    last: number;
    targets: number[];
    masks: number[];
  }
  const entries: Entry[] = records.map((record, index) => {
    const entry: Entry = { record: index, minTarget: 0x7fffffff, first: -1, last: -1, targets: [], masks: [] };
    for (let p = 0; p < count; p++) {
      const node = order[p];
      if (target[node] && record.list1.includes(node)) {
        entry.targets.push(p);
        entry.minTarget = Math.min(entry.minTarget, p);
      }
      if (record.list2.includes(node)) {
        if (entry.first < 0) entry.first = p;
        entry.last = p;
      }
    }
    for (let p = 0; p < count; p++)
      if (p >= entry.first && p <= entry.last && !entry.targets.includes(p)) entry.masks.push(p);
    return entry;
  });
  // 沿嵌套链取最大的末遮罩位置（0x14020bc33，下标按记录号、还没排序）；链上有环时最多走记录数步
  for (const entry of entries) {
    let j = records[entry.record].parent;
    for (let step = 0; j !== -1 && step < records.length; step++, j = records[j].parent)
      entry.last = Math.max(entry.last, entries[j].last);
  }
  entries.sort((a, b) => a.minTarget - b.minTarget); // 稳定排序，并列按记录下标

  const segments: Uint16Array[] = [];
  const commands: PuppetClipping["commands"] = [];
  const segment = (positions: readonly number[]): number => {
    const out: number[] = [];
    for (const p of positions) {
      const { start, count: n } = nodes[order[p]];
      for (let i = 0; i < n && start + i < indices.length; i++) out.push(indices[start + i]);
    }
    segments.push(Uint16Array.from(out));
    return segments.length - 1;
  };
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    commands.push({ kind: "normal", segment: segment(run) });
    run = [];
  };
  for (let p = 0; p < count; p++) {
    const node = order[p];
    if (!target[node]) run.push(p);
    if (!maskNode[node]) continue;
    for (const entry of entries) {
      if (entry.last !== p) continue;
      flush();
      const mask = segment(entry.masks);
      commands.push({ kind: "clip", record: entry.record, mask, target: segment(entry.targets) });
    }
  }
  flush();
  return { commands, segments };
}
