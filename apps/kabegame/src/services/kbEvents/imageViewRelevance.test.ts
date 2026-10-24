import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addedTrigger,
  deletedTrigger,
  hiddenTrigger,
  imageMayMatchQuery,
  patchTriggers,
  type ImageViewState,
} from "./imageViewRelevance";
import {
  queryUsesSearchMode,
  type GalleryFilterSet,
  type GalleryQuery,
  type GallerySearchPathMode,
} from "@/utils/galleryQuery";
import type { ImageInfo } from "@/types/image";

vi.mock("@/services/albums", () => ({
  HIDDEN_ALBUM_ID: "00000000-0000-0000-0000-000000000000",
}));
const env = vi.hoisted(() => ({ web: false }));
vi.mock("@/env", () => ({
  get IS_WEB() {
    return env.web;
  },
}));
const image = (fields: Partial<ImageInfo> = {}): ImageInfo => ({ id: "new", localPath: "/new", ...fields });
const query = (atom: GalleryFilterSet): GalleryQuery => [{ is: atom }];
const view = (fields: Partial<ImageViewState> = {}): ImageViewState => ({
  query: [],
  sort: { field: "by-time", desc: false },
  hide: false,
  ...fields,
});
const search = (mode: GallerySearchPathMode): GalleryQuery => query({ search: { modes: [mode], query: "word" } });
beforeEach(() => {
  env.web = false;
});

describe("imageMayMatchQuery 与 provider 口径", () => {
  it("插件不符排除，同插件的扩展路径视为可能", () => {
    expect(imageMayMatchQuery(image({ pluginId: "x" }), query({ plugin: { pluginId: "y" } }))).toBe(false);
    expect(imageMayMatchQuery(image(), query({ plugin: { pluginId: "x" } }))).toBe(false);
    expect(
      imageMayMatchQuery(image({ pluginId: "x" }), query({ plugin: { pluginId: "x", extendPath: "unknown" } })),
    ).toBe(true);
  });
  it.each([
    [undefined, "image", undefined, true],
    ["video", "video", undefined, true],
    ["VIDEO/MP4", "video", "mp4", true],
    ["video/mp4", "image", undefined, false],
    ["image/png", "image", "jpg", false],
    ["png", "image", "png", true],
  ] as const)("媒体类型 %s / %s / %s → %s", (type, kind, format, expected) => {
    expect(imageMayMatchQuery(image({ type }), query({ mediaType: { kind, format } }))).toBe(expected);
  });
  it("日期按本地年月日，秒 / 毫秒与后端阈值一致", () => {
    const date = new Date(2026, 9, 23, 0, 0, 0);
    for (const crawledAt of [date.getTime(), date.getTime() / 1000]) {
      for (const segment of ["2026", "2026-10", "2026-10-23"]) {
        expect(imageMayMatchQuery(image({ crawledAt }), query({ date: { segment } }))).toBe(true);
      }
      expect(imageMayMatchQuery(image({ crawledAt }), query({ date: { segment: "2026-10-22" } }))).toBe(false);
    }
    // 阈值本身仍是秒；大于阈值才除以 1000。
    const edge = 253402300800;
    const localYear = String(new Date(Math.trunc(edge / 1000) * 1000).getFullYear());
    expect(imageMayMatchQuery(image({ crawledAt: edge }), query({ date: { segment: localYear } }))).toBe(true);
    expect(imageMayMatchQuery(image({ crawledAt: edge - 1 }), query({ date: { segment: "9999" } }))).toBe(true);
  });
  it("web 的服务器时区未知、异常日期一律视为可能", () => {
    const q = query({ date: { segment: "1900" } });
    env.web = true;
    expect(imageMayMatchQuery(image({ crawledAt: Date.now() }), q)).toBe(true);
    env.web = false;
    for (const crawledAt of [undefined, NaN, Number.MAX_VALUE])
      expect(imageMayMatchQuery(image({ crawledAt }), q)).toBe(true);
  });
  it.each([
    [undefined, "unknown", true],
    [0, "unknown", true],
    [-1, "unknown", true],
    [1, "unknown", false],
    [undefined, "1B-512KB", false],
    [1, "1B-512KB", true],
    [524287, "1B-512KB", true],
    [524288, "1B-512KB", false],
    [524288, "512kb-1mb", true],
    [0, "-1KB", false],
    [1, "-1KB", true],
    [1073741824, "1GB-", true],
    [Number.MAX_SAFE_INTEGER, "1GB-", false],
    [123, "bad", true],
    [123, "1TB-", true],
    [123, "999999999999999999GB-", true],
  ])("大小 %s / %s → %s", (size, range, expected) => {
    expect(
      imageMayMatchQuery(image({ size: size as number | undefined }), query({ size: { range: range as string } })),
    ).toBe(expected);
  });
  it.each([
    [undefined, 100, "unknown", true],
    [100, 0, "unknown", true],
    [100, -1, "unknown", true],
    [100, 100, "unknown", false],
    [undefined, 100, "-3x4", false],
    [300, 400, "-3x4", true],
    [300, 400, "3x4-4x3", false],
    [400, 300, "3x4-4x3", true],
    [1920, 1080, "4x3-16x9", true],
    [1921, 1080, "16x9-", true],
    [100, 200, "1x2-2x3", false],
    [200, 300, "1x2-2x3", true],
    [201, 300, "1x2-2x3", false],
    [1, 1, "invalid", true],
    [1.5, 1, "1x1-2x1", true],
    [1, 1, "1x1-999999999999999999x1", true],
  ])("宽高比 %s x %s / %s → %s", (width, height, range, expected) => {
    expect(
      imageMayMatchQuery(
        image({ width: width as number | undefined, height: height as number }),
        query({ aspect: { range: range as string } }),
      ),
    ).toBe(expected);
  });
  it("顶层 AND 逐项排除，any / not / search 不排除", () => {
    const no = { plugin: { pluginId: "different" } };
    expect(imageMayMatchQuery(image(), [{ any: [query(no)] }, { not: query(no) }, ...search("display-name")])).toBe(
      true,
    );
    expect(imageMayMatchQuery(image(), [{ any: [[]] }, ...query(no)])).toBe(false);
    expect(imageMayMatchQuery(image(), [])).toBe(true);
  });
});

