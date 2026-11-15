/**
 * P11c 步骤 2：来源表的封面来源（`provide`）：系统来源的值按 `provide` 交来的图取、不读文件、当场生效；只留当前与上一张，
 * 更旧的在没有来源引用时关掉位图；`null` / 没交过 = 缺省纹理；裁切与纹理名同属性图片。
 */
import { describe, expect, it } from "vitest";
import { isSystemValue, UserTextureSources, type UserTextureImage } from "./sources";

interface Fake extends UserTextureImage {
  closed: boolean;
}
const image = (width: number, height: number): Fake => {
  const fake = {
    width,
    height,
    gamma: null,
    closed: false,
    source: {
      close() {
        fake.closed = true;
      },
    } as unknown as ImageBitmap,
  } as Fake;
  return fake;
};

function setup() {
  const reads: string[] = [];
  const sources = new UserTextureSources(
    async (path) => {
      reads.push(path);
      throw new Error("不该读文件");
    },
    { decode: async () => Promise.reject(new Error("不该解码")) },
  );
  const ready: string[] = [];
  sources.onReady = (name) => ready.push(name);
  return { sources, reads, ready };
}

describe("UserTextureSources.provide（封面来源，P11c）", () => {
  it("isSystemValue 只认 mediaThumbnail_<N>.system，路径与别的 .system 不算", () => {
    expect(isSystemValue("mediaThumbnail_1.system")).toBe(true);
    expect(isSystemValue("mediaThumbnail_12.system")).toBe(true);
    expect(isSystemValue("D:/a/mediaThumbnail_1.system")).toBe(false);
    expect(isSystemValue("other.system")).toBe(false);
    expect(isSystemValue("mediaThumbnail_.system")).toBe(false);
  });

  it("先交图再设值：不读文件、当场 ready 并通知；裁切取槽的参考尺寸，纹理名是 值 + x + round(比例·10)", () => {
    const { sources, reads, ready } = setup();
    const a = image(320, 180);
    sources.provide("mediaThumbnail_1.system", a);
    expect(ready).toEqual([]);
    sources.setValue("$mediaThumbnail", "mediaThumbnail_1.system");
    expect(reads).toEqual([]);
    expect(ready).toEqual(["$mediaThumbnail"]);
    expect(sources.status("$mediaThumbnail")).toBe("ready");
    // 1:1 槽：180×180，从第 70 列起（居中）；1:4 槽：45×180
    const square = sources.crop("$mediaThumbnail", { width: 100, height: 100 })!;
    expect(square.key).toBe("mediaThumbnail_1.systemx10");
    expect(square.rect).toMatchObject({ width: 180, height: 180, x: 70, y: 0 });
    expect(square.image).toBe(a);
    const narrow = sources.crop("$mediaThumbnail", { width: 100, height: 400 })!;
    expect(narrow.key).toBe("mediaThumbnail_1.systemx3");
    expect(narrow.rect.width).toBe(45);
  });

  it("没有封面（null）或没交过图：状态 empty、crop 为 null，用缺省纹理", () => {
    const { sources } = setup();
    sources.provide("mediaThumbnail_1.system", null);
    sources.setValue("$mediaThumbnail", "mediaThumbnail_1.system");
    expect(sources.status("$mediaThumbnail")).toBe("empty");
    expect(sources.crop("$mediaThumbnail", { width: 10, height: 10 })).toBeNull();
    sources.setValue("$mediaPreviousThumbnail", "mediaThumbnail_9.system");
    expect(sources.status("$mediaPreviousThumbnail")).toBe("empty");
  });

  it("换封面：当前来源指向新名字，上一张留给 previous 来源；只留最近两张，更旧的在没有引用时关掉", () => {
    const { sources, ready } = setup();
    const a = image(100, 100);
    const b = image(100, 100);
    const c = image(100, 100);
    // 第 1 张
    sources.provide("mediaThumbnail_1.system", a);
    sources.setValue("$mediaThumbnail", "mediaThumbnail_1.system");
    // 第 2 张：宿主先交图、再同批设 当前 与 上一张
    sources.provide("mediaThumbnail_2.system", b);
    sources.setValue("$mediaThumbnail", "mediaThumbnail_2.system");
    sources.setValue("$mediaPreviousThumbnail", "mediaThumbnail_1.system");
    expect(sources.crop("$mediaPreviousThumbnail", { width: 10, height: 10 })!.image).toBe(a);
    expect(sources.crop("$mediaThumbnail", { width: 10, height: 10 })!.image).toBe(b);
    expect(a.closed).toBe(false);
    // 第 3 张：第 1 张只被 previous 来源引用到这次 setValue 之前
    sources.provide("mediaThumbnail_3.system", c);
    expect(a.closed).toBe(false); // previous 来源还指着它
    sources.setValue("$mediaThumbnail", "mediaThumbnail_3.system");
    sources.setValue("$mediaPreviousThumbnail", "mediaThumbnail_2.system");
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
    expect(c.closed).toBe(false);
    expect(ready.length).toBe(5);
  });

  it("设到没交过的名字不读文件（也不当成 GIF / 视频）；非封面名字的 provide 关掉位图", () => {
    const { sources, reads } = setup();
    sources.setValue("$mediaThumbnail", "mediaThumbnail_7.system");
    expect(reads).toEqual([]);
    expect(sources.status("$mediaThumbnail")).toBe("empty");
    const stray = image(1, 1);
    sources.provide("D:/x.png", stray);
    expect(stray.closed).toBe(true);
  });

  it("dispose 关掉还留着的封面位图；之后的 provide 直接关掉", () => {
    const { sources } = setup();
    const a = image(1, 1);
    sources.provide("mediaThumbnail_1.system", a);
    sources.dispose();
    expect(a.closed).toBe(true);
    const b = image(1, 1);
    sources.provide("mediaThumbnail_2.system", b);
    expect(b.closed).toBe(true);
  });
});
