import { describe, expect, it } from "vitest";
import {
  composeQueryFilters,
  GALLERY_SEARCH_MODES_BASIC,
  isActiveSearchTerm,
  makeSearchTerm,
  normalizeQuery,
  parseQueryBody,
  removeNode,
  serializeQueryBody,
  splitQueryFilters,
  type GalleryFilterSet,
  type GalleryQuery,
  type GallerySearchPathMode,
} from "./galleryQuery";
import { buildComposableContextPrefix, buildComposablePath, parseComposablePath } from "./galleryPath";

const simple: GalleryFilterSet = {
  plugin: { pluginId: "pixiv" },
  aspect: { range: "landscape-4x3-16x9" },
};
const advanced: GalleryQuery = [
  {
    any: [
      [{ is: { search: { modes: ["native-metadata"], query: "sakura" } } }],
      [{ is: { mediaType: { kind: "image" } } }],
    ],
  },
];

function roundTrip(query: GalleryQuery): GalleryQuery {
  const parsed = parseQueryBody(serializeQueryBody(query).body.split("/"));
  expect(parsed).not.toBeNull();
  return parsed!;
}

describe("简单 chip + 追加高级条件", () => {
  it("Pixiv + 横图后追加 OR 组，路径保持 AND 顺序", () => {
    const query = composeQueryFilters(simple, advanced);
    expect(
      buildComposablePath({
        query,
        sort: { field: "by-time", desc: true },
        page: 1,
      }),
    ).toBe(
      "plugin/pixiv/filter_comb/aspect/landscape-4x3-16x9/filter_comb/" +
        "~not/~not/~any/search/native-metadata/sakura/~or/media-type/image/~end/~end/~end/sort/by-time/desc/1",
    );
    expect(splitQueryFilters(roundTrip(query))).toEqual({ simple, advanced });
  });

  it.each<GalleryQuery>([
    [{ is: { mediaType: { kind: "image" } } }],
    [{ is: { plugin: { pluginId: "konachan" } } }],
    [{ is: { search: { modes: ["display-name"], query: "樱花 / sakura" } } }, ...advanced],
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
    expect(splitQueryFilters(roundTrip(composeQueryFilters({}, original.advanced)))).toEqual({ simple: {}, advanced });
    expect(splitQueryFilters(roundTrip(composeQueryFilters(original.simple, [])))).toEqual({ simple, advanced: [] });
    expect(composeQueryFilters({}, [])).toEqual([]);
  });

  it("旧版单分支 ~any 边界包装仍能拆回高级条件", () => {
    const parsed = parseQueryBody("plugin/pixiv/filter_comb/~any/media-type/image/~end".split("/"));
    expect(splitQueryFilters(parsed!)).toEqual({
      simple: { plugin: { pluginId: "pixiv" } },
      advanced: [{ is: { mediaType: { kind: "image" } } }],
    });
  });

  it("高级条件里同维度搜索的 OR 组往返后不会并入简单 chip", () => {
    const extra: GalleryQuery = [
      {
        any: [
          [{ is: { search: { modes: ["url"], query: "a" } } }],
          [{ is: { search: { modes: ["url"], query: "b" } } }],
        ],
      },
    ];
    const parts = splitQueryFilters(roundTrip(composeQueryFilters(simple, extra)));
    expect(parts.simple).toEqual(simple);
    expect(parts.advanced).toEqual([{ is: { search: { modes: ["url"], query: "a; b" } } }]);
  });

  it.each(["", "album/42", "task/42", "surf/example.com"])(
    "路由 %s 往返保留边界、排序、分页和 no-album",
    (rootPrefix) => {
      const path = buildComposablePath({
        rootPrefix,
        noAlbum: true,
        query: composeQueryFilters(simple, advanced),
        sort: { field: "by-time", desc: true },
        page: 3,
        pageSize: 500,
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

describe("多维度搜索（勾选维度之间 OR）", () => {
  const multiTerm = makeSearchTerm(["url", "display-name", "url"], "sakura");

  it("makeSearchTerm 按规范顺序去重，空勾选保持为空", () => {
    expect(multiTerm).toEqual({ modes: ["display-name", "url"], query: "sakura" });
    expect(makeSearchTerm([], "x")).toEqual({ modes: [], query: "x" });
  });

  it("全部取消勾选 = 不做搜索过滤：不进路径、归一化时移除", () => {
    const query: GalleryQuery = [{ is: { search: makeSearchTerm([], "sakura"), plugin: { pluginId: "pixiv" } } }];
    expect(isActiveSearchTerm(query[0] && "is" in query[0] ? query[0].is.search : null)).toBe(false);
    expect(serializeQueryBody(query).body).toBe("plugin/pixiv");
    expect(normalizeQuery(query)).toEqual([{ is: { plugin: { pluginId: "pixiv" } } }]);
    expect(buildComposableContextPrefix("", query)).toBe("");
  });

  it("序列化展开为同词 OR 组，结束在枢纽可直接接维度", () => {
    const query: GalleryQuery = [{ is: { search: multiTerm, plugin: { pluginId: "pixiv" } } }];
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/display-name/sakura/~or/search/url/sakura/~end/plugin/pixiv",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("作为简单 chip 或高级原子都能往返折叠回多维度搜索项", () => {
    const term = makeSearchTerm(GALLERY_SEARCH_MODES_BASIC, "樱花 / sakura");
    const atom: GalleryFilterSet = { search: term };
    for (const [base, extra] of [
      [atom, advanced],
      [simple, [{ is: atom }]],
    ] as [GalleryFilterSet, GalleryQuery][]) {
      const parts = splitQueryFilters(roundTrip(composeQueryFilters(base, extra)));
      expect(parts).toEqual({ simple: base, advanced: normalizeQuery(extra) });
    }
  });

  it.each(["", "task/42"])("路由 %s 下多维度搜索往返保持", (rootPrefix) => {
    const path = buildComposablePath({
      rootPrefix,
      query: [{ is: { search: multiTerm } }],
      sort: { field: "by-time", desc: false },
      page: 1,
    });
    const parsed = parseComposablePath(path, rootPrefix ? rootPrefix.split("/") : []);
    expect(parsed.query).toEqual([{ is: { search: multiTerm } }]);
  });

  it.each([
    "~any/search/url/a/~end",
    "~any/search/url/a/~or/search/metadata/b/~end",
    "~any/search/url/a/~or/search/metadata/a/~or/search/url/b/~end",
    "~any/search/metadata/a/~or/search/url/a/~end",
    "~any/search/url/a/~or/search/metadata/a/media-type/image/~end",
    "~any/search/url/a/filter_comb/search/url/b/~or/search/metadata/a/~end",
  ])("不满足折叠条件时保持普通 OR 组：%s", (body) => {
    const parsed = parseQueryBody(body.split("/"));
    expect(parsed).not.toBeNull();
    expect(parsed!.every((node) => "any" in node)).toBe(true);
  });

  it("search/any/<q> 不是合法路径段", () => {
    expect(parseQueryBody(["search", "any", "sakura"])).toBeNull();
  });
});

describe("逗号 AND 语法（所有维度通用）", () => {
  it("单维度：逗号分隔的词序列化成 filter_comb AND 链，解析时折回一个输入值", () => {
    const query: GalleryQuery = [
      { is: { search: { modes: ["label"], query: "miku, pixiv/character" }, plugin: { pluginId: "pixiv" } } },
    ];
    expect(serializeQueryBody(query).body).toBe(
      "search/label/miku/filter_comb/search/label/pixiv%5C%2Fcharacter/plugin/pixiv",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("非标签维度同样按逗号拆成 AND", () => {
    const query: GalleryQuery = [{ is: { search: { modes: ["metadata"], query: "1girl, 1boy" } } }];
    expect(serializeQueryBody(query).body).toBe("search/metadata/1girl/filter_comb/search/metadata/1boy");
    expect(roundTrip(query)).toEqual(query);
  });

  it("多维度：逐词跨维度——每个词任一维度命中即可，词之间 AND", () => {
    const query: GalleryQuery = [{ is: { search: makeSearchTerm(["label", "metadata"], "1girl, 1boy") } }];
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/metadata/1girl/~or/search/label/1girl/~end" +
        "/~any/search/metadata/1boy/~or/search/label/1boy/~end",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("标签词按路径规整后仍能与其它维度折叠回同一输入", () => {
    const query: GalleryQuery = [{ is: { search: makeSearchTerm(["display-name", "label"], "a / b, c") } }];
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/display-name/a%20%5C%2F%20b/~or/search/label/a%5C%2Fb/~end" +
        "/~any/search/display-name/c/~or/search/label/c/~end",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("旧版多维度逗号链（同一维度内同时命中）不再能写成搜索词，保留为普通条件、语义不变", () => {
    const body =
      "~any/search/metadata/1girl/filter_comb/search/metadata/1boy" +
      "/~or/search/label/1girl/filter_comb/search/label/1boy/~end";
    const parsed = parseQueryBody(body.split("/"));
    expect(parsed).not.toBeNull();
    expect(parsed!.every((node) => "any" in node)).toBe(true);
    expect(serializeQueryBody(parsed!).body).toBe(body);
  });

  it("不同维度的搜索段不会被并成一个词串", () => {
    const parsed = parseQueryBody("search/url/a/filter_comb/search/metadata/b".split("/"));
    expect(parsed).not.toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("a, b");
    expect(splitQueryFilters(parsed!).simple).toEqual({ search: { modes: ["url"], query: "a" } });
  });

  it("label-tree 不再是合法模式", () => {
    expect(parseQueryBody("search/label-tree/character".split("/"))).toBeNull();
  });
});

describe("分号 OR 关键字组", () => {
  it("单维度：每组一条 AND 链，组之间 OR", () => {
    const query: GalleryQuery = [{ is: { search: { modes: ["metadata"], query: "1girl, 1boy; cat" } } }];
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/metadata/1girl/filter_comb/search/metadata/1boy/~or/search/metadata/cat/~end",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("多维度：按组优先、组内按维度规范顺序平铺进同一个 OR 组", () => {
    const query: GalleryQuery = [
      { is: { search: makeSearchTerm(["label", "display-name"], "a / b; c"), plugin: { pluginId: "pixiv" } } },
    ];
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/display-name/a%20%5C%2F%20b/~or/search/label/a%5C%2Fb" +
        "/~or/search/display-name/c/~or/search/label/c/~end/plugin/pixiv",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("空组被丢弃；只有一组时与无分号的形态逐字一致", () => {
    const term = makeSearchTerm(["url"], " ; a, b ;");
    expect(serializeQueryBody([{ is: { search: term } }]).body).toBe("search/url/a/filter_comb/search/url/b");
  });

  it("只剩分隔符时退化为字面逗号，不变成全集", () => {
    expect(serializeQueryBody([{ is: { search: makeSearchTerm(["url"], ";,;") } }]).body).toBe("search/url/%2C");
  });

  it("作为高级条件时双重取非包装保留边界", () => {
    const term = makeSearchTerm(["display-name", "url"], "a; b, c");
    const extra: GalleryQuery = [{ is: { search: term } }];
    const parts = splitQueryFilters(roundTrip(composeQueryFilters(simple, extra)));
    expect(parts).toEqual({ simple, advanced: extra });
  });
});

describe("搜索表达式（! 非、() 分组、转义）", () => {
  const term = (modes: GallerySearchPathMode[], query: string): GalleryQuery => [
    { is: { search: makeSearchTerm(modes, query) } },
  ];

  it("单维度：(girl; boy), cute, !genshin", () => {
    const query = term(["label"], "(girl; boy), cute, !genshin");
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/label/girl/~or/search/label/boy/~end/search/label/cute/filter_comb/~not/search/label/genshin/~end",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("多维度：!词 = 所有勾选维度都不含，取非包住整个维度 OR", () => {
    const query = term(["display-name", "label"], "cute, !genshin");
    expect(serializeQueryBody(query).body).toBe(
      "~any/search/display-name/cute/~or/search/label/cute/~end" +
        "/~not/~any/search/display-name/genshin/~or/search/label/genshin/~end/~end",
    );
    expect(roundTrip(query)).toEqual(query);
  });

  it("取非或组写成 ~not/~any/…/~end/~end（~not 内不直接出现 ~or）", () => {
    const query = term(["url"], "!(a; b)");
    expect(serializeQueryBody(query).body).toBe("~not/~any/search/url/a/~or/search/url/b/~end/~end");
    expect(roundTrip(query)).toEqual(query);
  });

  it("双重取非在输入层抵消，不会长成高级条件边界", () => {
    const body = serializeQueryBody(term(["url"], "!!a")).body;
    expect(body).toBe("search/url/a");
    expect(serializeQueryBody(term(["url"], "!(!a, b)")).body).toBe("~not/~not/search/url/a/~end/search/url/b/~end");
  });

  it("!(!a, b) 作为简单搜索往返后仍是简单 chip，不被当成边界", () => {
    const query: GalleryQuery = [
      { is: { search: makeSearchTerm(["url"], "!(!a, b)"), plugin: { pluginId: "pixiv" } } },
    ];
    expect(roundTrip(query)).toEqual(query);
    expect(splitQueryFilters(roundTrip(query))).toEqual({
      simple: query[0] && "is" in query[0] ? query[0].is : {},
      advanced: [],
    });
  });

  it("简单搜索 + 高级搜索：各自的取非与边界互不干扰", () => {
    const base: GalleryFilterSet = { search: makeSearchTerm(["label"], "cute, !genshin") };
    for (const extra of [
      term(["url"], "a"),
      term(["url"], "!a"),
      term(["display-name", "url"], "!(a; b), c"),
      [{ not: term(["url"], "x") }] as GalleryQuery,
    ]) {
      const parts = splitQueryFilters(roundTrip(composeQueryFilters(base, extra)));
      expect(parts.simple).toEqual(base);
      expect(normalizeQuery(parts.advanced).length).toBeGreaterThan(0);
      expect(serializeQueryBody(parts.advanced).body).toBe(serializeQueryBody(extra).body);
    }
  });

  it("词里的特殊字符经转义保持字面，路径段里是原字符", () => {
    const query = term(["local-path"], "Foo (1).jpg, a\\,b, \\!x");
    expect(serializeQueryBody(query).body).toBe(
      "search/local-path/Foo%20(1).jpg/filter_comb/search/local-path/a%2Cb/filter_comb/search/local-path/!x",
    );
    expect(roundTrip(query)).toEqual(query);
    // 旧路径里带字面 `,` 的词折回时被转义，不会被拆成两个词。
    expect(parseQueryBody(["search", "url", "a%2Cb"])).toEqual(term(["url"], "a\\,b"));
  });

  it("语法错误的外部输入整串按字面词处理，不会变成全集", () => {
    expect(serializeQueryBody(term(["url"], "(a; b")).body).toBe("search/url/(a%3B%20b");
  });

  it("用户在高级里手搭的同维度搜索 OR / NOT 组会折成搜索词，语义不变", () => {
    const body = "~any/search/url/a/~or/~not/search/url/b/~end/~end";
    const parsed = parseQueryBody(body.split("/"));
    expect(parsed).toEqual(term(["url"], "a; !b"));
    expect(serializeQueryBody(parsed!).body).toBe(body);
  });
});
