import {
  conditionCount,
  facetListPath,
  type GalleryAdvancedQuery,
  getNode,
  isEmptyQuery,
  normalizeQuery,
  notParity,
  parseAdvancedBody,
  removeNode,
  serializeAdvancedQuery,
  updateNode,
} from "../src/utils/galleryQuery.ts";
import {
  buildComposableCountPath,
  buildComposablePath,
  parseComposablePath,
} from "../src/utils/galleryPath.ts";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message = "断言失败"): asserts condition {
  if (!condition) fail(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message = "值不相等",
): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    fail(`${message}\nexpected: ${expectedJson}\nactual:   ${actualJson}`);
  }
}

function assertThrows(fn: () => unknown, message = "预期函数抛出异常"): void {
  try {
    fn();
  } catch {
    return;
  }
  fail(message);
}

function body(tree: GalleryAdvancedQuery): string {
  return serializeAdvancedQuery(tree).body;
}

function roundTrip(tree: GalleryAdvancedQuery): GalleryAdvancedQuery | null {
  return parseAdvancedBody(body(tree).split("/"));
}

Deno.test("序列化：原子内部与原子到组遵循叶游标规则", () => {
  assertEquals(
    body([{ is: { wallpaperOrder: true, plugin: { pluginId: "pixiv" } } }]),
    "wallpaper-order/filter_comb/plugin/pixiv",
  );
  assertEquals(
    body([
      { is: { plugin: { pluginId: "pixiv" } } },
      { any: [[{ is: { name: { bucket: "japanese" } } }]] },
    ]),
    "plugin/pixiv/filter_comb/~any/name/japanese/~end",
  );
});

Deno.test("序列化：组与 search 收尾使用枢纽游标", () => {
  assertEquals(
    body([
      { any: [[{ is: { plugin: { pluginId: "pixiv" } } }]] },
      { is: { name: { bucket: "japanese" } } },
    ]),
    "~any/plugin/pixiv/~end/name/japanese",
  );
  assertEquals(
    body([
      { any: [[{ is: { plugin: { pluginId: "pixiv" } } }]] },
      { not: [{ is: { size: { range: "large" } } }] },
    ]),
    "~any/plugin/pixiv/~end/~not/size/large/~end",
  );
  assertEquals(
    body([
      { is: { search: { mode: "metadata", query: "星空" } } },
      { any: [[{ is: { aspect: { range: "widescreen-16x9-21x9" } } }]] },
    ]),
    "search/metadata/星空/~any/aspect/widescreen-16x9-21x9/~end",
  );
});

Deno.test("构建路径：sort 根据叶/枢纽收尾选择连接符", () => {
  assertEquals(
    buildComposablePath({
      filters: [{ is: { plugin: { pluginId: "pixiv" } } }],
      sort: { field: "by-time", desc: false },
      page: 1,
    }),
    "plugin/pixiv/filter_comb/sort/by-time/1",
  );
  const group: GalleryAdvancedQuery = [{
    any: [[{ is: { plugin: { pluginId: "pixiv" } } }]],
  }];
  assertEquals(
    buildComposablePath({
      filters: group,
      sort: { field: "by-time", desc: true },
      page: 2,
    }),
    "~any/plugin/pixiv/~end/sort/by-time/desc/2",
  );
  assertEquals(buildComposableCountPath("", group), "~any/plugin/pixiv/~end");
});

Deno.test("序列化：not、三层嵌套与 any 多分支", () => {
  const tree: GalleryAdvancedQuery = [{
    not: [{
      any: [
        [
          {
            is: { plugin: { pluginId: "pixiv" }, mediaType: { kind: "image" } },
          },
          { not: [{ is: { name: { bucket: "japanese" } } }] },
        ],
        [{ any: [[{ is: { size: { range: "large" } } }]] }],
      ],
    }],
  }];
  assertEquals(
    body(tree),
    "~not/~any/plugin/pixiv/filter_comb/media-type/image/filter_comb/~not/name/japanese/~end/~or/~any/size/large/~end/~end/~end",
  );
});

