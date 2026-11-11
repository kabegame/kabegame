import { describe, expect, it } from "vitest";
import { buildComposablePath } from "./galleryPath";
import type { GalleryQuery } from "./galleryQuery";
import {
  findNameConflict,
  findPathConflict,
  normalizeSavedViewName,
  parseSavedViewBody,
  savedViewBody,
  savedViewDisplayName,
  sortSavedViewsByLastUsed,
  type SavedView,
} from "./savedViews";

const pixivImages: GalleryQuery = [{ is: { plugin: { pluginId: "pixiv" }, mediaType: { kind: "image" } } }];

function view(id: number, path: string, name: string | null, lastUsedAt = 0, createdAt = 0): SavedView {
  return { id, source: "gallery", path, name, createdAt, lastUsedAt };
}

describe("savedViews", () => {
  it("查询体只有过滤与排序：不带根前缀、hide、no-album、分页尾", () => {
    const body = savedViewBody(pixivImages, { field: "by-time", desc: true });
    expect(body).toBe(buildComposablePath({ query: pixivImages, sort: { field: "by-time", desc: true } }));
    expect(body).toContain("plugin/pixiv");
    expect(body.endsWith("sort/by-time/_kb_desc")).toBe(true);
    expect(body).not.toMatch(/^(hide|album|task|surf|no-album)\b/);
    expect(body).not.toContain("_kb_x");
  });

  it("随机排序去掉种子，同一视图两次构建结果相同", () => {
    const a = savedViewBody(pixivImages, { field: "random", desc: false, seed: "123" });
    const b = savedViewBody(pixivImages, { field: "random", desc: false, seed: "456" });
    expect(a).toBe(b);
    expect(a.endsWith("sort/random")).toBe(true);
    // 不开开关时照旧带种子
    expect(buildComposablePath({ query: [], sort: { field: "random", desc: false, seed: "7" } })).toBe("sort/random-7");
  });

  it("解析回环；随机排序应用时现生成种子", () => {
    const sort = { field: "by-size", desc: true } as const;
    const parsed = parseSavedViewBody(savedViewBody(pixivImages, sort));
    expect(parsed.sort).toEqual(sort);
    expect(savedViewBody(parsed.query, parsed.sort)).toBe(savedViewBody(pixivImages, sort));

    const random = parseSavedViewBody(savedViewBody([], { field: "random", desc: false }));
    expect(random.sort.field).toBe("random");
    expect(random.sort.seed).toMatch(/^[0-9]{1,18}$/);
  });

  it("颜色排序的段原样保留：现算段不会被换成色桶段，解析回来还是同一个排序", () => {
    for (const field of ["by-color", "by-any-color"] as const) {
      const sort = { field, desc: true, color: "32fe98" };
      const body = savedViewBody(pixivImages, sort);
      expect(body.endsWith(`sort/${field}_0x32fe98/_kb_desc`)).toBe(true);
      const parsed = parseSavedViewBody(body);
      expect(parsed.sort).toEqual(sort);
      expect(savedViewBody(parsed.query, parsed.sort)).toBe(body);
    }
  });

  it("名字：去首尾空白，空串即用路径作名字", () => {
    expect(normalizeSavedViewName("  十月插画 ")).toBe("十月插画");
    expect(normalizeSavedViewName("   ")).toBeNull();
    expect(normalizeSavedViewName(undefined)).toBeNull();
    expect(savedViewDisplayName({ name: null, path: "sort/by-id" })).toBe("sort/by-id");
    expect(savedViewDisplayName({ name: "全部", path: "sort/by-id" })).toBe("全部");
  });

  it("名字冲突：不分大小写，路径默认名一起比，排除自身", () => {
    const list = [view(1, "sort/by-id", null), view(2, "media-type/image/sort/by-time", "Miku")];
    expect(findNameConflict(list, "miku", "x")?.id).toBe(2);
    expect(findNameConflict(list, "MIKU", "x", 2)).toBeUndefined();
    // 起的名字恰好是别的收藏的路径
    expect(findNameConflict(list, "SORT/BY-ID", "x")?.id).toBe(1);
    // 不命名时用自己的路径比：与别人起的名字撞上也算冲突
    expect(findNameConflict(list, null, "miku")?.id).toBe(2);
    expect(findNameConflict(list, null, "sort/by-name")).toBeUndefined();
  });

  it("路径冲突与按最后使用排序", () => {
    const list = [view(1, "a", null, 10, 1), view(2, "b", null, 30, 2), view(3, "c", null, 30, 3)];
    expect(findPathConflict(list, "b")?.id).toBe(2);
    expect(findPathConflict(list, "b", 2)).toBeUndefined();
    expect(sortSavedViewsByLastUsed([...list]).map((v) => v.id)).toEqual([3, 2, 1]);
  });
});
