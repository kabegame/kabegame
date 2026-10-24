// @vitest-environment happy-dom
import { flushPromises, shallowMount } from "@vue/test-utils";
import { reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AlbumTreeView from "./AlbumTreeView.vue";
import { FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID, normalizeAlbumRow, type AlbumNode } from "@/services/albums";
import type { TreeBranch, TreeQuerySource } from "@/components/tree/types";

const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@/api", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));
vi.mock("@/api/rpc", () => ({ invoke: vi.fn() }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }), i18n: {} }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ values: {} }) }));
vi.mock("@/stores/pathRoute", () => ({ useGlobalPathRoute: () => route }));
vi.mock("@/components/tree/KbTreePanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/tree/useTreeModel", () => ({
  useTreeModel: (opts: { dataSource: TreeQuerySource<AlbumNode> }) => {
    source = opts.dataSource;
    return {
      nodeByKey: (id: string) => held.get(id),
      refresh: vi.fn(),
      mapElements: (fn: (node: AlbumNode) => AlbumNode) =>
        held.forEach((handle) => {
          handle.element = fn(handle.element);
        }),
    };
  },
}));
const route = reactive({ hide: false });
const held = new Map<string, { element: AlbumNode }>();
let source!: TreeQuerySource<AlbumNode>;
const wrappers: ReturnType<typeof shallowMount>[] = [];
const node = (id: string, type = "normal", ancestorPath = `/${id}/`): AlbumNode => ({
  ...normalizeAlbumRow({ id, type, ancestor_path: ancestorPath }),
  count: 1,
  childCount: 1,
});
async function fixture() {
  const wrapper = shallowMount(AlbumTreeView, { props: { selectedId: null, searchText: "" } });
  wrappers.push(wrapper);
  await flushPromises();
}
function accepts(branch: TreeBranch<AlbumNode>, part: "page" | "extra", event: string, payload: unknown) {
  return source.refreshOn(branch, part).some((trigger) => trigger.event === event && trigger.relevant(payload));
}
const section = (sectionId: string): TreeBranch<AlbumNode> => ({ kind: "section", sectionId });
const member = (albumId: string, ancestorPath = `/${albumId}/`, imagesDeleted = false) => ({
  albumId,
  ancestorPath,
  imageIds: ["x"],
  imagesDeleted,
});
beforeEach(() => {
  route.hide = false;
  held.clear();
  for (const [id, type] of [
    ["normal", "normal"],
    ["label", "label_dir"],
    ["folder", "local_folder"],
  ]) {
    held.set(id, { element: node(id, type) });
  }
});
afterEach(async () => {
  wrappers.splice(0).forEach((w) => w.unmount());
  await flushPromises();
});

