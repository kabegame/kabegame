import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, shaderUniforms } from "./bundle";
import { checkSceneFeatures } from "./features";
import { FetchSceneReader, SceneFs, normalizeScenePath, type SceneReader } from "./fs";
import { currentProperties, numbers, resolveValue } from "./model";
import { decodeFileError, encodeFileError } from "./protocol";
import { decodeLz4Block, parseTex } from "./tex";
import { Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

interface FetchTally {
  calls: number;
  misses: number;
  bytes: number;
  singleByteRanges: number;
}
function nodeFetch(tally: FetchTally): typeof fetch {
  return async (input, init) => {
    tally.calls++;
    const path = String(input);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      tally.misses++;
      throw new TypeError("Failed to fetch");
    }
    const range = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range ? Number(range[2]) + 1 : size;
    if (range && end - start === 1) tally.singleByteRanges++;
    if (start >= size && range) {
      tally.misses++;
      throw new TypeError("Failed to fetch");
    }
    const fd = openSync(path, "r");
    try {
      const bytes = new Uint8Array(Math.max(0, Math.min(end, size) - start));
      readSync(fd, bytes, 0, bytes.length, start);
      tally.bytes += bytes.length;
      return new Response(bytes.buffer, { status: 200 });
    } finally {
      closeSync(fd);
    }
  };
}
function parts(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}
function magic(text: string): Uint8Array {
  return parts(new TextEncoder().encode(text), new Uint8Array([0]));
}
function tex(version: number, format = 0, flags = 0, compression = 0, data = new Uint8Array([1, 2, 3, 4])): Uint8Array {
  const rawSize = compression ? 4 : data.length;
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(format),
    u32(flags),
    u32(1),
    u32(1),
    u32(1),
    u32(1),
    u32(0),
    magic(`TEXB000${version}`),
    u32(1),
    ...(version >= 3 ? [u32(0xffffffff)] : []),
    ...(version === 4 ? [u32(0)] : []),
    u32(1),
    u32(1),
    u32(1),
    ...(version >= 2 ? [u32(compression), u32(rawSize)] : []),
    u32(data.length),
    data,
  );
}
function memoryFile(bytes: Uint8Array) {
  return {
    source: "project" as const,
    path: "x.tex",
    size: bytes.length,
    location: { path: "x.tex", offset: 0 },
    async readRange(start: number, end: number) {
      return bytes.slice(start, end);
    },
  };
}