Deno.test("规范化：空树、空原子、空分支与空 not 被剔除", () => {
  const tree: GalleryAdvancedQuery = [
    { is: {} },
    { any: [[], [{ is: {} }]] },
    { not: [{ is: {} }] },
  ];
  assert(isEmptyQuery(tree));
  assertEquals(normalizeQuery(tree), []);
  assertEquals(serializeAdvancedQuery(tree), { body: "all", endsAtHub: false });
});

Deno.test("往返：search 原子与可合并邻居", () => {
  const tree: GalleryAdvancedQuery = [
    { is: { plugin: { pluginId: "pixiv" } } },
    { is: { date: { segment: "2026-08" } } },
    { is: { search: { mode: "metadata", query: "星空" } } },
  ];
  assertEquals(roundTrip(tree), normalizeQuery(tree));
});

Deno.test("往返：同格冲突断行", () => {
  const tree: GalleryAdvancedQuery = [
    { is: { plugin: { pluginId: "pixiv" } } },
    { is: { plugin: { pluginId: "konachan" }, size: { range: "large" } } },
  ];
  assertEquals(roundTrip(tree), normalizeQuery(tree));
});

Deno.test("往返：any 多分支与双重 not", () => {
  const tree: GalleryAdvancedQuery = [
    {
      any: [
        [{ is: { mediaType: { kind: "image", format: "png" } } }],
        [{ is: { aspect: { range: "portrait-9x16-3x4" } } }],
      ],
    },
    { not: [{ not: [{ is: { name: { bucket: "chinese" } } }] }] },
  ];
  assertEquals(roundTrip(tree), normalizeQuery(tree));
});

Deno.test("解析：未闭合组、错位记号与未知记号返回 null", () => {
  assertEquals(parseAdvancedBody(["~not", "plugin", "pixiv"]), null);
  assertEquals(parseAdvancedBody(["~or", "plugin", "pixiv"]), null);
  assertEquals(parseAdvancedBody(["~wat", "plugin", "pixiv"]), null);
});

Deno.test("stripSearchPrefix：全局前缀照剥，原子 search 守卫不剥", () => {
  const global = parseComposablePath("search/metadata/星空/sort/by-time/1");
  assertEquals({
    search: global.search,
    mode: global.searchMode,
    advanced: global.advanced,
  }, {
    search: "星空",
    mode: "metadata",
    advanced: undefined,
  });

  const local = parseComposablePath(
    "search/metadata/星空/filter_comb/~any/plugin/pixiv/~end/sort/by-time/1",
  );
  assertEquals(local.search, "");
  assertEquals(local.advanced, [
    { is: { search: { mode: "metadata", query: "星空" } } },
    { any: [[{ is: { plugin: { pluginId: "pixiv" } } }]] },
  ]);
});

Deno.test("stripSearchPrefix：全局搜索与原子 search 可同时存在", () => {
  const tree: GalleryAdvancedQuery = [
    { any: [[{ is: { plugin: { pluginId: "pixiv" } } }]] },
    { is: { search: { mode: "native-metadata", query: "夜空" } } },
  ];
  const path = buildComposablePath({
    filters: tree,
    sort: { field: "by-name", desc: false },
    page: 1,
    search: "星空",
    searchMode: "metadata",
  });
  const parsed = parseComposablePath(path);
  assertEquals(parsed.search, "星空");
  assertEquals(parsed.searchMode, "metadata");
  assertEquals(parsed.advanced, normalizeQuery(tree));
});

Deno.test("NodePath：定位、不可变更新、删除与 not 奇偶", () => {
  const tree: GalleryAdvancedQuery = [{
    any: [
      [{ not: [{ not: [{ is: { plugin: { pluginId: "pixiv" } } }] }] }],
      [{ not: [{ is: { name: { bucket: "japanese" } } }] }],
    ],
  }];
  const evenPath = [0, 0, 0, 0, 0];
  const oddPath = [0, 1, 0, 0];
  assertEquals(getNode(tree, evenPath), {
    is: { plugin: { pluginId: "pixiv" } },
  });
  assertEquals(notParity(tree, evenPath), false);
  assertEquals(notParity(tree, oddPath), true);

  const updated = updateNode(
    tree,
    evenPath,
    () => ({ is: { size: { range: "large" } } }),
  );
  assertEquals(getNode(updated, evenPath), {
    is: { size: { range: "large" } },
  });
  assertEquals(getNode(tree, evenPath), {
    is: { plugin: { pluginId: "pixiv" } },
  });
  assertEquals(removeNode(updated, evenPath), [{
    any: [[{ not: [{ not: [] }] }], [{
      not: [{ is: { name: { bucket: "japanese" } } }],
    }]],
  }]);
});

