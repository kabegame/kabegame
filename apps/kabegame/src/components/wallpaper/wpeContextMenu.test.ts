import { describe, expect, it } from "vitest";
import { WPE_CONTEXT_MENU, wpeContextMenuPoint } from "./wpeContextMenu";

/** iframe 布局尺寸与显示矩形（happy-dom 之外也能跑，只给用到的字段） */
const frame = (
  offsetWidth: number,
  offsetHeight: number,
  rect: { left: number; top: number; width: number; height: number },
) => ({ offsetWidth, offsetHeight, getBoundingClientRect: () => rect }) as unknown as HTMLElement;

describe("wpeContextMenuPoint", () => {
  it("iframe 内坐标 × 显示缩放 + 显示矩形左上角", () => {
    const shown = frame(1920, 1080, { left: 100, top: 50, width: 960, height: 540 });
    expect(wpeContextMenuPoint({ type: WPE_CONTEXT_MENU, x: 400, y: 200 }, shown)).toEqual({ x: 300, y: 150 });
    const same = frame(800, 600, { left: 0, top: 30, width: 800, height: 600 });
    expect(wpeContextMenuPoint({ type: WPE_CONTEXT_MENU, x: 10, y: 20 }, same)).toEqual({ x: 10, y: 50 });
  });

  it("别的消息、坐标不是有限数、iframe 没有布局时为 null", () => {
    const shown = frame(1920, 1080, { left: 0, top: 0, width: 1920, height: 1080 });
    expect(wpeContextMenuPoint({ type: "kabegame:wpe-volume-request" }, shown)).toBeNull();
    expect(wpeContextMenuPoint(null, shown)).toBeNull();
    expect(wpeContextMenuPoint({ type: WPE_CONTEXT_MENU, x: "1", y: 2 }, shown)).toBeNull();
    expect(wpeContextMenuPoint({ type: WPE_CONTEXT_MENU, x: Number.NaN, y: 2 }, shown)).toBeNull();
    expect(
      wpeContextMenuPoint(
        { type: WPE_CONTEXT_MENU, x: 1, y: 2 },
        frame(0, 0, { left: 0, top: 0, width: 0, height: 0 }),
      ),
    ).toBeNull();
  });
});