describe("queryUsesSearchMode", () => {
  it("递归 any / not，只有词与模式都生效才有依赖", () => {
    const q: GalleryQuery = [{ any: [[{ not: search("metadata") }], search("url")] }];
    expect(queryUsesSearchMode(q, "metadata")).toBe(true);
    expect(queryUsesSearchMode(q, "url")).toBe(true);
    expect(queryUsesSearchMode(q, "display-name")).toBe(false);
    expect(queryUsesSearchMode(query({ search: { modes: ["metadata"], query: "  " } }), "metadata")).toBe(false);
    expect(queryUsesSearchMode(query({ search: { modes: [], query: "word" } }), "metadata")).toBe(false);
  });
});

describe("patchTriggers 字段依赖表", () => {
  const cases: [string, ImageViewState, boolean][] = [
    ["thumbnailPath", view(), false],
    ["thumbnailPath", view({ sort: { field: "by-name", desc: true }, query: search("display-name") }), false],
    ["compatiblePath", view(), false],
    ["lastSetWallpaperAt", view(), false],
    ["lastSetWallpaperAt", view({ sort: { field: "by-set-time", desc: false } }), true],
    ["displayName", view(), false],
    ["displayName", view({ sort: { field: "by-name", desc: false } }), true],
    ["displayName", view({ query: search("display-name") }), true],
    ["displayName", view({ query: search("metadata") }), false],
    ["metadataId", view(), false],
    ["metadataId", view({ query: search("metadata") }), true],
    ["metadataId", view({ query: [{ not: query({ plugin: { pluginId: "x" } }) }] }), true],
    ["imageMetadataId", view(), false],
    ["imageMetadataId", view({ query: search("native-metadata") }), true],
    ["pluginId", view(), false],
    ["pluginId", view({ query: [{ any: [query({ plugin: { pluginId: "x" } })] }] }), true],
    ["postUrl", view(), false],
    ["postUrl", view({ query: search("url") }), true],
    ["taskId", view(), false],
    ...["surfRecordId", "width", "height", "size", "type", "crawledAt", "localPath", "newField"].map(
      (field): [string, ImageViewState, boolean] => [field, view(), true],
    ),
  ];
  it.each(cases)("%s / %j → %s，单图与批量一致", (field, state, expected) => {
    for (const trigger of patchTriggers(() => state)) {
      const patch = { id: "any", [field]: null };
      expect(trigger.relevant(trigger.event === "image-changed" ? { patch } : { patches: [patch] })).toBe(expected);
    }
  });
  it("空补丁不刷新、混合字段任一个相关即刷新、extra 可补充依赖并读最新状态", () => {
    let state = view();
    const triggers = patchTriggers(() => state, { surfRecordId: (v) => v.hide });
    expect(triggers[0]!.relevant({ patch: { id: "a" } })).toBe(false);
    expect(triggers[1]!.relevant({ patches: [] })).toBe(false);
    expect(
      triggers[1]!.relevant({
        patches: [
          { id: "a", thumbnailPath: "p" },
          { id: "b", width: 1 },
        ],
      }),
    ).toBe(true);
    expect(triggers[0]!.relevant({ patch: { id: "a", surfRecordId: null } })).toBe(false);
    state = view({ hide: true });
    expect(triggers[0]!.relevant({ patch: { id: "a", surfRecordId: null } })).toBe(true);
  });
});

