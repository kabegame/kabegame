import { describe, expect, it } from "vitest";
import { pathForTreeSegment } from "./context";

describe("追加高级条件后的简单 facet 计数", () => {
  it("移除最后一个简单维度时保留 no-album 叶，不请求 filter_comb/all", () => {
    expect(pathForTreeSegment("gallery/hide/no-album/filter_comb/", {
      plugin: { pluginId: "pixiv" },
    }, "plugin", "all")).toBe("gallery/hide/no-album");
  });

  it("候选只替换简单维度，高级 OR 前缀与其它简单条件保留", () => {
    const prefix = "gallery/hide/~any/search/native-metadata/sakura/~or/media-type/image/~end/";
    expect(pathForTreeSegment(prefix, {
      plugin: { pluginId: "pixiv" }, aspect: { range: "landscape-4x3-16x9" },
    }, "plugin", "plugin/konachan")).toBe(
      prefix + "aspect/landscape-4x3-16x9/filter_comb/plugin/konachan",
    );
  });
});
