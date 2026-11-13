import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoverRegionScope } from "@/components/wallpaper/WallpaperPreviewCanvas.vue";
import { captureWpeCover, clearWpeSceneStorage } from "./wpeWallpaperCommands";

const confirm = vi.hoisted(() => vi.fn());
const success = vi.hoisted(() => vi.fn());
const failure = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@/components/ui/toast", () => ({ toast: { success, error: failure } }));
vi.mock("@/components/ui/messageBox", () => ({
  messageBox: { confirm },
}));
vi.mock("@/api", () => ({ invoke }));

const t = (key: string) => key;
const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
const source: CoverRegionScope = (run) => run(region);

beforeEach(() => {
  confirm.mockReset().mockResolvedValue("confirm");
  invoke.mockReset().mockResolvedValue(undefined);
  success.mockReset();
  failure.mockReset();
});

describe("captureWpeCover", () => {
  it("命令在截取回调里发出，成功 toast", async () => {
    const events: string[] = [];
    const scope: CoverRegionScope = async (run) => {
      events.push("hide");
      const result = await run(region);
      events.push("restore");
      return result;
    };
    invoke.mockImplementation(async () => {
      events.push("invoke");
      return "D:/data/thumbnails/a.jpg";
    });
    await expect(captureWpeCover("7", scope, t)).resolves.toBe(true);
    expect(events).toEqual(["hide", "invoke", "restore"]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("capture_wallpaper_cover", { imageId: "7", region });
    expect(success).toHaveBeenCalledWith("gallery.wpeSetCoverDone");
  });

  it("命令失败时提示错误", async () => {
    invoke.mockRejectedValue("CEF webview not found: main");
    await expect(captureWpeCover("7", source, t)).resolves.toBe(false);
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith("gallery.wpeSetCoverFailed: CEF webview not found: main");
  });

  it("量不到区域时提示错误，不发命令", async () => {
    const scope = () => Promise.reject(new Error("wallpaper canvas is not visible"));
    await expect(captureWpeCover("7", scope, t)).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith("gallery.wpeSetCoverFailed: Error: wallpaper canvas is not visible");
  });
});

describe("clearWpeSceneStorage", () => {
  it("取消确认时不调命令", async () => {
    confirm.mockRejectedValue("cancel");
    await clearWpeSceneStorage("7", t);
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("确认后调命令，成功 toast", async () => {
    await clearWpeSceneStorage("7", t);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("wpe_scene_clear_storage", { imageId: "7" });
    expect(success).toHaveBeenCalledWith("gallery.wpeClearStorageDone");
  });

  it("命令失败时报错，不报成功", async () => {
    invoke.mockRejectedValue("not a scene wallpaper in the library");
    await clearWpeSceneStorage("7", t);
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith("gallery.wpeClearStorageFailed: not a scene wallpaper in the library");
  });
});
