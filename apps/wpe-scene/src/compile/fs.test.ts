/**
 * `SceneFs` 的缓存遗忘（L2）：Worker 把缓冲转移给主线程之后，`forgetBuffers` 只删字节落在这批缓冲上的已完成条目，
 * 别的条目与未完成的 Promise 不动；`cacheStats` 数已完成条目的字节。
 */
import { describe, expect, it, vi } from "vitest";
import { SceneFs, type SceneReader } from "./fs";

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
