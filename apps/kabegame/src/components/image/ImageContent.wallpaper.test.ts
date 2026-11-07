// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageContent from "./ImageContent.vue";
import type { ImageInfo } from "@/types/image";

vi.mock("@/stores/ui", async () => {
  const { ref } = await import("vue");
  return { useUiStore: () => ({ isCompact: ref(false) }) };
});

/** 壁纸组件桩：记录挂载次数，`ready` 由测试手动发 */
let mounts = 0;
const WallpaperStub = defineComponent({
  name: "WpeWallpaperContent",
  props: { image: Object },
  emits: ["ready", "error", "sceneLive"],
  setup() {
    mounts += 1;
    return () => h("div", { class: "wallpaper-stub" });
  },
});

const wrappers: ReturnType<typeof mount>[] = [];
const wallpaper = (id: string, type: string, thumbnailPath: string) =>
  ({ id, type, localPath: `C:/workshop/${id}`, thumbnailPath, localExists: true }) as ImageInfo;

function mountContent(image: ImageInfo) {
  const wrapper = mount(ImageContent, {
    props: { image, prefer: "original" },
    global: { stubs: { WpeWallpaperContent: WallpaperStub, "el-skeleton": true, "el-skeleton-item": true } },
  });
  wrappers.push(wrapper);
  return wrapper;
}
const overlay = (wrapper: ReturnType<typeof mount>) => wrapper.find(".ic-loading-overlay").exists();
async function ready(wrapper: ReturnType<typeof mount>) {
  wrapper.findComponent(WallpaperStub).vm.$emit("ready");
  await flushPromises();
}
async function waitPastDelay() {
  vi.advanceTimersByTime(400);
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  mounts = 0;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

describe("ImageContent 的壁纸形态与加载态", () => {
  it.each(["x-wpe/web", "x-wpe/scene"])("%s 换封面（thumbnailPath 变）不重新进入加载态", async (type) => {
    const wrapper = mountContent(wallpaper("7", type, "C:/workshop/7/preview.jpg"));
    await waitPastDelay();
    expect(overlay(wrapper)).toBe(true);
    await ready(wrapper);
    expect(overlay(wrapper)).toBe(false);

    await wrapper.setProps({ image: wallpaper("7", type, "C:/data/thumbnails/7-cover.jpg") });
    await waitPastDelay();
    expect(overlay(wrapper)).toBe(false);
    expect(mounts).toBe(1);
    expect(wrapper.emitted("ready")).toHaveLength(1);
  });

  it("换成另一张壁纸照常走加载态，直到新的 ready", async () => {
    const wrapper = mountContent(wallpaper("7", "x-wpe/web", "C:/workshop/7/preview.jpg"));
    await ready(wrapper);
    await wrapper.setProps({ image: wallpaper("8", "x-wpe/web", "C:/workshop/8/preview.jpg") });
    await waitPastDelay();
    expect(overlay(wrapper)).toBe(true);
    await ready(wrapper);
    expect(overlay(wrapper)).toBe(false);
  });
});
