/**
 * 平铺的格子（桌面壁纸的视频平铺用，`VideoTile.vue`）：和图片平铺的 CSS 背景同一规则——等比放进画布（`contain`），
 * 居中一格，再向四周重复到铺满（`repeat` + `center`）。
 *
 * 坐标是画布的设备像素；格子的边取整，相邻两格共用一条边，画出来没有缝。画布外的格子不给。
 */
export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一条轴上的格子边：从 ≤ 0 的第一条起，到 ≥ extent 的那条为止（含）。 */
function tileEdges(extent: number, size: number): number[] {
  const origin = (extent - size) / 2;
  // 居中那格左边之外还要补几格；减一点容差，正好放满时不多出一格画在画布外
  const first = origin - Math.ceil(origin / size - 1e-6) * size;
  const edges: number[] = [];
  for (let i = 0; ; i++) {
    const edge = first + i * size;
    edges.push(Math.round(edge));
    if (edge >= extent - 1e-6) break;
  }
  return edges;
}

export function tileRects(width: number, height: number, mediaWidth: number, mediaHeight: number): TileRect[] {
  if (!(width > 0 && height > 0 && mediaWidth > 0 && mediaHeight > 0)) return [];
  const scale = Math.min(width / mediaWidth, height / mediaHeight);
  const xs = tileEdges(width, mediaWidth * scale);
  const ys = tileEdges(height, mediaHeight * scale);
  const rects: TileRect[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const w = xs[i + 1] - xs[i];
      const h = ys[j + 1] - ys[j];
      if (w > 0 && h > 0) rects.push({ x: xs[i], y: ys[j], width: w, height: h });
    }
  }
  return rects;
}