describe("Phase F 画册树刷新", () => {
  it("成员增删只刷新所属分区 extra；系统区只认收藏 / 隐藏，收藏不误刷缺失根的普通分区", async () => {
    await fixture();
    for (const event of ["album-images-added", "album-images-deleted"]) {
      for (const id of ["normal", "label", "folder"]) {
        for (const branch of ["normal", "label", "local_folder", "system"]) {
          const expected = branch === (id === "folder" ? "local_folder" : id);
          expect(accepts(section(branch), "extra", event, member("deep", `/${id}/deep/`))).toBe(expected);
          expect(accepts(section(branch), "page", event, member("deep", `/${id}/deep/`))).toBe(false);
        }
      }
      for (const albumId of [FAVORITE_ALBUM_ID, HIDDEN_ALBUM_ID]) {
        expect(accepts(section("system"), "extra", event, member(albumId))).toBe(true);
        for (const branch of ["normal", "label", "local_folder"]) {
          expect(accepts(section(branch), "extra", event, member(albumId))).toBe(false);
        }
      }
    }
    expect(accepts(section("normal"), "extra", "album-images-added", member("deep", "/unknown/deep/"))).toBe(true);
    expect(accepts(section("system"), "extra", "album-images-added", member("deep", "/unknown/deep/"))).toBe(false);
  });
  it("改名只重读已持有行的 page，不刷新 extra，批量补丁逐条判断", async () => {
    await fixture();
    const payload = {
      patches: [
        { id: "missing", name: "无关" },
        { id: "normal", name: "新名" },
      ],
    };
    expect(accepts(section("normal"), "page", "albums-change", payload)).toBe(true);
    expect(accepts(section("normal"), "extra", "albums-change", payload)).toBe(false);
    expect(accepts(section("normal"), "page", "album-changed", { patch: { id: "missing", name: "新名" } })).toBe(false);
  });
  it("带 hide/ 时隐藏增删刷新所有计数，删图造成的隐藏删除只刷新系统区；普通删除仍按成员路径定位", async () => {
    route.hide = true;
    await fixture();
    for (const event of ["album-images-added", "album-images-deleted"]) {
      for (const branch of ["normal", "label", "local_folder", "system"]) {
        expect(accepts(section(branch), "extra", event, member(HIDDEN_ALBUM_ID))).toBe(true);
      }
    }
    expect(accepts(section("normal"), "extra", "album-images-deleted", member(HIDDEN_ALBUM_ID, undefined, true))).toBe(
      false,
    );
    expect(accepts(section("system"), "extra", "album-images-deleted", member(HIDDEN_ALBUM_ID, undefined, true))).toBe(
      true,
    );
    expect(accepts(section("normal"), "extra", "album-images-deleted", member("deep", "/normal/deep/", true))).toBe(
      true,
    );
    expect(accepts(section("label"), "extra", "album-images-deleted", member("deep", "/normal/deep/", true))).toBe(
      false,
    );
    expect(accepts(section("system"), "extra", "album-images-change", member(FAVORITE_ALBUM_ID))).toBe(false);
  });
  it("分区根只对本分区的结构事件刷新，系统区不听结构事件；改名只刷新直接父目录页", async () => {
    await fixture();
    held.set("child", { element: node("child", "normal", "/normal/child/") });
    const deleted = { albums: [{ id: "deep", ancestorPath: "/normal/folded/deep/" }] };
    const moved = { id: "deep", oldAncestorPath: "/normal/a/deep/", newAncestorPath: "/normal/b/deep/" };
    for (const part of ["page", "extra"] as const) {
      expect(accepts(section("normal"), part, "albums-deleted", deleted)).toBe(true);
      expect(accepts(section("normal"), part, "album-moved", moved)).toBe(true);
      for (const branch of ["label", "local_folder", "system"]) {
        expect(accepts(section(branch), part, "albums-deleted", deleted)).toBe(false);
        expect(accepts(section(branch), part, "album-moved", moved)).toBe(false);
      }
    }
    // 新建的根画册未加载时按新行自身类型归区
    const added = { albums: [normalizeAlbumRow({ id: "lf", type: "local_folder", ancestor_path: "/lf/" })] };
    expect(accepts(section("local_folder"), "page", "albums-added", added)).toBe(true);
    expect(accepts(section("normal"), "page", "albums-added", added)).toBe(false);
    // 改名：根级行刷新所在分区页；子画册只刷新父目录页，不刷新分区根与系统区
    const rename = (id: string) => ({ patch: { id, name: "新名" } });
    expect(accepts(section("normal"), "page", "album-changed", rename("normal"))).toBe(true);
    expect(accepts(section("label"), "page", "album-changed", rename("normal"))).toBe(false);
    expect(accepts(section("system"), "page", "album-changed", rename("normal"))).toBe(false);
    expect(accepts(section("normal"), "page", "album-changed", rename("child"))).toBe(false);
    const parent: TreeBranch<AlbumNode> = { kind: "children", parent: node("normal") };
    expect(accepts(parent, "page", "album-changed", rename("child"))).toBe(true);
  });
  it("未加载深层画册的删除与移动按路径定位，新旧两侧目录都刷新；缺路径保守刷新", async () => {
    await fixture();
    const branch: TreeBranch<AlbumNode> = { kind: "children", parent: node("normal") };
    expect(
      accepts(branch, "extra", "albums-deleted", { albums: [{ id: "deep", ancestorPath: "/normal/folded/deep/" }] }),
    ).toBe(true);
    expect(accepts(branch, "extra", "albums-deleted", { albums: [{ id: "normal", ancestorPath: "/normal/" }] })).toBe(
      false,
    );
    expect(
      accepts(branch, "extra", "album-moved", {
        id: "deep",
        oldAncestorPath: "/label/deep/",
        newAncestorPath: "/normal/deep/",
      }),
    ).toBe(true);
    expect(accepts(branch, "extra", "album-images-added", { albumId: "unknown" })).toBe(true);
    listeners.get("album-moved")?.({
      payload: { id: "normal", oldAncestorPath: "/normal/", newAncestorPath: "/else/normal/" },
    });
    expect(held.get("normal")?.element.ancestorPath).toBe("/else/normal/");
    expect(accepts(branch, "extra", "album-images-added", member("deep", "/else/normal/deep/"))).toBe(true);
    expect(accepts(branch, "extra", "album-images-added", member("deep", "/normal/deep/"))).toBe(false);
  });
});
