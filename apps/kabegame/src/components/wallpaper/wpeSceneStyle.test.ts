import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WPE_SCENE_STYLE,
  WPE_SCENE_STYLE_REQUEST,
  isWpeSceneStyleRequest,
  wpeSceneStyleMessage,
} from "./wpeSceneStyle";

describe("wpeSceneStyle", () => {
  it("宿主的字面量与这里一致", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/sceneStyle.ts"), "utf8");
    expect(source).toContain(`SCENE_STYLE_REQUEST = "${WPE_SCENE_STYLE_REQUEST}"`);
    expect(source).toContain(`SCENE_STYLE_MESSAGE = "${WPE_SCENE_STYLE}"`);
  });

  it("识别样式请求", () => {
    expect(isWpeSceneStyleRequest({ type: WPE_SCENE_STYLE_REQUEST })).toBe(true);
    expect(isWpeSceneStyleRequest({ type: "other" })).toBe(false);
    expect(isWpeSceneStyleRequest(null)).toBe(false);
  });

  it("样式消息带样式", () => {
    expect(wpeSceneStyleMessage("center")).toEqual({ type: WPE_SCENE_STYLE, style: "center" });
  });
});
