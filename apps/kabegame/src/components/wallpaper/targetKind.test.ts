import { describe, expect, it } from "vitest";
import { isSceneTarget, isVideoTarget, isWebTarget, isWpeTarget, stageMediaOf } from "./targetKind";
import type { WallpaperTarget } from "./types";

const scene = (id: string): WallpaperTarget => ({ id, path: `C:/wpe/${id}`, type: "x-wpe/scene" });
const image = (id: string): WallpaperTarget => ({ id, path: `C:/media/${id}.jpg`, type: "image/jpg" });

describe("targetKind", () => {
  it("按类型分", () => {
    expect(stageMediaOf(scene("s"))).toBe("scene");
    expect(stageMediaOf({ id: "w", path: "C:/w", type: "x-wpe/web" })).toBe("web");
    expect(stageMediaOf({ id: "v", path: "C:/v", type: "x-wpe/video" })).toBe("video");
    expect(stageMediaOf({ id: "m", path: "C:/m.mp4", type: "video/mp4" })).toBe("video");
    expect(stageMediaOf(image("i"))).toBe("image");
    // 类型缺失时回退扩展名
    expect(stageMediaOf({ id: "x", path: "C:/x.webm" })).toBe("video");
    expect(stageMediaOf({ id: "y", path: "C:/y.png" })).toBe("image");
  });

  it("大小写与首尾空白不影响判定", () => {
    const target = { id: "s", path: "C:/s", type: "  X-WPE/Scene " };
    expect(isSceneTarget(target)).toBe(true);
    expect(isWpeTarget(target)).toBe(true);
    expect(isWebTarget(target)).toBe(false);
    expect(isVideoTarget(target)).toBe(false);
  });
});
