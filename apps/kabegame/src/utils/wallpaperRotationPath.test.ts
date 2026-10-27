import { describe, expect, it } from "vitest";
import {
  albumRotationPath,
  rotationAlbumIdFromPath,
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

  it("只有窗口 / plasma 插件模式能显示视频", () => {
    expect(wallpaperModeSupportsVideo("window")).toBe(true);
    expect(wallpaperModeSupportsVideo("plasma-plugin")).toBe(true);
    expect(wallpaperModeSupportsVideo("native")).toBe(false);
  });
});
