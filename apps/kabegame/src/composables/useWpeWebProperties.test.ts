import { effectScope, ref } from "vue";
import { Subject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWpeWebProperties } from "./useWpeWebProperties";

const invoke = vi.hoisted(() => vi.fn());
const subjects = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/api", () => ({ invoke }));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn() } }));
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

describe("useWpeWebProperties.saveNow（P11d：快捷方式的「测试」要读已保存的值）", () => {
  const writes = () => invoke.mock.calls.filter(([command]) => command === "set_wpe_web_user_properties");

  it("跳过 300ms 防抖立即写，写完才返回；没有草稿时什么都不写", async () => {
    let finished = false;
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_wpe_web_user_properties") {
        await new Promise((resolve) => setTimeout(resolve, 40));
        finished = true;
      }
      return { imageId: "7", metadataId: 3, customCover: false, items: [] };
    });
    const api = scope.run(() => useWpeWebProperties(ref("7")))!;
    await settle();
    await api.saveNow();
    expect(writes()).toHaveLength(0);
    api.set("sc", "file:C:\a.exe");
    await api.saveNow();
    expect(finished).toBe(true);
    expect(writes()).toEqual([["set_wpe_web_user_properties", { imageId: "7", changes: { sc: "file:C:\a.exe" } }]]);
  });

  it("有写入在途时，新草稿排在它后面写，saveNow 等到全部写完", async () => {
    const done: string[] = [];
    invoke.mockImplementation(async (command: string, args: { changes?: Record<string, unknown> }) => {
      if (command === "set_wpe_web_user_properties") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        done.push(JSON.stringify(args.changes));
      }
      return { imageId: "7", metadataId: 3, customCover: false, items: [] };
    });
    const api = scope.run(() => useWpeWebProperties(ref("7")))!;
    await settle();
    api.set("sc", "file:C:\a.exe");
    const first = api.saveNow();
    await new Promise((resolve) => setTimeout(resolve, 5));
    api.set("sc", "file:C:\b.exe");
    await api.saveNow();
    await first;
    expect(done).toEqual([JSON.stringify({ sc: "file:C:\a.exe" }), JSON.stringify({ sc: "file:C:\b.exe" })]);
  });
});
