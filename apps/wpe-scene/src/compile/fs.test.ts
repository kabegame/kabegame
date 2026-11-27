/**
 * `SceneFs` 的缓存遗忘（L2）：Worker 把缓冲转移给主线程之后，`forgetBuffers` 只删字节落在这批缓冲上的已完成条目，
 * 别的条目与未完成的 Promise 不动；`cacheStats` 数已完成条目的字节。
 */
import { describe, expect, it, vi } from "vitest";
import { SceneFs, type SceneReader } from "./fs";
import type { SceneFileList } from "./fileIndex";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** 内存读取器：记下每个路径整读 / 区间读的次数；每次返回新缓冲。 */
function memory(files: Record<string, Uint8Array>) {
  const wholeCalls = new Map<string, number>();
  const rangeCalls = new Map<string, number>();
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (!value) throw new TypeError("Failed to fetch");
    return value.slice();
  };
  const reader: SceneReader = {
    async readWhole(path) {
      path = path.replace(/\\/g, "/");
      wholeCalls.set(path, (wholeCalls.get(path) ?? 0) + 1);
      return bytes(path);
    },
    async readRange(path, start, end) {
      path = path.replace(/\\/g, "/");
      rangeCalls.set(path, (rangeCalls.get(path) ?? 0) + 1);
      return bytes(path).slice(start, end);
    },
  };
  return { reader, wholeCalls, rangeCalls };
}

const FILES = {
  "P:/p/a.bin": new Uint8Array(100).fill(1),
  "P:/p/b.bin": new Uint8Array(200).fill(2),
  "P:/p/c.bin": new Uint8Array(300).fill(3),
};

describe("SceneFs.forgetBuffers", () => {
  it("只删字节落在这批缓冲上的已完成条目，别的条目不重读", async () => {
    const { reader, wholeCalls } = memory(FILES);
    const fs = new SceneFs("P:/p", [], reader);
    const a = (await fs.read("a.bin"))!;
    await fs.read("b.bin");
    await fs.read("c.bin");
    expect([...wholeCalls.values()]).toEqual([1, 1, 1]);
    // 忘掉 a 的缓冲：a 再读要重新请求，b、c 命中缓存
    fs.forgetBuffers(new Set([a.bytes.buffer as ArrayBuffer]));
    await fs.read("b.bin");
    await fs.read("c.bin");
    expect(wholeCalls.get("P:/p/b.bin")).toBe(1);
    expect(wholeCalls.get("P:/p/c.bin")).toBe(1);
    const again = (await fs.read("a.bin"))!;
    expect(wholeCalls.get("P:/p/a.bin")).toBe(2);
    expect(again.bytes).toEqual(FILES["P:/p/a.bin"]);
    expect(again.bytes.buffer).not.toBe(a.bytes.buffer);
  });

  it("空集合什么都不删；缓冲不属于任何条目也无害", async () => {
    const { reader, wholeCalls } = memory(FILES);
    const fs = new SceneFs("P:/p", [], reader);
    await fs.read("a.bin");
    await fs.read("b.bin");
    fs.forgetBuffers(new Set());
    fs.forgetBuffers(new Set([new ArrayBuffer(8)]));
    await fs.read("a.bin");
    await fs.read("b.bin");
    expect([...wholeCalls.values()]).toEqual([1, 1]);
  });

  it("未完成的条目不动：它们的字节还没被转移", async () => {
    const gate: { release: () => void } = { release: () => undefined };
    const waiting = new Promise<void>((resolve) => (gate.release = resolve));
    const reader: SceneReader = {
      async readWhole() {
        await waiting;
        return new Uint8Array(10);
      },
      async readRange() {
        throw new TypeError("Failed to fetch");
      },
    };
    const fs = new SceneFs("P:/p", [], reader);
    const first = fs.read("a.bin");
    // 此时条目还没完成：任何缓冲都删不到它
    fs.forgetBuffers(new Set([new ArrayBuffer(10)]));
    gate.release();
    const done = (await first)!;
    const second = (await fs.read("a.bin"))!;
    expect(second.bytes).toBe(done.bytes);
  });

  it("散文件首个区间读的 head 落在这批缓冲上时，resolve 的条目被删、再 resolve 重读", async () => {
    const { reader, rangeCalls } = memory(FILES);
    const fs = new SceneFs("P:/p", [], reader);
    const file = (await fs.resolve("a.bin"))!;
    expect(file.head).toBeDefined();
    expect(rangeCalls.get("P:/p/a.bin")).toBe(1);
    await fs.resolve("a.bin");
    expect(rangeCalls.get("P:/p/a.bin")).toBe(1);
    fs.forgetBuffers(new Set([file.head!.buffer as ArrayBuffer]));
    const again = (await fs.resolve("a.bin"))!;
    expect(rangeCalls.get("P:/p/a.bin")).toBe(2);
    expect(again.head).not.toBe(file.head);
  });
});

describe("SceneFs.cacheStats", () => {
  it("已完成的整读文件与 head 的字节数、整读文件数；forgetBuffers 之后减少", async () => {
    const { reader } = memory(FILES);
    const fs = new SceneFs("P:/p", [], reader);
    expect(fs.cacheStats()).toEqual({ bytes: 0, files: 0 });
    const a = (await fs.read("a.bin"))!;
    await fs.read("b.bin");
    // 整读 a（100）+ b（200）；`read` 先解析（探 4 KiB 区间读）再整读，解析出的 head 是整个文件，也记一份
    const stats = fs.cacheStats();
    expect(stats.files).toBe(2);
    expect(stats.bytes).toBeGreaterThanOrEqual(300);
    fs.forgetBuffers(new Set([a.bytes.buffer as ArrayBuffer]));
    expect(fs.cacheStats().files).toBe(1);
    expect(fs.cacheStats().bytes).toBeLessThan(stats.bytes);
  });
});

