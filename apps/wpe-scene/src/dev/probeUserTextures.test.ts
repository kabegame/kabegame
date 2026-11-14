/**
 * dev 探针的用户纹理（P11b 步骤 4）：
 * - `checkGifDts`：每项有限非负，否则抛 RangeError（`renderFrame` 在编译之前查）；
 * - `prepareProbeUserTextures`：来源表建好就按暂停处理（屏外渲染没有实时帧，视频不按真实时间放），没有属性来源时不建；
 * - `ProbeVideos` 的 `videoTime` 对象形式也认用户视频的值（属性里的绝对路径）为合法键。
 * - `userVideoValues` / `checkVideoVisibility`（P11b 步骤 5）：要用视频而宿主 frame 不可见时立刻报原因。
 */
import { describe, expect, it, vi } from "vitest";
import type { SceneBundle } from "../compile/bundle";
import { UserTextureSources } from "../usertex/sources";
import { checkGifDts, prepareProbeUserTextures, userVideoValues } from "./probeUserTextures";
import { checkVideoVisibility, ProbeVideos } from "./videoProbe";

describe("checkGifDts", () => {
  it("缺省原样返回；非负有限数组通过", () => {
    expect(checkGifDts(undefined)).toBeUndefined();
    expect(checkGifDts([])).toEqual([]);
    expect(checkGifDts([0, 0.1, 2])).toEqual([0, 0.1, 2]);
  });

  it("不是数组、含负数 / NaN / Infinity / 非数字都抛 RangeError，说明是第几项", () => {
    expect(() => checkGifDts(0.1)).toThrow(RangeError);
    expect(() => checkGifDts([0.1, -1])).toThrow(/gifDts\[1\]/);
    expect(() => checkGifDts([Number.NaN])).toThrow(/gifDts\[0\]/);
    expect(() => checkGifDts([Infinity])).toThrow(RangeError);
    expect(() => checkGifDts(["0.1"])).toThrow(RangeError);
  });
});

describe("prepareProbeUserTextures", () => {
  const reader = { readWhole: async () => new Uint8Array() };

  it("没有属性来源的 bundle 不建来源表", async () => {
    expect(await prepareProbeUserTextures({ userTextures: [] } as unknown as SceneBundle, undefined, reader)).toBe(
      undefined,
    );
  });

  it("建好就 setPaused(true)（在预解码之前），属性值不是字符串当空串", async () => {
    const spy = vi.spyOn(UserTextureSources.prototype, "setPaused");
    const prime = vi.spyOn(UserTextureSources.prototype, "prime");
    try {
      const sources = await prepareProbeUserTextures(
        {
          userTextures: [
            { kind: "property", name: "ut" },
            { kind: "system", name: "$x" },
          ],
        } as unknown as SceneBundle,
        { ut: 3 },
        reader,
      );
      expect(sources).toBeDefined();
      expect(spy).toHaveBeenCalledExactlyOnceWith(true);
      expect(spy.mock.invocationCallOrder[0]).toBeLessThan(prime.mock.invocationCallOrder[0]);
      expect(sources!.probe()).toMatchObject([{ name: "ut", value: "", kind: "image", status: "empty" }]);
    } finally {
      spy.mockRestore();
      prime.mockRestore();
    }
  });
});

describe("ProbeVideos：videoTime 对象的键也可以是用户视频的值", () => {
  it("用户视频的值合法；两边都不是时照旧抛错，并把用户视频的值列进「有」", () => {
    const textures = [{ path: "materials/v1.tex", video: { path: "a.pkg", start: 0, end: 10 } }];
    expect(() => new ProbeVideos(textures, { "D:/u/clip.mp4": 2 }, {}, ["D:/u/clip.mp4"])).not.toThrow();
    expect(() => new ProbeVideos(textures, { "D:/u/clip.mp4": 2, "x.mp4": 1 }, {}, ["D:/u/clip.mp4"])).toThrow(
      /"x\.mp4" 不是这个场景的视频纹理（有："materials\/v1\.tex"、"D:\/u\/clip\.mp4"）/,
    );
    // 不给用户视频的值时同以前
    expect(() => new ProbeVideos(textures, { "D:/u/clip.mp4": 2 })).toThrow(/不是这个场景的视频纹理/);
  });
});

describe("要用视频时宿主 frame 必须可见（P11b 步骤 5）", () => {
  const bundle = {
    userTextures: [
      { kind: "property", name: "a" },
      { kind: "property", name: "b" },
      { kind: "system", name: "$mediaThumbnail" },
    ],
  } as unknown as SceneBundle;

  it("userVideoValues：只取属性来源里选了视频的值（扩展名不分大小写），图片、GIF、空值、非字符串不算", () => {
    expect(userVideoValues(bundle, { a: "D:/v/clip.MP4", b: "D:/i/x.gif" })).toEqual(["D:/v/clip.MP4"]);
    expect(userVideoValues(bundle, { a: "", b: 3 })).toEqual([]);
    expect(userVideoValues(bundle, undefined)).toEqual([]);
    expect(userVideoValues({ userTextures: undefined } as unknown as SceneBundle, { a: "x.mp4" })).toEqual([]);
  });

  it("checkVideoVisibility：要用视频且 frame 不可见时立刻抛错说明原因；不用视频或可见时不管", () => {
    expect(() => checkVideoVisibility(true, "hidden")).toThrow(/主窗口最小化或隐藏/);
    expect(() => checkVideoVisibility(false, "hidden")).not.toThrow();
    expect(() => checkVideoVisibility(true, "visible")).not.toThrow();
    // Node 里没有 document：缺省参数是 undefined，不抛
    expect(() => checkVideoVisibility(true)).not.toThrow();
  });
});
