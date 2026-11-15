/**
 * P11d：快捷方式的点击令牌（`shortcut/token.ts`）。一帧里的顺序是 `beginFrame(左键)` → 派发 → `endFrame(左键)`。
 */
import { describe, expect, it } from "vitest";
import { ShortcutToken } from "./token";

/** 走一帧：派发期间调 `during`（它能 `take()`），返回 during 的结果。 */
function frame<T>(token: ShortcutToken, down: boolean, during: () => T): T {
  token.beginFrame(down);
  const result = during();
  token.endFrame(down);
  return result;
}

describe("ShortcutToken", () => {
  it("没点击时没有令牌", () => {
    const token = new ShortcutToken();
    expect(frame(token, false, () => token.take())).toBe(false);
  });

  it("按下沿在派发之前发：按下那一帧的 cursorDown 就能取到，取走即清", () => {
    const token = new ShortcutToken();
    expect(frame(token, true, () => [token.take(), token.take()])).toEqual([true, false]);
  });

  it("同一次点击只有一个令牌：Down 取走后，按住期间与松开那一帧的 Up / Click 都取不到", () => {
    const token = new ShortcutToken();
    frame(token, true, () => token.take()); // cursorDown 用掉
    expect(frame(token, true, () => token.take())).toBe(false); // 按住
    expect(frame(token, false, () => token.take())).toBe(false); // 松开帧：cursorUp / cursorClick
  });

  it("没人取的令牌留到松开那一帧的派发之后才收：cursorUp / cursorClick 能取到，之后没有", () => {
    const token = new ShortcutToken();
    frame(token, true, () => {}); // 按下没人取
    frame(token, true, () => {}); // 按住
    expect(frame(token, false, () => token.take())).toBe(true); // 松开帧的派发里还在
    expect(frame(token, false, () => token.take())).toBe(false);
  });

  it("没人取的令牌在松开之后一定收回（endFrame 在派发之后）", () => {
    const token = new ShortcutToken();
    frame(token, true, () => {});
    frame(token, false, () => {}); // 松开帧没取
    expect(frame(token, false, () => token.take())).toBe(false);
  });

  it("下一次点击重新发令牌", () => {
    const token = new ShortcutToken();
    frame(token, true, () => token.take());
    frame(token, false, () => {});
    expect(frame(token, true, () => token.take())).toBe(true);
  });

  it("只有按下沿发令牌：从按住状态开始（没经过按下沿）不发", () => {
    const token = new ShortcutToken();
    // 第一帧就按住：last 初值是松开，所以仍是按下沿；先走一次完整点击后，按住不放不会再发
    frame(token, true, () => token.take());
    expect(frame(token, true, () => token.take())).toBe(false);
    expect(frame(token, true, () => token.take())).toBe(false);
  });

  it("reset 清空令牌与上一帧状态", () => {
    const token = new ShortcutToken();
    token.beginFrame(true);
    token.reset();
    expect(token.take()).toBe(false);
  });
});