describe("SceneFs 按场景文件表找（wpe_scene_files）", () => {
  const DISK = {
    "P:/p/project.json": new Uint8Array([1]),
    "P:/p/Models/Bar.json": new Uint8Array([2]),
    "A:/a/shaders/common.h": new Uint8Array([3]),
    "A:/a/materials/Util.tex": new Uint8Array(64).fill(4),
  };
  const list = (project: string[], assets: string[], assetsDir = "A:/a"): SceneFileList => ({
    project: { dir: "P:/p", files: project },
    pkg: [],
    assets: [{ dir: assetsDir, files: assets }],
  });
  /** 全部请求过的路径（整读与区间读都算），按出现顺序 */
  function requested(reader: ReturnType<typeof memory>): string[] {
    return [...new Set([...reader.wholeCalls.keys(), ...reader.rangeCalls.keys()])];
  }
  function total(reader: ReturnType<typeof memory>): number {
    let sum = 0;
    for (const count of reader.wholeCalls.values()) sum += count;
    for (const count of reader.rangeCalls.values()) sum += count;
    return sum;
  }

  it("表里没有的位置不探：工程目录里没有的内置着色器直接去 assets 读", async () => {
    const disk = memory(DISK);
    const fs = new SceneFs(
      "P:/p",
      ["A:/a"],
      disk.reader,
      list(["project.json", "Models/Bar.json"], ["shaders/common.h"]),
    );
    const file = (await fs.read("shaders/common.h"))!;
    expect(file.source).toBe("assets");
    expect(file.bytes).toEqual(DISK["A:/a/shaders/common.h"]);
    expect(requested(disk)).not.toContain("P:/p/shaders/common.h");
  });

  it("按表里的真实大小写读：散文件与 assets 都是（照 WPE 在 Windows 上不分 ASCII 大小写）", async () => {
    const disk = memory(DISK);
    const fs = new SceneFs("P:/p", ["A:/a"], disk.reader, list(["Models/Bar.json"], ["materials/Util.tex"]));
    const model = (await fs.read("models/bar.json"))!;
    expect(model.source).toBe("project");
    expect(model.bytes).toEqual(DISK["P:/p/Models/Bar.json"]);
    const texture = (await fs.resolve("MATERIALS/util.tex"))!;
    expect(texture.source).toBe("assets");
    expect(texture.location.path.replace(/\\/g, "/")).toBe("A:/a/materials/Util.tex");
    expect(texture.head).toEqual(DISK["A:/a/materials/Util.tex"]);
    expect(requested(disk)).not.toContain("P:/p/models/bar.json");
  });

  it("表过时：三处表里都没有时按原写法补探，运行中新加的散文件照样读得到", async () => {
    const disk = memory({ ...DISK, "P:/p/fresh.json": new Uint8Array([9]) });
    const fs = new SceneFs("P:/p", ["A:/a"], disk.reader, list(["project.json"], []));
    const file = (await fs.read("fresh.json"))!;
    expect(file.source).toBe("project");
    expect(file.bytes).toEqual(new Uint8Array([9]));
  });

  it("表里有但读不到（文件删了）：接着找下一处", async () => {
    const disk = memory(DISK);
    const fs = new SceneFs("P:/p", ["A:/a"], disk.reader, list(["shaders/common.h"], ["shaders/common.h"]));
    const file = (await fs.read("shaders/common.h"))!;
    expect(file.source).toBe("assets");
  });

  it("三处都没有的路径整个会话只探一次：clearCaches 之后再问也不发请求", async () => {
    const disk = memory(DISK);
    const fs = new SceneFs("P:/p", ["A:/a"], disk.reader, list(["project.json"], ["shaders/common.h"]));
    expect(await fs.read("missing.json")).toBeNull();
    const before = total(disk);
    fs.clearCaches();
    expect(await fs.read("missing.json")).toBeNull();
    expect(await fs.resolve("missing.json")).toBeNull();
    expect(total(disk)).toBe(before);
  });

  it("没有表时三处都没有的路径同样只探一次", async () => {
    const disk = memory(DISK);
    const fs = new SceneFs("P:/p", ["A:/a"], disk.reader);
    expect(await fs.read("missing.json")).toBeNull();
    const before = total(disk);
    fs.clearCaches();
    expect(await fs.read("missing.json")).toBeNull();
    expect(total(disk)).toBe(before);
  });

  it("目录写法对不上的根当没有表：照旧按原写法探", async () => {
    const disk = memory(DISK);
    const fs = new SceneFs("P:/p", ["A:/a"], disk.reader, list(["project.json"], [], "X:/other"));
    const file = (await fs.read("shaders/common.h"))!;
    expect(file.source).toBe("assets");
  });

  it("有表时工程散文件仍然优先于 assets", async () => {
    const disk = memory({ ...DISK, "P:/p/shaders/common.h": new Uint8Array([7]) });
    const fs = new SceneFs("P:/p", ["A:/a"], disk.reader, list(["shaders/common.h"], ["shaders/common.h"]));
    const file = (await fs.read("shaders/common.h"))!;
    expect(file.source).toBe("project");
    expect(file.bytes).toEqual(new Uint8Array([7]));
  });
});
