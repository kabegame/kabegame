import { describe, expect, it, vi } from "vitest";
import { useWallpaperScreens } from "./useWallpaperScreens";

const backend = vi.hoisted(() => ({
  order: [] as string[],
  resolveList: (_list: unknown) => {},
  handler: null as ((event: { payload: unknown }) => void) | null,
}));

vi.mock("@/api/rpc", () => ({
  invoke: (command: string) => {
    backend.order.push(`invoke:${command}`);
    return new Promise((resolve) => {
      backend.resolveList = resolve;
    });
  },
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    backend.order.push(`listen:${name}`);
    backend.handler = handler;
    return () => {};
  },
}));
vi.mock("@/env", () => ({ IS_WEB: false }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn() } }));

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const screen = (id: string, primary = false) => ({
  id,
  name: null,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  pixelWidth: 1920,
  pixelHeight: 1080,
  scale: 1,
  primary,
});

// 在线屏是模块级状态、整份文件只初始化一次，所以首次读取与事件的先后只能在一个用例里走完
describe("useWallpaperScreens", () => {
  it("先登记监听再读一次；读取在途时到的事件更新，过时的读取结果不覆盖它；之后只跟事件", async () => {
    const screens = useWallpaperScreens();
    // 多处使用共用一份，不重复初始化
    expect(useWallpaperScreens()).toBe(screens);
    expect(screens.value).toEqual([]);
    await flush();
    expect(backend.order).toEqual(["listen:wallpaper-screens-change", "invoke:list_wallpaper_screens"]);

    // 读取还没返回，屏幕先变了
    backend.handler?.({ payload: { screens: [screen("main", true), screen("side")] } });
    expect(screens.value.map((item) => item.id)).toEqual(["main", "side"]);
    // 读取返回的是变化前的列表
    backend.resolveList([screen("main", true)]);
    await flush();
    expect(screens.value.map((item) => item.id)).toEqual(["main", "side"]);

    backend.handler?.({ payload: { screens: [screen("main", true)] } });
    expect(screens.value.map((item) => item.id)).toEqual(["main"]);
    expect(backend.order).toHaveLength(2);
  });
});
