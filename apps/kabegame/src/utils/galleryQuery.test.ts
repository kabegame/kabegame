import { describe, expect, it } from "vitest";
import {
  composeQueryFilters,
  GALLERY_SEARCH_MODES_BASIC,
  makeSearchTerm,
  normalizeQuery,
  parseQueryBody,
  removeNode,
  serializeQueryBody,
  splitQueryFilters,
  type GalleryFilterSet,
  type GalleryQuery,
} from "./galleryQuery";
import { buildComposablePath, parseComposablePath } from "./galleryPath";

const simple: GalleryFilterSet = {
  plugin: { pluginId: "pixiv" },
  aspect: { range: "landscape-4x3-16x9" },
};
const advanced: GalleryQuery = [{ any: [
  [{ is: { search: { mode: "native-metadata", query: "sakura" } } }],
  [{ is: { mediaType: { kind: "image" } } }],
] }];

function roundTrip(query: GalleryQuery): GalleryQuery {
  const parsed = parseQueryBody(serializeQueryBody(query).body.split("/"));
  expect(parsed).not.toBeNull();
  return parsed!;
}

describe("简单 chip + 追加高级条件", () => {
  it("Pixiv + 横图后追加 OR 组，路径保持 AND 顺序", () => {
    const query = composeQueryFilters(simple, advanced);
    expect(buildComposablePath({
      query, sort: { field: "by-time", desc: true }, page: 1,
    })).toBe(
      "plugin/pixiv/filter_comb/aspect/landscape-4x3-16x9/filter_comb/" +
      "~any/search/native-metadata/sakura/~or/media-type/image/~end/sort/by-time/desc/1",
    );
    expect(splitQueryFilters(roundTrip(query))).toEqual({ simple, advanced });
  });

  it.each<GalleryQuery>([
    [{ is: { mediaType: { kind: "image" } } }],
    [{ is: { plugin: { pluginId: "konachan" } } }],
    [{ is: { search: { mode: "display-name", query: "樱花 / sakura" } } }, ...advanced],
    [{ not: [{ is: { mediaType: { kind: "video" } } }] }],
    advanced,
  ])("高级条件经归一化与 URL 往返后仍独立：%j", (...nodes) => {
    const extra = nodes as GalleryQuery;
    // 有无简单条件都要保留边界，尤其是只有一个高级原子的情况。
    for (const base of [simple, {}]) {
      const query = composeQueryFilters(base, extra);
      const parts = splitQueryFilters(roundTrip(normalizeQuery(query)));
      expect(parts).toEqual({ simple: base, advanced: normalizeQuery(extra) });
    }
  });

  it("修改简单 chip、清除简单 chip、清除高级 chip 互不覆盖", () => {
    const original = splitQueryFilters(composeQueryFilters(simple, advanced));
    const changed = composeQueryFilters({ ...original.simple, size: { range: "1MB-2MB" } }, original.advanced);
    expect(splitQueryFilters(roundTrip(changed)).advanced).toEqual(advanced);
    expect(splitQueryFilters(roundTrip(composeQueryFilters({}, original.advanced))))
      .toEqual({ simple: {}, advanced });
    expect(splitQueryFilters(roundTrip(composeQueryFilters(original.simple, []))))
      .toEqual({ simple, advanced: [] });
    expect(composeQueryFilters({}, [])).toEqual([]);
  });

  it.each(["", "album/42", "task/42", "surf/example.com"])(
    "路由 %s 往返保留边界、排序、分页和 no-album", (rootPrefix) => {
      const path = buildComposablePath({
        rootPrefix, noAlbum: true, query: composeQueryFilters(simple, advanced),
        sort: { field: "by-time", desc: true }, page: 3, pageSize: 500,
      });
      const parsed = parseComposablePath(path, rootPrefix ? rootPrefix.split("/") : []);
      expect(splitQueryFilters(parsed.query)).toEqual({ simple, advanced });
      expect(parsed).toMatchObject({ noAlbum: true, sort: { field: "by-time", desc: true }, page: 3, pageSize: 500 });
    },
  );
});

