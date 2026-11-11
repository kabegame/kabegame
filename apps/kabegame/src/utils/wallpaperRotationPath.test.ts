import { describe, expect, it } from "vitest";
import {
  albumRotationPath,
  rotatingTargetIds,
  rotationAlbumIdFromPath,
  rotationAlbumIdsFromPaths,
  viewRotationPath,
  wallpaperModeSupportsVideo,
} from "./wallpaperRotationPath";

const ID = "11111111-1111-1111-1111-111111111111";

describe("wallpaperRotationPath", () => {
  it("把视图路径补成 images:// 画廊路径", () => {
    expect(viewRotationPath("hide/sort/random-42")).toBe("images://gallery/hide/sort/random-42");
    expect(viewRotationPath("gallery/all")).toBe("images://gallery/all");
    expect(viewRotationPath("images://gallery/hide/all")).toBe("images://gallery/hide/all");
  });

  it("只从以画册为根的路径解析画册 id（与 Rust album_id_of 同规则）", () => {
    expect(rotationAlbumIdFromPath(albumRotationPath(ID))).toBe(ID);
    expect(rotationAlbumIdFromPath(`images://gallery/album-tree/${ID}/sort/by-id`)).toBe(ID);
    expect(rotationAlbumIdFromPath(viewRotationPath(`hide/album/${ID}/sort/by-album-order`))).toBe(ID);
    expect(rotationAlbumIdFromPath("images://gallery/hide/all")).toBeNull();
    expect(rotationAlbumIdFromPath(null)).toBeNull();
  });

  it("多个壁纸目标的轮播路径：取其中以画册为根的画册 id，去重", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    expect(
      rotationAlbumIdsFromPaths([
        albumRotationPath(ID),
        "images://gallery/hide/sort/random-1",
        `images://gallery/album-tree/${other}`,
        albumRotationPath(ID),
        null,
      ]),
    ).toEqual([ID, other]);
    expect(rotationAlbumIdsFromPaths([])).toEqual([]);
  });

  it("哪些壁纸目标在轮播某个来源：有命中就打标记，全部命中才没有屏可再设", () => {
    const other = "22222222-2222-2222-2222-222222222222";
    const isAlbum = (id: string) => (path: string) => rotationAlbumIdFromPath(path) === id;
    const sources = [
      { targetId: "screen:main", path: albumRotationPath(other) },
      { targetId: "screen:side", path: albumRotationPath(ID) },
      // 还没设路径（默认全画廊随机）：什么来源都不算命中
      { targetId: "screen:third", path: null },
    ];
    expect(rotatingTargetIds(sources, isAlbum(ID))).toEqual(["screen:side"]);
    expect(rotatingTargetIds(sources, isAlbum("none"))).toEqual([]);
    // 只有一个目标：命中即全部命中，与单目标时的「正在轮播」相同
    expect(rotatingTargetIds(sources.slice(1, 2), isAlbum(ID))).toHaveLength(1);
    // 每块屏都在轮播它
    const all = [
      { targetId: "screen:main", path: albumRotationPath(ID) },
      { targetId: "screen:side", path: `images://gallery/album-tree/${ID}` },
    ];
    expect(rotatingTargetIds(all, isAlbum(ID))).toEqual(["screen:main", "screen:side"]);
    expect(rotatingTargetIds([], isAlbum(ID))).toEqual([]);
  });

  it("只有窗口 / plasma 插件模式能显示视频", () => {
    expect(wallpaperModeSupportsVideo("window")).toBe(true);
    expect(wallpaperModeSupportsVideo("plasma-plugin")).toBe(true);
    expect(wallpaperModeSupportsVideo("native")).toBe(false);
  });
});
