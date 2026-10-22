import { describe, expect, it, vi } from "vitest";
import { albumImageCountQuery, normalizeAlbumRow, albumPageQueries } from "./albums";

const pathqlFetch = vi.hoisted(() => vi.fn());
vi.mock("@/services/pathql", () => ({ pathqlFetch, pathqlEntry: vi.fn() }));
vi.mock("@/api/rpc", () => ({ invoke: vi.fn() }));
vi.mock("@/services/dataChangeHub", () => ({ albumChangeBatch: vi.fn(), publishLocal: vi.fn() }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: vi.fn() }));
vi.mock("@kabegame/element-plus", () => ({ ElMessageBox: {} }));
vi.mock("@kabegame/i18n", () => ({ i18n: {} }));

describe("画册页查询描述", () => {
  it("分页与搜索同时作用于画册行、同类型直接子项，hide 只改变图片计数", () => {
    const page = albumPageQueries({ parentId: "parent" }, 2, "hide/", ["label", "label_dir"], 30, "a b")!;
    const base = "albums://parent/parent/search/a%20b/~any/album_kind/label/~or/album_kind/label_dir/~end/x30x/2";
    expect(page.queries).toEqual([
      { kind: "fetch", path: base },
      { kind: "fetch", path: `${base}/~~/children/search/a%20b/~any/album_kind/label/~or/album_kind/label_dir/~end` },
    ]);
    expect(page.extra!.queries.at(-1)?.path).toBe(`${base}/~~/images/hide`);
    expect(albumPageQueries({ parentId: "parent" }, 2, "", ["label", "label_dir"], 30, "a b")!.queries).toEqual(
      page.queries,
    );
    expect(pathqlFetch).not.toHaveBeenCalled();
  });

  it("标签目录显示直接子画册数，叶子图片数独立到达，无分组结果补零", () => {
    const page = albumPageQueries({ section: "label" }, 1, "")!;
    const rows = [
      { id: "dir", type: "label_dir" },
      { id: "leaf", type: "label" },
      { id: "empty", type: "label" },
    ];
    const nodes = page.parse([rows, [{ id: "dir", child_count: 2 }]]);
    expect(nodes.map((node) => [node.id, node.childCount, node.count])).toEqual([
      ["dir", 2, 2],
      ["leaf", 0, null],
      ["empty", 0, null],
    ]);
    // extra 不依赖结构 parse 的执行顺序，独立返回完整补丁。
    const extra = albumPageQueries({ section: "label" }, 1, "")!.extra!;
    expect([...extra.parse([rows, [{ id: "leaf", image_count: 7 }]])]).toEqual([
      ["leaf", { count: 7 }],
      ["empty", { count: 0 }],
    ]);
  });

  it("没有允许类型时没有这一页，不发任何查询", () => {
    expect(albumPageQueries({ section: "normal" }, 1, "", [])).toBeNull();
  });
});

describe("画册头部图片计数查询", () => {
  it.each([
    ["label_dir", "albums://parent/a%2Fb"],
    ["label", "images://gallery/album/a%2Fb"],
    ["normal", "images://gallery/album-tree/a%2Fb"],
    ["local_folder", "images://gallery/album-tree/a%2Fb"],
  ])("%s 的固定空前缀查询", (type, path) => {
    expect(albumImageCountQuery(normalizeAlbumRow({ id: "a/b", type }))).toEqual({ kind: "count", path });
  });
});
