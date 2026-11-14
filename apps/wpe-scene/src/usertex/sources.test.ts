import { describe, expect, it } from "vitest";
import {
  DECODED_CACHE_SIZE,
  fileExtension,
  isAnimatedMedia,
  UserTextureSources,
  type UserTextureDeps,
} from "./sources";

interface FakeBitmap {
  width: number;
  height: number;
  closed: boolean;
  close(): void;
}

/** 假依赖：文件内容就是它的路径；`images` 表给每个路径的尺寸；`gate` 让某次读延迟到手动放行。 */
function fakeDeps(images: Record<string, [number, number]>) {
  const reads: string[] = [];
  const decoded: FakeBitmap[] = [];
  const logs: string[] = [];
  const gates = new Map<string, () => void>();
  const failing = new Set<string>();
  const deps: Partial<UserTextureDeps> = {
    async read(path) {
      reads.push(path);
      if (failing.has(path)) throw new Error("读不出");
      const gate = holds.get(path);
      if (gate) await gate;
      return new TextEncoder().encode(path);
    },
    async decode(bytes) {
      const path = new TextDecoder().decode(bytes);
      const size = images[path];
      if (!size) throw new Error("解不出");
      const bitmap: FakeBitmap = {
        width: size[0],
        height: size[1],
        closed: false,
        close() {
          this.closed = true;
        },
      };
      decoded.push(bitmap);
      return bitmap as unknown as ImageBitmap;
    },
    now: () => 0,
    log: (message) => logs.push(message),
  };
  const holds = new Map<string, Promise<void>>();
  /** 让 `path` 的下一次读卡住，返回放行函数。 */
  const hold = (path: string) => {
    let release!: () => void;
    holds.set(
      path,
      new Promise<void>((resolve) => {
        release = () => {
          holds.delete(path);
          resolve();
        };
      }),
    );
    gates.set(path, release);
    return release;
  };
  return { deps, reads, decoded, logs, hold, failing, pixelReads: () => 0 };
}

const SIZES = { "a.png": [300, 200], "b.png": [640, 360], "c.png": [100, 400] } as Record<string, [number, number]>;

function setup(images = SIZES) {
  const fake = fakeDeps(images);
  const sources = new UserTextureSources(async () => new Uint8Array(), fake.deps);
  const ready: string[] = [];
  sources.onReady = (name) => ready.push(name);
  return { ...fake, sources, ready };
}

