/**
 * P11d：来源表的快捷方式图标（`usertex/sources.ts`）：`parseShortcutIcon`、键变了才取图标、空键 / 无图标 / 失败用缺省纹理、
 * 补透明边的纹理尺寸与纹理名、按键缓存、后发先至。
 */
import { describe, expect, it } from "vitest";
import { parseShortcutIcon, UserTextureSources, type ShortcutIcon, type UserTextureDeps } from "./sources";

interface FakeBitmap {
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

function icon(width: number, height: number): ShortcutIcon {
  return { width, height, rgba: new Uint8Array(width * height * 4) };
}

/** 假依赖：`icons` 是属性名 → 图标（null = 没有图标，缺项 = 抛错）；`hold` 让某个属性名的取图卡住。 */
function harness(icons: Record<string, ShortcutIcon | null>) {
  const asked: string[] = [];
  const bitmaps: FakeBitmap[] = [];
  const logs: string[] = [];
  const holds = new Map<string, Promise<void>>();
  const deps: Partial<UserTextureDeps> = {
    async shortcutIcon(name) {
      asked.push(name);
      const gate = holds.get(name);
      if (gate) await gate;
      if (!(name in icons)) throw new Error("取不到");
      return icons[name];
    },
    async bitmapFromIcon(source) {
      const bitmap: FakeBitmap = {
        width: source.width,
        height: source.height,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      bitmaps.push(bitmap);
      return bitmap as unknown as ImageBitmap;
    },
    now: () => 0,
    log: (message) => logs.push(message),
  };
  const hold = (name: string) => {
    let release!: () => void;
    holds.set(
      name,
      new Promise<void>((resolve) => {
        release = () => {
          holds.delete(name);
          resolve();
        };
      }),
    );
    return release;
  };
  const sources = new UserTextureSources(async () => new Uint8Array(), deps);
  return { sources, asked, bitmaps, logs, hold };
}

describe("parseShortcutIcon", () => {
  const bytes = (width: number, height: number, extra = 0) => {
    const data = new Uint8Array(8 + width * height * 4 + extra);
    const view = new DataView(data.buffer);
    view.setUint32(0, width, true);
    view.setUint32(4, height, true);
    data.fill(7, 8);
    return data;
  };

  it("[宽 u32 LE][高 u32 LE][RGBA]：解出宽高与像素", () => {
    const parsed = parseShortcutIcon(bytes(3, 2))!;
    expect([parsed.width, parsed.height, parsed.rgba.length]).toEqual([3, 2, 24]);
    expect(parsed.rgba[0]).toBe(7);
  });

  it("接收 ArrayBuffer 与带偏移的视图", () => {
    const data = bytes(2, 2);
    expect(parseShortcutIcon(data.buffer)).not.toBeNull();
    const padded = new Uint8Array(4 + data.length);
    padded.set(data, 4);
    expect(parseShortcutIcon(padded.subarray(4))?.width).toBe(2);
  });

  it("0 字节（没配、取不到、非 Windows）、头不全、宽高为 0、长度对不上都是 null", () => {
    expect(parseShortcutIcon(new Uint8Array())).toBeNull();
    expect(parseShortcutIcon(new Uint8Array(7))).toBeNull();
    expect(parseShortcutIcon(bytes(0, 4))).toBeNull();
    expect(parseShortcutIcon(bytes(4, 0))).toBeNull();
    expect(parseShortcutIcon(bytes(2, 2, 1))).toBeNull();
    expect(parseShortcutIcon(bytes(2, 2).subarray(0, 20))).toBeNull();
  });
});

describe("UserTextureSources：快捷方式来源（P11d）", () => {
  it("键变了才取图标：同一个键不重复取，换键重取；纹理按槽比例补透明边", async () => {
    const h = harness({ sc: icon(256, 256) });
    h.sources.setValue("sc", "k1", "usershortcut");
    await h.sources.settled();
    expect(h.asked).toEqual(["sc"]);
    expect(h.sources.status("sc")).toBe("ready");
    h.sources.setValue("sc", "k1", "usershortcut");
    expect(h.asked).toEqual(["sc"]);
    // 2:1 的槽：512×256、图标摆在 x = 128；纹理名 usershortcut_<键>x<round(2·10)>
    const crop = h.sources.crop("sc", { width: 200, height: 100 })!;
    expect(crop.key).toBe("usershortcut_k1x20");
    expect(crop.rect).toEqual({ x: 0, y: 0, width: 512, height: 256 });
    expect(crop.pad).toEqual({ x: 128, y: 0 });
    expect(crop.image?.width).toBe(256);
    expect(crop.animation).toBeUndefined();
    // 换键（值变了）：旧请求作废、重取
    h.sources.setValue("sc", "k2", "usershortcut");
    await h.sources.settled();
    expect(h.asked).toEqual(["sc", "sc"]);
    expect(h.sources.crop("sc", { width: 1, height: 1 })!.key).toBe("usershortcut_k2x10");
  });

  it("精灵表帧比例与 1:4 的槽：426×256 偏移 85、256×1024 偏移 384；比例四舍五入到 0.1 相同的槽共用先建的那个", async () => {
    const h = harness({ sc: icon(256, 256) });
    h.sources.setValue("sc", "k", "usershortcut");
    await h.sources.settled();
    const sheet = h.sources.crop("sc", { width: 85.334, height: 51.2 })!;
    expect(sheet.rect).toMatchObject({ width: 426, height: 256 });
    expect(sheet.pad).toEqual({ x: 85, y: 0 });
    const tall = h.sources.crop("sc", { width: 64, height: 256 })!;
    expect(tall.rect).toMatchObject({ width: 256, height: 1024 });
    expect(tall.pad).toEqual({ x: 0, y: 384 });
    // 1.66668 与 1.7 都四舍五入到 17：共用名字，按先建的（1.66668）补
    const near = h.sources.crop("sc", { width: 170, height: 100 })!;
    expect(near.key).toBe(sheet.key);
    expect(near.rect).toEqual(sheet.rect);
  });

  it("keepaspect（reference 为 null）：不补边，整张图标", async () => {
    const h = harness({ sc: icon(160, 160) });
    h.sources.setValue("sc", "k", "usershortcut");
    await h.sources.settled();
    const crop = h.sources.crop("sc", null)!;
    expect(crop.key).toBe("usershortcut_kx0");
    expect(crop.rect).toEqual({ x: 0, y: 0, width: 160, height: 160 });
    expect(crop.pad).toEqual({ x: 0, y: 0 });
  });

  it("空键（没配）当场记成无图，不向后端要；没有图标（0 字节）是 empty，取图失败是 failed，都没有 crop", async () => {
    const h = harness({ none: null });
    h.sources.setValue("sc", "", "usershortcut");
    expect(h.sources.status("sc")).toBe("empty");
    h.sources.setValue("none", "k", "usershortcut");
    h.sources.setValue("boom", "k", "usershortcut");
    await h.sources.settled();
    expect(h.asked).toEqual(["none", "boom"]);
    expect(h.sources.status("none")).toBe("empty");
    expect(h.sources.status("boom")).toBe("failed");
    expect(h.logs.join("\n")).toMatch(/boom：取快捷方式图标失败（取不到）/);
    for (const name of ["sc", "none", "boom"]) expect(h.sources.crop(name, { width: 1, height: 1 })).toBeNull();
  });

  it("按键缓存：切走再切回同一个键不重取；每次落地都通知 onReady", async () => {
    const h = harness({ sc: icon(64, 64) });
    const ready: string[] = [];
    h.sources.onReady = (name) => ready.push(name);
    h.sources.setValue("sc", "a", "usershortcut");
    await h.sources.settled();
    h.sources.setValue("sc", "b", "usershortcut");
    await h.sources.settled();
    expect(h.asked).toEqual(["sc", "sc"]);
    h.sources.setValue("sc", "a", "usershortcut");
    expect(h.asked).toEqual(["sc", "sc"]);
    expect(h.sources.status("sc")).toBe("ready");
    expect(ready).toEqual(["sc", "sc", "sc"]);
  });

  it("后发先至：键又变了，旧请求的位图关掉、不落地", async () => {
    const h = harness({ sc: icon(32, 32) });
    const release = h.hold("sc");
    h.sources.setValue("sc", "old", "usershortcut");
    h.sources.setValue("sc", "", "usershortcut");
    release();
    await h.sources.settled();
    expect(h.sources.status("sc")).toBe("empty");
    expect(h.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
    expect(h.sources.crop("sc", { width: 1, height: 1 })).toBeNull();
  });

  it("prime 带第三项的种类；缺省种类（属性）仍按文件读，不走 shortcutIcon", async () => {
    const h = harness({ sc: icon(16, 16) });
    await h.sources.prime([
      ["sc", "k", "usershortcut"],
      ["plain", ""],
    ]);
    expect(h.asked).toEqual(["sc"]);
    expect(h.sources.status("sc")).toBe("ready");
    expect(h.sources.status("plain")).toBe("empty");
  });

  it("同一个值换种类（属性 ↔ 快捷方式）不当作没变", async () => {
    const h = harness({ x: icon(8, 8) });
    h.sources.setValue("x", "k", "property");
    h.sources.setValue("x", "k", "usershortcut");
    await h.sources.settled();
    expect(h.asked).toEqual(["x"]);
  });

  it("dispose 之后到达的图标关掉位图", async () => {
    const h = harness({ sc: icon(8, 8) });
    const release = h.hold("sc");
    h.sources.setValue("sc", "k", "usershortcut");
    h.sources.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve));
    expect(h.sources.status("sc")).toBe("none");
    expect(h.bitmaps.every((bitmap) => bitmap.closed)).toBe(true);
  });
});
