// 画廊 Provider 路径计算（与后端 AllProvider 的贪心分解保持一致）

const LEAF_SIZE = 1000;
const GROUP_SIZE = 10;

export interface GreedyRange {
  offset: number; // 0-based
  count: number;
}

function getRangeSizes(total: number): number[] {
  const sizes: number[] = [];
  let size = LEAF_SIZE;
  while (size <= total) {
    sizes.push(size);
    size *= GROUP_SIZE;
  }
  return sizes.reverse();
}

export function greedyDecompose(total: number): GreedyRange[] {
  const ranges: GreedyRange[] = [];
  const sizes = getRangeSizes(total);
  let pos = 0;

  for (const size of sizes) {
    // 跳过与 total 完全相等的范围，避免出现“目录里还是同名目录”的无限嵌套
    if (size === total) continue;

    while (pos + size <= total) {
      ranges.push({ offset: pos, count: size });
      pos += size;
    }
  }

  return ranges;
}

export function rangeName(offset: number, count: number): string {
  // 目录名是 1-based
  return `${offset + 1}-${offset + count}`;
}

/**
 * 给定 total 与 page（从 1 开始），返回“该页对应的 leaf 节点”路径。
 *
 * - providerRoot: `all` / `by-plugin/konachan` / `by-date/2024-01`
 * - page: 1-based，按 1000 张一页
 */
export function buildLeafProviderPathForPage(
  providerRoot: string,
  total: number,
  page: number
): { path: string; baseOffset: number; rangeTotal: number } {
  if (!providerRoot || providerRoot.trim().length === 0) {
    throw new Error("providerRoot 不能为空");
  }
  if (total <= 0) {
    return { path: providerRoot, baseOffset: 0, rangeTotal: 0 };
  }
  const safePage = Math.max(1, Math.floor(page || 1));
  const offset = (safePage - 1) * LEAF_SIZE;
  if (offset >= total) {
    throw new Error("页码超出范围");
  }

  let localOffset = offset; // 相对当前节点
  let baseOffset = 0;
  let rangeTotal = total;
  const segs: string[] = [];

  while (rangeTotal > LEAF_SIZE) {
    const ranges = greedyDecompose(rangeTotal);
    const covered = ranges.reduce((sum, r) => sum + r.count, 0);

    if (localOffset >= covered) {
      // 落在 remainder（直接文件列表）里：这一定是最后一页（offset 按 1000 对齐）
      baseOffset += covered;
      localOffset -= covered;
      rangeTotal = rangeTotal - covered;
      break;
    }

    const hit = ranges.find(
      (r) => localOffset >= r.offset && localOffset < r.offset + r.count
    );
    if (!hit) {
      throw new Error("无法定位页码对应的范围目录");
    }

    segs.push(rangeName(hit.offset, hit.count));
    baseOffset += hit.offset;
    localOffset -= hit.offset;
    rangeTotal = hit.count;
  }

  const path =
    segs.length > 0 ? `${providerRoot}/${segs.join("/")}` : providerRoot;
  return { path, baseOffset, rangeTotal };
}
