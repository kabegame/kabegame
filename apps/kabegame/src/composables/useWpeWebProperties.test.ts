import { effectScope, ref } from "vue";
import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWpeWebProperties } from "./useWpeWebProperties";

const invoke = vi.hoisted(() => vi.fn());
const subjects = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/api", () => ({ invoke }));
vi.mock("@kabegame/element-plus", () => ({ ElMessage: { error: vi.fn() } }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/services/kbEvents/eventSource", async () => {
  const { Subject } = await import("rxjs");
  return {
    kbEvent$: (name: string) => {
      if (!subjects.has(name)) subjects.set(name, new Subject());
      return subjects.get(name);
    },
  };
});

const fire = (name: string, payload: unknown) =>
  (subjects.get(name) as Subject<{ payload: unknown }>).next({ payload });
const reads = () => invoke.mock.calls.filter(([command]) => command === "get_wpe_web_properties").length;
let scope = effectScope();
const settle = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => {
  scope = effectScope();
  subjects.clear();
  invoke.mockReset().mockResolvedValue({ imageId: "7", metadataId: 3, customCover: false, items: [] });
});
afterEach(() => scope.stop());

describe("useWpeWebProperties 的重读时机", () => {
  it("当前图的 thumbnailPath 补丁重读（customCover 由它算出），别的图不重读", async () => {
    scope.run(() => useWpeWebProperties(ref("7")));
    await settle();
    expect(reads()).toBe(1);
    fire("image-changed", { patch: { id: "8", thumbnailPath: "/data/thumbnails/b.jpg" } });
    expect(reads()).toBe(1);
    fire("image-changed", { patch: { id: "7", thumbnailPath: "/data/thumbnails/a.jpg" } });
    expect(reads()).toBe(2);
    fire("images-change", { patches: [{ id: "7", thumbnailPath: "/workshop/1/preview.gif" }] });
    expect(reads()).toBe(3);
  });

  it("metadataId 没变、也没有 thumbnailPath 时不重读", async () => {
    scope.run(() => useWpeWebProperties(ref("7")));
    await settle();
    fire("image-changed", { patch: { id: "7", metadataId: 3 } });
    fire("image-changed", { patch: { id: "7", displayName: "x" } });
    expect(reads()).toBe(1);
    fire("image-changed", { patch: { id: "7", metadataId: 4 } });
    expect(reads()).toBe(2);
  });
});
