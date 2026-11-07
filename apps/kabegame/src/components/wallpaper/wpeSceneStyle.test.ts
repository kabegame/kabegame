import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WPE_SCENE_SIZE,
  WPE_SCENE_STYLE,
  WPE_SCENE_STYLE_REQUEST,
  isWpeSceneStyleRequest,
  wpeSceneSizeOf,
  wpeSceneStyleMessage,
} from "./wpeSceneStyle";

describe("wpeSceneStyle", () => {
  it("宿主的字面量与这里一致", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/sceneStyle.ts"), "utf8");
    expect(source).toContain(`SCENE_STYLE_REQUEST = "${WPE_SCENE_STYLE_REQUEST}"`);
    expect(source).toContain(`SCENE_STYLE_MESSAGE = "${WPE_SCENE_STYLE}"`);
    expect(source).toContain(`SCENE_SIZE_MESSAGE = "${WPE_SCENE_SIZE}"`);
  });

  it("识别样式请求", () => {
    expect(isWpeSceneStyleRequest({ type: WPE_SCENE_STYLE_REQUEST })).toBe(true);
    expect(isWpeSceneStyleRequest({ type: "other" })).toBe(false);
    expect(isWpeSceneStyleRequest(null)).toBe(false);
  });

  it("样式消息带样式", () => {
    expect(wpeSceneStyleMessage("center")).toEqual({ type: WPE_SCENE_STYLE, style: "center" });
  });

  it("只接受有效的场景尺寸", () => {
    expect(wpeSceneSizeOf({ type: WPE_SCENE_SIZE, width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(wpeSceneSizeOf({ type: WPE_SCENE_SIZE, width: 0, height: 1080 })).toBeNull();
    expect(wpeSceneSizeOf({ type: WPE_SCENE_SIZE, width: "1920", height: 1080 })).toBeNull();
    expect(wpeSceneSizeOf({ type: "other", width: 1920, height: 1080 })).toBeNull();
    expect(wpeSceneSizeOf(null)).toBeNull();
  });
});
