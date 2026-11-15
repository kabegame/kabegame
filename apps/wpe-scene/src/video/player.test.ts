/**
 * 场景视频的公共定义（`player.ts`）：复用键与常量。播放器本身的用例在 `codecPlayer.test.ts`，场景级的规则在 `sceneVideos.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { IDLE_FRAMES, SEEK_END_MARGIN, STALL_MS, videoSourceKey, type SceneVideoSource } from "./player";

const pkg: SceneVideoSource = { path: "P:/p/scene.pkg", start: 100, end: 164 };

describe("player 的公共定义", () => {
  it("复用键：路径、起点、终点", () => {
    expect(videoSourceKey(pkg)).toBe("P:/p/scene.pkg\n100\n164");
    expect(videoSourceKey({ ...pkg, end: 165 })).not.toBe(videoSourceKey(pkg));
  });

  it("常量：30 帧没画到算空闲、seek 钳 0.005 s、卡住 2 s", () => {
    expect([IDLE_FRAMES, SEEK_END_MARGIN, STALL_MS]).toEqual([30, 0.005, 2000]);
  });
});