describe("removeNode", () => {
  it("删掉分支里唯一的条件时连同分支一起删除", () => {
    const query: GalleryQuery = [{ any: [[{ is: {} }], [{ is: {} }], [{ is: {} }]] }];
    expect(removeNode(query, [0, 2, 0])).toEqual([{ any: [[{ is: {} }], [{ is: {} }]] }]);
  });

  it("分支非空时只删条件", () => {
    const query: GalleryQuery = [{ any: [[{ is: {} }, { is: {} }], [{ is: {} }]] }];
    expect(removeNode(query, [0, 0, 1])).toEqual([{ any: [[{ is: {} }], [{ is: {} }]] }]);
  });

  it("最后一个分支删空时移除整个或组", () => {
    const query: GalleryQuery = [{ is: {} }, { any: [[{ is: {} }]] }];
    expect(removeNode(query, [1, 0, 0])).toEqual([{ is: {} }]);
  });

  it("取非的或组删空时连同取非包装一起移除", () => {
    const query: GalleryQuery = [{ not: [{ any: [[{ is: {} }]] }] }];
    expect(removeNode(query, [0, 0, 0, 0])).toEqual([]);
  });
});

describe("任意搜（虚拟模式 any）", () => {
  const anyTerm = makeSearchTerm("any", "sakura", ["url", "display-name", "url"]);

  it("makeSearchTerm 按规范顺序去重范围，单模式不带 modes", () => {
    expect(anyTerm).toEqual({ mode: "any", query: "sakura", modes: ["display-name", "url"] });
    expect(makeSearchTerm("url", "x", GALLERY_SEARCH_MODES_BASIC)).toEqual({ mode: "url", query: "x" });
  });

  it("序列化展开为同词 OR 组，结束在枢纽可直接接维度", () => {
    const query: GalleryQuery = [{ is: { search: anyTerm, plugin: { pluginId: "pixiv" } } }];
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/display-name/sakura/~or/search/url/sakura/~end/plugin/pixiv",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("作为简单 chip 或高级原子都能往返折叠回 any", () => {
    const term = makeSearchTerm("any", "樱花 / sakura", GALLERY_SEARCH_MODES_BASIC);
    const atom: GalleryFilterSet = { search: term };
    for (const [base, extra] of [
      [atom, advanced],
      [simple, [{ is: atom }]],
    ] as [GalleryFilterSet, GalleryQuery][]) {
      const parts = splitQueryFilters(roundTrip(composeQueryFilters(base, extra)));
      expect(parts).toEqual({ simple: base, advanced: normalizeQuery(extra) });
    }
  });

  it.each(["", "task/42"])("路由 %s 下 any 搜索往返保持", (rootPrefix) => {
    const path = buildComposablePath({
      rootPrefix, query: [{ is: { search: anyTerm } }], sort: { field: "by-time", desc: false }, page: 1,
    });
    const parsed = parseComposablePath(path, rootPrefix ? rootPrefix.split("/") : []);
    expect(parsed.query).toEqual([{ is: { search: anyTerm } }]);
  });

  it.each([
    "~any/search/url/a/~end",
    "~any/search/url/a/~or/search/metadata/b/~end",
    "~any/search/url/a/~or/search/url/a/~end",
    "~any/search/url/a/~or/search/metadata/a/media-type/image/~end",
  ])("不满足折叠条件时保持普通 OR 组：%s", (body) => {
    const parsed = parseQueryBody(body.split("/"));
    expect(parsed).not.toBeNull();
    expect(parsed!.every((node) => "any" in node)).toBe(true);
  });

  it("search/any/<q> 不是合法路径段", () => {
    expect(parseQueryBody(["search", "any", "sakura"])).toBeNull();
  });
});
