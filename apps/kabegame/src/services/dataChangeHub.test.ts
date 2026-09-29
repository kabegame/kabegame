import { describe, expect, it } from "vitest";
import { affectsAlbumDir, type ChangeBatch } from "./dataChangeHub";

function batch(paths: string[], wildcard = false): ChangeBatch {
  return {
    images: new Set(),
    imageIds: new Set(),
    taskIds: new Set(),
    surfRecordIds: new Set(),
    pluginIds: new Set(),
    albumImages: new Set(),
    albumIds: new Set(),
    albumImageIds: new Set(),
    favoriteOps: [],
    albumStructure: new Set(),
    albumPaths: new Set(paths),
    albumPathsWildcard: wildcard,
    wildcard: { task: false, surf: false, plugin: false },
    maxSeq: 0,
  };
}

describe("affectsAlbumDir", () => {
  it("根目录在任一画册变更时命中", () => {
    expect(affectsAlbumDir(batch(["/a/"]), null)).toBe(true);
  });

  it("只命中变更画册的祖先目录，不命中画册自身或兄弟目录", () => {
    const change = batch(["/a/b/c/"]);
    expect(affectsAlbumDir(change, "/a/")).toBe(true);
    expect(affectsAlbumDir(change, "/a/b/")).toBe(true);
    expect(affectsAlbumDir(change, "/a/b/c/")).toBe(false);
    expect(affectsAlbumDir(change, "/a/d/")).toBe(false);
  });

  it("无法定位路径的兼容事件命中任意目录", () => {
    expect(affectsAlbumDir(batch([], true), "/a/")).toBe(true);
  });
});
