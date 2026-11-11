import { describe, expect, it } from "vitest";
import {
  buildComposablePath,
  colorSortFor,
  isColorSortField,
  isGallerySortField,
  normalizeGallerySort,
  parseComposablePath,
  parseGalleryPath,
  type GallerySort,
} from "./galleryPath";
import type { GalleryQuery } from "./galleryQuery";

const pixivImages: GalleryQuery = [{ is: { plugin: { pluginId: "pixiv" }, mediaType: { kind: "image" } } }];

describe("颜色排序段", () => {
  it.each([
    ["by-color", "ff0000"],
    ["by-any-color", "32fe98"],
    // 黑色：前导零不能丢
    ["by-color", "000000"],
    ["by-any-color", "00000a"],
  ] as const)("%s_0x%s 的构造与解析往返", (field, color) => {
    for (const desc of [false, true]) {
      const sort: GallerySort = { field, desc, color };
      const path = buildComposablePath({ query: pixivImages, sort });
      expect(path.endsWith(`sort/${field}_0x${color}${desc ? "/_kb_desc" : ""}`)).toBe(true);
      const parsed = parseGalleryPath(path);
      expect(parsed.sort).toEqual(sort);
      expect(parsed.query).toEqual(pixivImages);
      expect(buildComposablePath({ query: parsed.query, sort: parsed.sort })).toBe(path);
    }
  });

  it("空查询、带根前缀与分页尾同样解析", () => {
    expect(buildComposablePath({ query: [], sort: { field: "by-color", desc: false, color: "ff0000" } })).toBe(
      "sort/by-color_0xff0000",
    );
    expect(parseGalleryPath("sort/by-any-color_0x32fe98/_kb_desc/_kb_x100x/3").sort).toEqual({
      field: "by-any-color",
      desc: true,
      color: "32fe98",
    });
    const path = buildComposablePath({
      rootPrefix: "album/abc",
      query: pixivImages,
      sort: { field: "by-color", desc: false, color: "00ff00" },
    });
    expect(path.startsWith("album/abc/")).toBe(true);
    expect(parseComposablePath(path, ["album", "abc"]).sort).toEqual({
      field: "by-color",
      desc: false,
      color: "00ff00",
    });
  });

  it("不带颜色的字段不携带 color，随机排序的种子不受影响", () => {
    expect(parseGalleryPath("sort/by-size").sort).toEqual({ field: "by-size", desc: false });
    expect(parseGalleryPath("sort/random-42").sort).toEqual({ field: "random", desc: false, seed: "42" });
  });

  it.each([
    // 大写：后端只认小写
    "sort/by-color_0xFF0000",
    "sort/by-any-color_0x32FE98",
    // 位数不对
    "sort/by-color_0xff00",
    "sort/by-color_0xff00000",
    "sort/by-any-color_0x",
    // 不是十六进制、缺 0x 前缀
    "sort/by-color_0xgg0000",
    "sort/by-color_ff0000",
    "sort/by-any-color-0xff0000",
    // 不带颜色的裸段
    "sort/by-color",
    "sort/by-any-color",
  ])("%s 不是合法排序段：回落默认排序", (path) => {
    expect(parseGalleryPath(path).sort).toEqual({ field: "by-time", desc: false });
    expect(parseComposablePath(path, [], "by-id").sort).toEqual({ field: "by-id", desc: false });
    expect(parseGalleryPath(`${path}/_kb_desc`).sort).toEqual({ field: "by-time", desc: true });
  });

  it("normalizeGallerySort：颜色合法才保留，否则整体回落 by-time", () => {
    expect(normalizeGallerySort({ field: "by-color", desc: true, color: "ff0000" })).toEqual({
      field: "by-color",
      desc: true,
      color: "ff0000",
    });
    expect(normalizeGallerySort({ field: "by-any-color", desc: false, color: "32fe98" })).toEqual({
      field: "by-any-color",
      desc: false,
      color: "32fe98",
    });
    for (const color of [undefined, "", "FF0000", "ff00", "#ff0000", "0xff0000", "ff00000"]) {
      expect(normalizeGallerySort({ field: "by-color", desc: true, color })).toEqual({ field: "by-time", desc: true });
      expect(normalizeGallerySort({ field: "by-any-color", desc: false, color })).toEqual({
        field: "by-time",
        desc: false,
      });
    }
    // 其它字段不带出 color
    expect(normalizeGallerySort({ field: "by-size", desc: false, color: "ff0000" })).toEqual({
      field: "by-size",
      desc: false,
    });
  });

  it("颜色不合法的排序构建出的是默认排序段，不会拼出坏路径", () => {
    expect(buildComposablePath({ query: [], sort: { field: "by-color", desc: false } })).toBe("sort/by-time");
    expect(buildComposablePath({ query: [], sort: { field: "by-any-color", desc: true, color: "XYZ" } })).toBe(
      "sort/by-time/_kb_desc",
    );
  });

  it("isGallerySortField / isColorSortField", () => {
    expect(isGallerySortField("by-color")).toBe(true);
    expect(isGallerySortField("by-any-color")).toBe(true);
    expect(isGallerySortField("by-color_0xff0000")).toBe(false);
    expect(isColorSortField("by-color")).toBe(true);
    expect(isColorSortField("by-any-color")).toBe(true);
    expect(isColorSortField("by-time")).toBe(false);
    expect(isColorSortField("random")).toBe(false);
  });
});

describe("colorSortFor", () => {
  const buckets = new Set(["ff0000", "000000"]);

  it("颜色在色桶里用预计算段，否则用现算段", () => {
    expect(colorSortFor("ff0000", buckets, false)).toEqual({ field: "by-color", desc: false, color: "ff0000" });
    expect(colorSortFor("000000", buckets, true)).toEqual({ field: "by-color", desc: true, color: "000000" });
    expect(colorSortFor("32fe98", buckets, false)).toEqual({ field: "by-any-color", desc: false, color: "32fe98" });
    expect(colorSortFor("ff0000", new Set(), true)).toEqual({ field: "by-any-color", desc: true, color: "ff0000" });
  });

  it("两个段对同一个颜色只差字段名", () => {
    const saved = buildComposablePath({ query: [], sort: colorSortFor("ff0000", buckets, false) });
    const computed = buildComposablePath({ query: [], sort: colorSortFor("ff0000", new Set(), false) });
    expect(saved).toBe("sort/by-color_0xff0000");
    expect(computed).toBe("sort/by-any-color_0xff0000");
  });
});
