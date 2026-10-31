import { effectScope, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import appLogoUrl from "@/assets/icon-small.png";
import type { ImageInfo } from "@/types/image";
import { usePreviewMediaSession } from "./usePreviewMediaSession";

const scopes: ReturnType<typeof effectScope>[] = [];
const image = (displayName: string) => ({ displayName }) as ImageInfo;

function mount(initialImage: ImageInfo | null, initialActive = true) {
  const previewImage = ref(initialImage);
  const active = ref(initialActive);
  const scope = effectScope();
  scopes.push(scope);
  scope.run(() => usePreviewMediaSession(previewImage, active));
  return { previewImage, active, scope };
}

beforeEach(() => {
  vi.stubGlobal("navigator", { mediaSession: { metadata: null } });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      title: string;
      artwork: MediaImage[];

      constructor(init: MediaMetadataInit) {
        this.title = init.title ?? "";
        this.artwork = init.artwork ?? [];
      }
    },
  );
});

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.unstubAllGlobals();
});

describe("usePreviewMediaSession", () => {
  it("打开预览时设置名称与应用图标，切图时更新名称", async () => {
    const { previewImage } = mount(image("第一张"));
    expect(navigator.mediaSession.metadata?.title).toBe("第一张");
    expect(navigator.mediaSession.metadata?.artwork).toEqual([
      { src: appLogoUrl, sizes: "128x128", type: "image/png" },
    ]);

    previewImage.value = image("第二张");
    await nextTick();
    expect(navigator.mediaSession.metadata?.title).toBe("第二张");
  });

  it("关闭预览或销毁 scope 时清理自己的元数据", async () => {
    const { active, scope } = mount(image("第一张"));
    active.value = false;
    await nextTick();
    expect(navigator.mediaSession.metadata).toBeNull();

    active.value = true;
    await nextTick();
    expect(navigator.mediaSession.metadata?.title).toBe("第一张");
    scope.stop();
    expect(navigator.mediaSession.metadata).toBeNull();
  });

  it("别的调用方替换元数据后不清掉它", async () => {
    const { active } = mount(image("第一张"));
    const other = new MediaMetadata({ title: "其它会话" });
    navigator.mediaSession.metadata = other;
    active.value = false;
    await nextTick();
    expect(navigator.mediaSession.metadata).toBe(other);
  });

  it("空名称回退到 Kabegame", () => {
    mount(image("  "));
    expect(navigator.mediaSession.metadata?.title).toBe("Kabegame");
  });

  it("没有媒体会话时直接跳过", () => {
    vi.stubGlobal("navigator", {});
    expect(() => mount(image("第一张"))).not.toThrow();
  });
});