describe("场景编译基础", () => {
  it("路径规范化与越界拒绝", () => {
    expect(normalizeScenePath("./materials\\a.tex")).toBe("materials/a.tex");
    for (const path of ["../x", "a/../x", "C:\\x", "\\\\server\\share\\x", "//server/x"])
      expect(() => normalizeScenePath(path)).toThrow();
  });
  it("用户覆盖、条件和脚本默认值", () => {
    const props = currentProperties(
      { file: "scene.json", general: { properties: { color: { value: "1 0 0" } } } },
      { color: "0 1 0" },
    );
    expect(numbers(resolveValue({ user: "color", value: "1 0 0" }, props))).toEqual([0, 1, 0]);
    expect(resolveValue({ user: { name: "color", condition: "0 1 0" }, value: false }, props)).toBe(true);
    expect(resolveValue({ script: "export function update() {}", value: 7 }, props)).toBe(7);
  });
  it("用户 shader 属性缺失时回退材质常量和注释默认值", () => {
    const result = {
      ok: true,
      uniforms: [
        { name: "g_Color1", type: "vec3<f32>", offset: 0, size: 16, meta: { material: "color1", default: "0 0 0" } },
        { name: "g_Color2", type: "vec3<f32>", offset: 16, size: 16, meta: { material: "color2", default: "0 1 0" } },
      ],
    };
    expect(
      shaderUniforms(
        result,
        {
          usershadervalues: { missing1: "color1", missing2: "color2" },
          constantshadervalues: { color1: "1 0 0" },
        },
        {},
      ),
    ).toEqual({ g_Color1: [1, 0, 0], g_Color2: [0, 1, 0] });
  });
  it("能力表忽略中性字段并报告画面差异", () => {
    const plain = {
      general: { orthogonalprojection: { width: 1920, height: 1080 }, bloom: false },
      objects: [{ id: 1, name: "x", image: "models/x.json" }],
    };
    const keys = new Set<string>();
    checkSceneFeatures(plain, keys);
    expect([...keys]).toEqual([]);
    checkSceneFeatures(
      { general: { bloom: true }, objects: [{ id: 2, particle: "particles/a.json", parent: 1 }] },
      keys,
    );
    // general.bloom 交给后处理档位裁决（postprocess:*），不再按键报
    expect(keys).toEqual(new Set(["camera:perspective", "object:particle", "object:parent"]));
  });
  it("LZ4 已知向量及损坏输入", () => {
    expect(decodeLz4Block(new Uint8Array([0x40, 65, 66, 67, 68]), 4)).toEqual(new Uint8Array([65, 66, 67, 68]));
    expect(decodeLz4Block(new Uint8Array([0x10, 65, 1, 0]), 5)).toEqual(new Uint8Array([65, 65, 65, 65, 65]));
    expect(() => decodeLz4Block(new Uint8Array([0x10, 65, 0, 0]), 5)).toThrow();
  });
  it.each([1, 2, 3, 4])("TEXB000%s 原始 RGBA", async (version) => {
    const result = await parseTex(memoryFile(tex(version)));
    expect(result.containerVersion).toBe(version);
    expect(result.images[0].mips[0].bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  it("压缩 RGBA、DXT5、视频区间与动画标记", async () => {
    expect(
      (await parseTex(memoryFile(tex(3, 0, 0, 1, new Uint8Array([0x40, 1, 2, 3, 4]))))).images[0].mips[0].bytes,
    ).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await parseTex(memoryFile(tex(2, 4)))).format).toBe(4);
    const video = await parseTex(memoryFile(tex(4, 0, 32, 0, new Uint8Array([0, 0, 0, 0, 102, 116, 121, 112]))));
    expect(video.unsupported).toContain("tex:video");
    expect(video.videoRange?.end).toBe(video.videoRange!.start + 8);
    expect(video.images[0].mips[0].bytes).toBeUndefined();
    const extended = parts(
      magic("TEXV0005"),
      magic("TEXI0001"),
      u32(0),
      u32(32),
      u32(1),
      u32(1),
      u32(1),
      u32(1),
      u32(0),
      magic("TEXB0004"),
      u32(1),
      u32(0xffffffff),
      u32(1),
      u32(1),
      u32(0),
      u32(0),
      new Uint8Array([0]),
      u32(0),
      u32(1),
      u32(1),
      u32(0),
      u32(4),
      u32(4),
      new Uint8Array([1, 2, 3, 4]),
    );
    expect((await parseTex(memoryFile(extended))).videoRange?.end).toBe(extended.length);
    const animated = await parseTex(memoryFile(parts(tex(3, 0, 4), magic("TEXS0003"), u32(0), u32(1), u32(1))));
    expect(animated.animatedVersion).toBe(3);
    expect(animated.frameCount).toBe(0);
  });
  it(".tex 复用首次区间读取的头部窗口", async () => {
    const bytes = tex(3);
    let extraReads = 0;
    const file = {
      ...memoryFile(bytes),
      size: null,
      head: bytes,
      async readRange(start: number, end: number) {
        extraReads++;
        return bytes.slice(start, end);
      },
    };
    expect((await parseTex(file)).images[0].mips[0].bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(extraReads).toBe(0);
  });
  it("散文件优先于 pkg，pkg 优先于 assets", async () => {
    const files = new Map<string, Uint8Array>();
    const enc = new TextEncoder();
    const pkg = parts(
      u32(8),
      enc.encode("PKGV0024"),
      u32(1),
      u32(5),
      enc.encode("a.txt"),
      u32(0),
      u32(3),
      enc.encode("pkg"),
    );
    files.set("P:\\scene.pkg", pkg);
    files.set("A:\\a.txt", enc.encode("asset"));
    files.set("P:\\a.txt", enc.encode("project"));
    const reader: SceneReader = {
      async readWhole(path) {
        const bytes = files.get(path);
        if (!bytes) throw new TypeError("Failed to fetch");
        return bytes;
      },
      async readRange(path, start, end) {
        const bytes = files.get(path);
        if (!bytes || start >= bytes.length) throw new TypeError("Failed to fetch");
        return bytes.slice(start, end);
      },
    };
    const fs = new SceneFs("P:", ["A:"], reader);
    expect(await fs.text("a.txt")).toBe("project");
    expect((await fs.readRange("a.txt", 1, 3))?.bytes).toEqual(enc.encode("ro"));
    await expect(fs.readRange("a.txt", 7, 8)).rejects.toThrow("Failed to fetch");
    files.delete("P:\\a.txt");
    expect(await fs.text("a.txt")).toBe("project"); // 已读内容缓存
    expect(await new SceneFs("P:", ["A:"], reader).text("a.txt")).toBe("pkg");
    files.delete("P:\\scene.pkg");
    expect(await new SceneFs("P:", ["A:"], reader).text("a.txt")).toBe("asset");
  });
  it("查找结果、未命中与整文件内容只读取一次", async () => {
    const bytes = new TextEncoder().encode("TEXV0005");
    const calls: string[] = [];
    const reader: SceneReader = {
      async readWhole(path) {
        calls.push(`whole:${path}`);
        if (path.endsWith("a.txt")) return bytes;
        throw new TypeError("Failed to fetch");
      },
      async readRange(path, start) {
        calls.push(`range:${path}:${start}`);
        if (path.endsWith("a.tex")) return bytes;
        throw new TypeError("Failed to fetch");
      },
    };
    const fs = new SceneFs("P:", [], reader);
    expect(await fs.text("a.txt")).toBe("TEXV0005");
    const before = calls.length;
    expect(await fs.text("a.txt")).toBe("TEXV0005");
    expect(calls.length).toBe(before);
    expect((await fs.resolve("a.tex"))?.head).toEqual(bytes);
    const afterResolve = calls.length;
    expect((await fs.resolve("a.tex"))?.head).toEqual(bytes);
    expect(calls.length).toBe(afterResolve);
    expect(await fs.text("missing.txt")).toBeNull();
    const afterMiss = calls.length;
    expect(await fs.text("missing.txt")).toBeNull();
    expect(calls.length).toBe(afterMiss);
    expect(await fs.resolve("missing.tex")).toBeNull();
    const afterResolveMiss = calls.length;
    expect(await fs.resolve("missing.tex")).toBeNull();
    expect(calls.length).toBe(afterResolveMiss);
  });
  it("经 Worker 消息往返的读取错误仍按不存在处理", async () => {
    // 模拟 client → Worker：主线程的错误编码后经结构化克隆送达，Worker 端还原
    const relay = async <T>(read: () => Promise<T>): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        throw decodeFileError(structuredClone(encodeFileError(error)));
      }
    };
    const files = new Map([["A:\\a.txt", new TextEncoder().encode("asset")]]);
    const inner: SceneReader = {
      async readWhole(path) {
        const bytes = files.get(path);
        if (!bytes) throw new TypeError("Failed to fetch");
        return bytes;
      },
      async readRange(path, start, end) {
        const bytes = files.get(path);
        if (!bytes) throw new TypeError("Failed to fetch");
        return bytes.slice(start, end);
      },
    };
    const reader: SceneReader = {
      readWhole: (path) => relay(() => inner.readWhole(path)),
      readRange: (path, start, end) => relay(() => inner.readRange(path, start, end)),
    };
    const fs = new SceneFs("P:", ["A:"], reader);
    expect(await fs.text("a.txt")).toBe("asset");
    expect((await fs.resolve("a.txt"))?.source).toBe("assets");
    expect(await fs.text("missing.txt")).toBeNull();
    expect(decodeFileError(encodeFileError(new Error("x")))).not.toBeInstanceOf(TypeError);
  });
  it("Range 被忽略时及时取消流", async () => {
    const oldFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(100));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    try {
      await expect(new FetchSceneReader().readRange("C:\\x", 0, 4)).rejects.toThrow("Range 被忽略");
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const defaults = root ? join(root, "projects", "defaultprojects") : "";
const workshop = root ? join(root, "..", "..", "workshop", "content", "431960") : "";
const projects =
  root && existsSync(defaults)
    ? readdirSync(defaults)
        .map((name) => join(defaults, name))
        .filter(
          (dir) =>
            (existsSync(join(dir, "project.json")) && existsSync(join(dir, "scene.pkg"))) ||
            existsSync(join(dir, "scene.json")) ||
            (() => {
              try {
                const p = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
                return typeof p.file === "string" && p.file.endsWith(".json") && existsSync(join(dir, p.file));
              } catch {
                return false;
              }
            })(),
        )
    : [];
if (root && existsSync(workshop))
  projects.push(
    ...readdirSync(workshop)
      .map((id) => join(workshop, id))
      .filter((dir) => existsSync(join(dir, "scene.pkg"))),
  );
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");

describe.skipIf(!root || !existsSync(wasm))("本机 WPE 场景语料", () => {
  it("全部场景编译、P1 / P2a 解锁、读取及请求次数有界", async () => {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const rows: { sample: string; unsupported: string; calls: number; misses: number; bytes: number }[] = [];
    const unlocked = ["eagleflag", "deep_space", "beach", "razer_vortex", "razer_bedroom"];
    // 工坊样本：用户真机确认过（2026-11-07）。不是每台机器都订阅，所以不要求存在
    const workshopUnlocked = ["2077883354", "2077888249", "2418800402", "2833452727", "2961807954"];
    for (const name of [...unlocked, "razer_bedroom"])
      expect(
        projects.some((dir) => dir.split(/[\\/]/).at(-1) === name),
        name,
      ).toBe(true);
    const failures: string[] = [];
    const check = (ok: boolean, message: string) => {
      if (!ok) failures.push(message);
    };
    try {
      for (const dir of projects) {
        // 运行时的形态：确定退回就停（统计请求与读取量）
        const tally: FetchTally = { calls: 0, misses: 0, bytes: 0, singleByteRanges: 0 };
        vi.stubGlobal("fetch", nodeFetch(tally));
        // 后处理固定为关闭，结果不随本机 WPE 设置变化（档位裁决另有单测）
        const fast = await compileScene({
          projectDir: dir,
          sceneAssets: [join(root!, "assets")],
          reader: new FetchSceneReader(),
          translator,
          postprocess: "disabled",
        });
        // 列全不支持项（能力表统计）
        vi.stubGlobal("fetch", nodeFetch({ calls: 0, misses: 0, bytes: 0, singleByteRanges: 0 }));
        const bundle = await compileScene({
          projectDir: dir,
          sceneAssets: [join(root!, "assets")],
          reader: new FetchSceneReader(),
          translator,
          postprocess: "disabled",
          exhaustive: true,
        });
        check(fast.unsupported.length > 0 === bundle.unsupported.length > 0, `${dir}: 快速路径与完整编译的结论不同`);
        const sample = dir.split(/[\\/]/).at(-1)!;
        rows.push({
          sample,
          unsupported: bundle.unsupported.join(", "),
          calls: tally.calls,
          misses: tally.misses,
          bytes: tally.bytes,
        });
        if (unlocked.includes(sample) || workshopUnlocked.includes(sample)) {
          check(bundle.unsupported.length === 0, `${sample}: ${bundle.unsupported.join(", ")}`);
          check(bundle.programs.length > 0, `${sample}: 没有程序`);
          // FreeImage 形态的 mip 由主线程解码，这里只有区间
          check(
            bundle.textures.every(
              (texture) => texture.width > 0 && texture.height > 0 && (texture.mips.length > 0 || !!texture.encoded),
            ),
            `${sample}: 纹理缺 mip`,
          );
          // 工坊内容因机器而异，新下载的场景本来就可能直接能渲染，只约束默认工程
        } else if (!dir.startsWith(workshop)) check(bundle.unsupported.length > 0, `${sample}: 意外解锁`);
        const expected: Record<string, [string, number, number, number]> = {
          eagleflag: ["materials/eagle.tex", 2048, 1024, 10],
          deep_space: ["materials/galaxy_2_base.tex", 1920, 1080, 11],
          beach: ["materials/beach.tex", 1536, 1024, 1],
        };
        if (expected[sample]) {
          const [path, width, height, mipCount] = expected[sample];
          const texture = bundle.textures.find((item) => item.path === path);
          check(texture?.width === width && texture.height === height, `${sample}: ${path} 尺寸`);
          check(texture?.mips.length === mipCount, `${sample}: ${path} mip 数`);
        }
        check(tally.bytes < 64 * 1024 * 1024, `${sample}: 读取 ${tally.bytes} 字节`);
        check(tally.singleByteRanges === 0, `${sample}: 单字节探测`);
        check(tally.calls <= 150, `${sample}: ${tally.calls} 次请求`);
      }
    } finally {
      vi.unstubAllGlobals();
    }
    console.table(rows);
    expect(failures).toEqual([]);
  }, 120000);
});