Deno.test("conditionCount 统计所有 is 节点", () => {
  const tree: GalleryAdvancedQuery = [
    { is: {} },
    { any: [[{ is: { plugin: { pluginId: "a" } } }], [{ not: [{ is: {} }] }]] },
  ];
  assertEquals(conditionCount(tree), 3);
});

Deno.test("facetListPath：普通减格、not 解包与 mediaType 映射", () => {
  const ordinary: GalleryAdvancedQuery = [{
    is: { plugin: { pluginId: "pixiv" }, date: { segment: "2026-08" } },
  }];
  assertEquals(
    facetListPath(ordinary, [0], "plugin"),
    "date/2026y/08m/filter_comb/plugin",
  );

  const negated: GalleryAdvancedQuery = [{
    not: [{ is: { plugin: { pluginId: "pixiv" }, date: { segment: "2026" } } }],
  }];
  assertEquals(
    facetListPath(negated, [0, 0], "plugin"),
    "date/2026y/filter_comb/plugin",
  );

  const media: GalleryAdvancedQuery = [{
    is: { plugin: { pluginId: "pixiv" }, mediaType: { kind: "image" } },
  }];
  assertEquals(
    facetListPath(media, [0], "mediaType"),
    "plugin/pixiv/filter_comb/media-type",
  );
  assertThrows(() => facetListPath(media, [0], "wallpaperOrder"));
});

Deno.test("search 使用 PathQL 段转义并可逆", () => {
  const tilde: GalleryAdvancedQuery = [{
    any: [[{ is: { search: { mode: "metadata", query: "~星空" } } }]],
  }];
  assert(body(tilde).includes("search/metadata/\\~星空"));
  assertEquals(roundTrip(tilde), normalizeQuery(tilde));

  const slash: GalleryAdvancedQuery = [{
    any: [[{ is: { search: { mode: "metadata", query: "a/b" } } }]],
  }];
  assert(body(slash).includes("search/metadata/a\\/b"));
  assertEquals(roundTrip(slash), normalizeQuery(slash));
});

Deno.test("解析严格性：不可表达的路径整体回退为 null", () => {
  // 空分支 = 引擎恒真, 树上无法表达 —— 不许剪掉后静默反转语义。
  assertEquals(parseAdvancedBody("~any/plugin/pixiv/~or/~end".split("/")), null);
  // 空 ~not = NOT(恒真)。
  assertEquals(parseAdvancedBody("~not/~end".split("/")), null);
  // 树上无法表达的维度 chunk(no-album / date-range / 未知段)整体回退。
  assertEquals(
    parseAdvancedBody("~any/no-album/~or/plugin/pixiv/~end".split("/")),
    null,
  );
  assertEquals(
    parseAdvancedBody("~any/date-range/2024~2025/~or/plugin/pixiv/~end".split("/")),
    null,
  );
  assertEquals(
    parseAdvancedBody("~any/bogus-dimension/x/~or/plugin/pixiv/~end".split("/")),
    null,
  );
});

Deno.test("解析降级：parseComposablePath 对坏高级路径给空过滤而非平铺", () => {
  const parsed = parseComposablePath(
    "~any/plugin/pixiv/filter_comb/date/2024y/~or/~end/sort/by-time/1",
  );
  assertEquals(parsed.advanced, undefined);
  // 不许把组内的 plugin/date 摊平进简单过滤。
  assertEquals(parsed.filters, {});
  assertEquals(parsed.sort.field, "by-time");
});