describe("UserTextureSources：解码、裁切与缓存键", () => {
  it("读文件、解码，完成时通知 onReady；crop 给纹理名、整张源图与裁切矩形", async () => {
    const { sources, ready } = setup();
    sources.setValue("ut", "a.png");
    expect(sources.status("ut")).toBe("loading");
    expect(sources.crop("ut", { width: 1, height: 1 })).toBeNull();
    await sources.settled();
    expect(ready).toEqual(["ut"]);
    expect(sources.status("ut")).toBe("ready");
    const cropped = sources.crop("ut", { width: 1, height: 1 })!;
    expect(cropped.key).toBe("a.pngx10");
    expect(cropped.rect).toEqual({ x: 50, y: 0, width: 200, height: 200 });
    expect(cropped.image.width).toBe(300);
  });

  it("keepaspect（参考尺寸 null）整张进纹理，纹理名比例为 0", async () => {
    const { sources } = setup();
    await sources.prime([["ut", "b.png"]]);
    const cropped = sources.crop("ut", null)!;
    expect(cropped.key).toBe("b.pngx0");
    expect(cropped.rect).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  it("比例四舍五入到 0.1 相同的槽共用纹理名，按先请求的那个槽的精确比例裁", async () => {
    const { sources } = setup();
    await sources.prime([["ut", "b.png"]]);
    const first = sources.crop("ut", { width: 177, height: 100 })!;
    const second = sources.crop("ut", { width: 178, height: 100 })!;
    expect(first.key).toBe("b.pngx18");
    expect(second.key).toBe(first.key);
    // 先建的那个槽（1.77）定矩形：640×360 在 1.77 下 w/h = 1.7777 > 1.77，宽裁成 trunc(360·1.77) = 637
    expect(first.rect.width).toBe(637);
    expect(second.rect).toEqual(first.rect);
    // 不同比例是另一个名字、另一块矩形
    expect(sources.crop("ut", { width: 1, height: 1 })!.key).toBe("b.pngx10");
  });

  it("空串、读不出、解码失败都是无图，回缺省：不保留上一张，只记一条日志", async () => {
    const { sources, ready, logs, failing } = setup();
    await sources.prime([["ut", "a.png"]]);
    expect(sources.crop("ut", null)).not.toBeNull();
    sources.setValue("ut", "");
    expect(sources.status("ut")).toBe("empty");
    expect(sources.crop("ut", null)).toBeNull();
    sources.setValue("ut", "gone.png");
    await sources.settled();
    expect(sources.status("ut")).toBe("failed");
    expect(sources.crop("ut", null)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("gone.png");
    failing.add("a.png");
    sources.setValue("ut", "a.png");
    await sources.settled();
    // a.png 还在缓存里（命中不重读）：这里应当直接就绪，不走读文件
    expect(sources.status("ut")).toBe("ready");
    expect(ready.length).toBeGreaterThanOrEqual(4);
  });

  it("值没变不重复请求；同值再设不通知", async () => {
    const { sources, reads, ready } = setup();
    await sources.prime([["ut", "a.png"]]);
    sources.setValue("ut", "a.png");
    await sources.settled();
    expect(reads).toEqual(["a.png"]);
    expect(ready).toEqual(["ut"]);
  });

  it("按值缓存：切走再切回不重新读文件、解码，当场就绪", async () => {
    const { sources, reads, ready } = setup();
    await sources.prime([["ut", "a.png"]]);
    await sources.prime([["ut", "b.png"]]);
    reads.length = 0;
    ready.length = 0;
    sources.setValue("ut", "a.png");
    expect(sources.status("ut")).toBe("ready");
    expect(ready).toEqual(["ut"]);
    expect(reads).toEqual([]);
  });

  it("两个属性各自指向同一个文件：各自读完互不影响，之后切换命中同一份缓存", async () => {
    const { sources, reads } = setup();
    await sources.prime([
      ["p1", "a.png"],
      ["p2", "a.png"],
    ]);
    expect(sources.crop("p1", null)).not.toBeNull();
    expect(sources.crop("p2", null)).not.toBeNull();
    reads.length = 0;
    sources.setValue("p1", "b.png");
    await sources.settled();
    sources.setValue("p1", "a.png");
    expect(sources.status("p1")).toBe("ready");
    expect(reads).toEqual(["b.png"]);
  });
});

describe("UserTextureSources：竞态", () => {
  it("同一来源连续改值只认最后一次：后发先至的结果丢弃，旧位图被关掉", async () => {
    const { sources, hold, decoded, ready } = setup();
    const releaseA = hold("a.png");
    sources.setValue("ut", "a.png");
    sources.setValue("ut", "b.png");
    // b.png 先读完，a.png 还卡着；放行后它才晚到
    releaseA();
    await sources.settled();
    expect(sources.current("ut")).toBe("b.png");
    expect(sources.status("ut")).toBe("ready");
    expect(sources.crop("ut", null)!.key).toBe("b.pngx0");
    // a.png 的结果被丢弃：只通知过 b.png 那一次，且 a.png 的位图关掉了
    expect(ready).toEqual(["ut"]);
    expect(decoded.find((bitmap) => bitmap.width === 300)!.closed).toBe(true);
  });

  it("旧请求晚到时不覆盖新的空值", async () => {
    const { sources, hold, ready } = setup();
    const releaseA = hold("a.png");
    sources.setValue("ut", "a.png");
    sources.setValue("ut", "");
    expect(sources.status("ut")).toBe("empty");
    releaseA();
    await sources.settled();
    expect(sources.status("ut")).toBe("empty");
    expect(sources.crop("ut", null)).toBeNull();
    expect(ready).toEqual(["ut"]);
  });
});

describe("UserTextureSources：缓存上限与释放", () => {
  it(`只留最近 ${DECODED_CACHE_SIZE} 张解码结果，换出的位图关掉，正在用的不换出`, async () => {
    const images: Record<string, [number, number]> = {};
    for (let i = 0; i < 8; i++) images[`i${i}.png`] = [10 + i, 10];
    const { sources, decoded } = setup(images);
    for (let i = 0; i < 8; i++) await sources.prime([["ut", `i${i}.png`]]);
    const open = decoded.filter((bitmap) => !bitmap.closed);
    expect(open).toHaveLength(DECODED_CACHE_SIZE);
    // 当前值（最后一张）还开着
    expect(sources.crop("ut", null)).not.toBeNull();
    expect(decoded.at(-1)!.closed).toBe(false);
  });

  it("dispose 关掉全部位图，之后的设值与结果都忽略", async () => {
    const { sources, decoded, ready } = setup();
    await sources.prime([["ut", "a.png"]]);
    sources.dispose();
    expect(decoded.every((bitmap) => bitmap.closed)).toBe(true);
    ready.length = 0;
    sources.setValue("ut", "b.png");
    await sources.settled();
    expect(ready).toEqual([]);
    expect(sources.crop("ut", null)).toBeNull();
  });
});

describe("UserTextureSources：GIF 与视频先当无图（步骤 4）", () => {
  it("扩展名不分大小写，GIF 与视频都不读文件、状态 unsupported", async () => {
    const { sources, reads, ready } = setup();
    expect(fileExtension("D:/a/B.GIF")).toBe("gif");
    expect(fileExtension("D:/a.b/noext")).toBe("");
    expect(isAnimatedMedia("x.MP4")).toBe(true);
    expect(isAnimatedMedia("x.webm")).toBe(true);
    expect(isAnimatedMedia("x.png")).toBe(false);
    for (const value of ["D:/a/B.GIF", "D:/a/v.Mp4", "x.mkv", "x.wmv", "x.avi", "x.m4v", "x.mov"]) {
      sources.setValue("ut", value);
      expect(sources.status("ut")).toBe("unsupported");
      expect(sources.crop("ut", null)).toBeNull();
    }
    await sources.settled();
    expect(reads).toEqual([]);
    expect(ready).toHaveLength(7);
  });
});

describe("UserTextureSources：PNG 的 gAMA 校正走读回像素", () => {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type: string, data: number[]) => [
    0,
    0,
    0,
    data.length,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
  const gammaPng = (g: number) => {
    const v = Math.round(g * 1e5);
    return new Uint8Array([
      ...SIGNATURE,
      ...chunk("IHDR", new Array(13).fill(0)),
      ...chunk("gAMA", [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]),
      ...chunk("IDAT", [0]),
    ]);
  };

  function gammaSources(g: number) {
    const closed: boolean[] = [];
    const sources = new UserTextureSources(async () => gammaPng(g), {
      decode: async () => ({ width: 2, height: 1, close: () => closed.push(true) }) as unknown as ImageBitmap,
    });
    return { sources, closed };
  }

  it("g = 1.0：源图仍是位图（直通 alpha，不读回像素、不关掉），带 256 项的校正表交给 GPU 上传时查", async () => {
    const { sources, closed } = gammaSources(1.0);
    await sources.prime([["ut", "g.png"]]);
    const { image } = sources.crop("ut", null)!;
    expect("data" in image.source).toBe(false);
    expect(image.gamma).toHaveLength(256);
    expect([...image.gamma!.slice(0, 8)]).toEqual([0, 21, 28, 34, 39, 43, 46, 50]);
    expect(closed).toEqual([]);
  });

  it("g = 0.45455（sRGB 一族）不校正：没有表", async () => {
    const { sources, closed } = gammaSources(0.45455);
    await sources.prime([["ut", "g.png"]]);
    const cropped = sources.crop("ut", null)!;
    expect(cropped.image.gamma).toBeNull();
    expect(closed).toEqual([]);
  });
});

describe("UserTextureSources：探针", () => {
  it("给每个来源的值、状态、尺寸、已登记的纹理名", async () => {
    const { sources } = setup();
    await sources.prime([
      ["a", "a.png"],
      ["b", ""],
    ]);
    sources.crop("a", { width: 1, height: 1 });
    sources.crop("a", null);
    expect(sources.probe()).toEqual([
      {
        name: "a",
        value: "a.png",
        status: "ready",
        width: 300,
        height: 200,
        decodeMs: 0,
        keys: ["a.pngx10", "a.pngx0"],
      },
      { name: "b", value: "", status: "empty", keys: [] },
    ]);
  });
});
