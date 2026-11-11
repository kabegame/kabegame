/**
 * 显示器布局图的几何：把一组屏的桌面矩形等比缩进一块给定大小的区域。
 *
 * 纯计算，不碰 DOM：`WallpaperScreenLayout.vue` 拿结果去摆绝对定位的块。输入坐标就是后端 `ScreenInfo` 的
 * 平台桌面坐标（左上原点；主屏左边、上边的屏坐标为负），单位无所谓，只用到相对位置与比例。
 */

/** 一块屏的桌面矩形。 */
export interface ScreenRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一块屏在布局图里的位置（CSS 像素，相对布局图左上角）。 */
export interface ScreenLayoutBox {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScreenLayout {
  /** 布局图本身的尺寸：所有屏的并集外接矩形缩放之后 */
  width: number;
  height: number;
  /** 桌面坐标 → CSS 像素的缩放 */
  scale: number;
  /** 与输入同序 */
  boxes: ScreenLayoutBox[];
}

const EMPTY_LAYOUT: ScreenLayout = { width: 0, height: 0, scale: 0, boxes: [] };

/**
 * 并集外接矩形 → 平移到原点 → 等比缩放到不超过 `maxWidth × maxHeight`。
 *
 * 各边先缩放再取整，相邻两块屏共用的那条边取到同一个整数，所以贴在一起的屏在图上不会重叠、也不会裂缝。
 *
 * @param screens - 在线屏；宽或高不是正数的条目忽略。
 * @param maxWidth - 可用宽度（CSS 像素）。
 * @param maxHeight - 可用高度（CSS 像素）。
 * @returns 没有可画的屏、或可用区域不是正数时，返回尺寸为 0 的空布局。
 *
 * @example
 * ```ts
 * // 主屏 1512×982，右边一块 1440×900、底边对齐
 * layoutScreens(
 *   [
 *     { id: "a", x: 0, y: 0, width: 1512, height: 982 },
 *     { id: "b", x: 1512, y: 82, width: 1440, height: 900 },
 *   ],
 *   600,
 *   140,
 * ).boxes[1]; // { id: "b", left: 216, top: 12, width: 205, height: 128 }
 * ```
 */
export function layoutScreens(screens: readonly ScreenRect[], maxWidth: number, maxHeight: number): ScreenLayout {
  const visible = screens.filter((screen) => screen.width > 0 && screen.height > 0);
  if (visible.length === 0 || !(maxWidth > 0) || !(maxHeight > 0)) return EMPTY_LAYOUT;

  const minX = Math.min(...visible.map((screen) => screen.x));
  const minY = Math.min(...visible.map((screen) => screen.y));
  const maxX = Math.max(...visible.map((screen) => screen.x + screen.width));
  const maxY = Math.max(...visible.map((screen) => screen.y + screen.height));
  const scale = Math.min(maxWidth / (maxX - minX), maxHeight / (maxY - minY));

  const boxes = visible.map((screen) => {
    const left = Math.round((screen.x - minX) * scale);
    const top = Math.round((screen.y - minY) * scale);
    const right = Math.round((screen.x + screen.width - minX) * scale);
    const bottom = Math.round((screen.y + screen.height - minY) * scale);
    return { id: screen.id, left, top, width: right - left, height: bottom - top };
  });
  return {
    width: Math.round((maxX - minX) * scale),
    height: Math.round((maxY - minY) * scale),
    scale,
    boxes,
  };
}
