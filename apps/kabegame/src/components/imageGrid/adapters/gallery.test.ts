import { reactive } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGalleryAdapter } from "./gallery";
import type { ImageAnalytics } from "@/track/imageAnalytics";
import type { GalleryQuery } from "@/utils/galleryPath";

const routeStore = reactive({ query: [] as GalleryQuery, effectiveNoAlbum: false, hide: false });
vi.mock("@/stores/galleryRoute", () => ({
  useGalleryRouteStore: () => routeStore,
  resetGalleryRouteToDefault: vi.fn(),
}));
vi.mock("@/router", () => ({ default: { currentRoute: { value: { path: "/gallery" } } } }));
vi.mock("@kabegame/i18n", () => ({ i18n: { global: { t: (key: string) => key } } }));
vi.mock("@/utils/kameMessage", () => ({ kameMessage: { warning: vi.fn() } }));
vi.mock("@/services/kbEvents", () => ({
  on: (event: string, relevant: (payload: unknown) => boolean) => ({ event, relevant }),
  albumChangeKinds: vi.fn(),
}));

beforeEach(() => {
  routeStore.query = [];
  routeStore.effectiveNoAlbum = false;
  routeStore.hide = false;
});

describe("gallery adapter 的同批分母路径", () => {
  const adapter = () => createGalleryAdapter({ analytics: {} as ImageAnalytics });

  it("无过滤时不读分母，hide 本身不构成过滤", () => {
    const grid = adapter();
    expect(grid.computeUnfilteredCountPath?.()).toBeNull();
    routeStore.hide = true;
    expect(grid.computeUnfilteredCountPath?.()).toBeNull();
  });

  it("查询或无画册过滤时读取当前 hide 上下文的全部数量", () => {
    const grid = adapter();
    routeStore.query = [{ is: { plugin: { pluginId: "pixiv" } } }];
    expect(grid.computeUnfilteredCountPath?.()).toBe("gallery");
    routeStore.hide = true;
    expect(grid.computeUnfilteredCountPath?.()).toBe("hide");
    routeStore.query = [];
    routeStore.effectiveNoAlbum = true;
    expect(grid.computeUnfilteredCountPath?.()).toBe("hide");
  });
});