describe("新增与隐藏触发", () => {
  it("新增同时检查归属与查询，读取最新视图", () => {
    let state = view({ query: query({ plugin: { pluginId: "y" } }) });
    const trigger = addedTrigger(
      () => state,
      (row) => row.taskId === "a",
    );
    expect(trigger.relevant({ images: [image({ pluginId: "x", taskId: "a" })] })).toBe(false);
    expect(trigger.relevant({ images: [image({ pluginId: "y", taskId: "b" })] })).toBe(false);
    expect(trigger.relevant({ images: [image({ pluginId: "y", taskId: "a" })] })).toBe(true);
    state = view();
    expect(trigger.relevant({ images: [image({ pluginId: "x", taskId: "a" })] })).toBe(true);
    expect(trigger.relevant({ images: [] })).toBe(false);
  });
  it("hide 开启才响应隐藏画册", () => {
    let state = view();
    const trigger = hiddenTrigger(() => state);
    const payload = { albumIds: ["00000000-0000-0000-0000-000000000000"] };
    expect(trigger.relevant(payload)).toBe(false);
    state = view({ hide: true });
    expect(trigger.relevant(payload)).toBe(true);
    expect(trigger.relevant({ albumIds: ["other"] })).toBe(false);
  });
});

describe("删除触发", () => {
  it("传 heldIds 只在命中时刷新并读最新值，不传则任何删除都刷新", () => {
    let held = ["a", "b"];
    const rows = deletedTrigger(() => held);
    expect(rows.event).toBe("images-deleted");
    expect(rows.relevant({ seq: 1, imageIds: ["x"] })).toBe(false);
    expect(rows.relevant({ seq: 1, imageIds: ["x", "b"] })).toBe(true);
    held = ["c"];
    expect(rows.relevant({ seq: 1, imageIds: ["a"] })).toBe(false);
    const count = deletedTrigger();
    expect(count.relevant({ seq: 1, imageIds: ["x"] })).toBe(true);
  });
});
