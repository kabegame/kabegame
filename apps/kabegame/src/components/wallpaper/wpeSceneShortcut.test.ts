import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createShortcutThrottle, WPE_SCENE_SHORTCUT, WPE_SHORTCUT_NAME_MAX, wpeShortcutName } from "./wpeSceneShortcut";

describe("wpeSceneShortcut", () => {
  it("宿主的字面量与这里一致", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../../wpe-scene/src/shortcut/message.ts"), "utf8");
    expect(source).toContain(`SCENE_SHORTCUT_MESSAGE = "${WPE_SCENE_SHORTCUT}"`);
    expect(source).toContain(`SHORTCUT_NAME_MAX = ${WPE_SHORTCUT_NAME_MAX}`);
  });

  it("只认 type 对、name 是 1–256 长度字符串的消息", () => {
    expect(wpeShortcutName({ type: WPE_SCENE_SHORTCUT, name: "Chrome" })).toBe("Chrome");
    expect(wpeShortcutName({ type: WPE_SCENE_SHORTCUT, name: "a".repeat(256) })).toBe("a".repeat(256));
    expect(wpeShortcutName({ type: WPE_SCENE_SHORTCUT, name: "a".repeat(257) })).toBeNull();
    expect(wpeShortcutName({ type: WPE_SCENE_SHORTCUT, name: "" })).toBeNull();
    expect(wpeShortcutName({ type: WPE_SCENE_SHORTCUT, name: 5 })).toBeNull();
    expect(wpeShortcutName({ type: WPE_SCENE_SHORTCUT })).toBeNull();
    expect(wpeShortcutName({ type: "other", name: "x" })).toBeNull();
    expect(wpeShortcutName(null)).toBeNull();
    expect(wpeShortcutName("kabegame:wpe-scene-shortcut")).toBeNull();
  });

  it("按名字 1 秒节流：不同名字互不影响，被拒的不顺延时间", () => {
    let time = 1000;
    const throttle = createShortcutThrottle(1000, () => time);
    expect(throttle.take("a")).toBe(true);
    expect(throttle.take("b")).toBe(true);
    time += 999;
    expect(throttle.take("a")).toBe(false);
    time += 1;
    expect(throttle.take("a")).toBe(true);
    time += 500;
    expect(throttle.take("a")).toBe(false);
    time += 500;
    expect(throttle.take("a")).toBe(true);
  });
});
