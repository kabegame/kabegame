/**
 * `.tex` 的格式支持范围（P4b 步骤 1）：格式表是编译期与渲染器共用的唯一来源，`parseTex` 只对表外格式报 `tex:format:<n>`，
 * alpha-priority 不再报。真实样本只复刻头部与 mip 表（尺寸、标志、容器版本、哪几级 LZ4 压缩），数据用确定的花样填，
 * 不依赖 `ignore/` 与本机 WPE。
 */
import { describe, expect, it } from "vitest";
import { compileScene, type SceneTexture } from "./bundle";
import { SUPPORTED } from "./features";
import type { SceneFile } from "./fs";
import { parseTex, TEX_FLAGS, TEXTURE_FORMATS, textureFormat } from "./tex";
import { mipCopyLayout, planTextureUpload, requiredFeatures } from "../render/textures";
import type { Wpesl2wgsl } from "../wpesl2wgsl";

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
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}
function magic(text: string): Uint8Array {
  return parts(new TextEncoder().encode(text), new Uint8Array([0]));
}
/** 只有字面量的 LZ4 block：一个序列，token 高 4 位 15 加长度扩展字节（块的最后一个序列可以没有匹配）。 */
function lz4Literals(data: Uint8Array): Uint8Array {
  const head: number[] = [];
  if (data.length < 15) head.push(data.length << 4);
  else {
    head.push(0xf0);
    let rest = data.length - 15;
    for (; rest >= 255; rest -= 255) head.push(255);
    head.push(rest);
  }
  return parts(new Uint8Array(head), data);
}
/** 确定的花样，保证 LZ4 解出来能逐字节比对。 */
function pattern(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 17 + (i >> 7)) & 255;
  return out;
}

interface MipSpec {
  width: number;
  height: number;
  lz4?: boolean;
}
interface TexSpec {
  format: number;
  flags: number;
  textureWidth: number;
  textureHeight: number;
  width: number;
  height: number;
  container: 1 | 2 | 3 | 4;
  /** FreeImage 格式（TEXB0003 起），缺省 -1。 */
  freeImage?: number;
  mips: MipSpec[];
  /** 每级 mip 的原始数据；缺省按格式表的紧排长度填花样。 */
  data?: (mip: MipSpec, level: number) => Uint8Array;
}
/** 按 TextureParser 的布局拼一个单图像 `.tex`；同时返回每级 mip 的原始数据。 */
function buildTex(spec: TexSpec): { bytes: Uint8Array; raw: Uint8Array[] } {
  const raw = spec.mips.map(
    (mip, level) =>
      spec.data?.(mip, level) ?? pattern(mipCopyLayout(spec.format, mip.width, mip.height).byteLength, level),
  );
  const mipBytes = spec.mips.map((mip, level) => {
    const stored = mip.lz4 ? lz4Literals(raw[level]) : raw[level];
    return parts(
      u32(mip.width),
      u32(mip.height),
      ...(spec.container >= 2 ? [u32(mip.lz4 ? 1 : 0), u32(raw[level].length)] : []),
      u32(stored.length),
      stored,
    );
  });
  const bytes = parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(spec.format),
    u32(spec.flags),
    u32(spec.textureWidth),
    u32(spec.textureHeight),
    u32(spec.width),
    u32(spec.height),
    u32(0),
    magic(`TEXB000${spec.container}`),
    u32(1),
    ...(spec.container >= 3 ? [u32(spec.freeImage ?? -1)] : []),
    ...(spec.container === 4 ? [u32(0)] : []),
    u32(spec.mips.length),
    ...mipBytes,
  );
  return { bytes, raw };
}
function memoryFile(bytes: Uint8Array): SceneFile {
  return {
    source: "project",
    path: "materials/x.tex",
    size: bytes.length,
    location: { path: "materials/x.tex", offset: 0 },
    async readRange(start: number, end: number) {
      return bytes.slice(start, end);
    },
  };
}
/** 一个 4×4、一级 mip 的原始 `.tex`。 */
function small(format: number, flags: number = TEX_FLAGS.clampUVs): Uint8Array {
  const data = () => pattern(textureFormat(format) ? mipCopyLayout(format, 4, 4).byteLength : 64, 1);
  return buildTex({
    format,
    flags,
    textureWidth: 4,
    textureHeight: 4,
    width: 4,
    height: 4,
    container: 3,
    mips: [{ width: 4, height: 4 }],
    data,
  }).bytes;
}

describe("格式表是唯一来源", () => {
  it("0、4、6–9 在表里；DXGI 对应照 WPE（都不是 sRGB），BC 三项要 BC 特性", () => {
    expect(Object.keys(TEXTURE_FORMATS).map(Number)).toEqual([0, 4, 6, 7, 8, 9]);
    expect(
      Object.entries(TEXTURE_FORMATS).map(([format, info]) => [Number(format), info.gpu, info.feature ?? null]),
    ).toEqual([
      [0, "rgba8unorm", null],
      [4, "bc3-rgba-unorm", "texture-compression-bc"],
      [6, "bc2-rgba-unorm", "texture-compression-bc"],
      [7, "bc1-rgba-unorm", "texture-compression-bc"],
      [8, "rg8unorm", null],
      [9, "r8unorm", null],
    ]);
    // 能力表的格式列表从表里取，不另写一份
    expect(SUPPORTED.textureFormats).toEqual([0, 4, 6, 7, 8, 9]);
    expect(textureFormat(9)?.bytesPerBlock).toBe(1);
    expect(textureFormat(10)).toBeUndefined();
  });
});

describe("parseTex：格式支持范围（P4b 步骤 1）", () => {
  it.each([0, 4, 6, 7, 8, 9])("格式 %i 在表里：不报 tex:format，mip 照常解码", async (format) => {
    const result = await parseTex(memoryFile(small(format)));
    expect(result.format).toBe(format);
    expect(result.unsupported).toEqual([]);
    expect(result.images[0].mips[0].bytes?.length).toBe(mipCopyLayout(format, 4, 4).byteLength);
  });

  it.each([1, 2, 3, 5, 10, 11, 12, 13, 14, 15])(
    "格式 %i 不在表里：照报 tex:format:<n>，不读 mip 字节",
    async (format) => {
      const result = await parseTex(memoryFile(small(format)));
      expect(result.unsupported).toEqual([`tex:format:${format}`]);
      expect(result.images[0].mips[0].bytes).toBeUndefined();
    },
  );

  it.each([8, 9])("格式 %i 带 alpha-priority（0x80000）不报：WPE 运行时不读这一位", async (format) => {
    const result = await parseTex(memoryFile(small(format, TEX_FLAGS.alphaPriority | TEX_FLAGS.clampUVs)));
    expect(result.flags).toBe(0x80002);
    expect(result.unsupported).toEqual([]);
    expect(result.images[0].mips[0].bytes).toBeDefined();
  });

  it("FreeImage 形态只收格式 0（主线程解成 RGBA 位图）", async () => {
    const png = (format: number) =>
      buildTex({
        format,
        flags: 0,
        textureWidth: 4,
        textureHeight: 4,
        width: 4,
        height: 4,
        container: 3,
        freeImage: 13,
        mips: [{ width: 4, height: 4 }],
        data: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }).bytes;
    const ok = await parseTex(memoryFile(png(0)));
    expect(ok.unsupported).toEqual([]);
    expect(ok.encoded?.mime).toBe("image/png");
    expect((await parseTex(memoryFile(png(9)))).unsupported).toEqual(["tex:format:9"]);
  });
});

/** 解析出的第 0 张图像按 bundle 的方式转成 `SceneTexture`（mip 只留有字节的）。 */
function sceneTexture(result: Awaited<ReturnType<typeof parseTex>>): SceneTexture {
  return {
    path: "materials/x.tex",
    source: "project",
    format: result.format,
    width: result.width,
    height: result.height,
    textureWidth: result.textureWidth,
    textureHeight: result.textureHeight,
    flags: result.flags,
    clampUVs: !!(result.flags & TEX_FLAGS.clampUVs),
    noInterpolation: !!(result.flags & TEX_FLAGS.noInterpolation),
    mips: result.images[0].mips.flatMap((mip) =>
      mip.bytes ? [{ width: mip.width, height: mip.height, bytes: mip.bytes }] : [],
    ),
  };
}

/** 从 `size` 起逐级减半到 `last` 的 mip 表，前 `compressed` 级 LZ4。 */
function chain(width: number, height: number, last: number, compressed: number): MipSpec[] {
  const mips: MipSpec[] = [];
  for (let w = width, h = height, level = 0; w >= last && h >= last; w >>= 1, h >>= 1, level++)
    mips.push({ width: w, height: h, lz4: level < compressed });
  return mips;
}

/** 每级 mip 的原始长度写死成真实文件头里的值（LZ4 的 `uncompressedSize` / 未压缩的存储长度），不从格式表算。 */
const realLengths =
  (...lengths: number[]) =>
  (_: MipSpec, level: number) =>
    pattern(lengths[level], level);

describe("真实样本的头部形态：解析、解码与上传计划一致", () => {
  // 头部与 mip 表照 ignore/p4/proj/p4b-tex/materials/kbt/*.tex 与 assets 的 lambda.tex（2026-11-08 读头核对）。
  // mip 长度用文件里的真实值，所以上传计划同时核对了格式表的块字节数
  const samples: [string, TexSpec][] = [
    [
      "dxt1.tex：DXT1 620×220，TEXB0003，一级 LZ4",
      {
        format: 7,
        flags: TEX_FLAGS.clampUVs,
        textureWidth: 620,
        textureHeight: 220,
        width: 620,
        height: 220,
        container: 3,
        mips: [{ width: 620, height: 220, lz4: true }],
        data: realLengths(68200),
      },
    ],
    [
      "dxt3.tex：DXT3 纹理 1024²、图像 902×736，TEXB0004，8 级到 8×8，前 4 级 LZ4",
      {
        format: 6,
        flags: TEX_FLAGS.clampUVs,
        textureWidth: 1024,
        textureHeight: 1024,
        width: 902,
        height: 736,
        container: 4,
        mips: chain(1024, 1024, 8, 4),
        data: realLengths(1048576, 262144, 65536, 16384, 4096, 1024, 256, 64),
      },
    ],
    [
      "swirl_ap.tex：RG88 256²，带 alpha-priority，TEXB0003，8 级到 2×2，前 2 级 LZ4",
      {
        format: 8,
        flags: TEX_FLAGS.alphaPriority | TEX_FLAGS.clampUVs,
        textureWidth: 256,
        textureHeight: 256,
        width: 256,
        height: 256,
        container: 3,
        mips: chain(256, 256, 2, 2),
        data: realLengths(131072, 32768, 8192, 2048, 512, 128, 32, 8),
      },
    ],
    [
      "lambda.tex：R8 256²，TEXB0002，一级 LZ4",
      {
        format: 9,
        flags: TEX_FLAGS.clampUVs,
        textureWidth: 256,
        textureHeight: 256,
        width: 256,
        height: 256,
        container: 2,
        mips: [{ width: 256, height: 256, lz4: true }],
        data: realLengths(65536),
      },
    ],
  ];

  it.each(samples)("%s", async (_, spec) => {
    const { bytes, raw } = buildTex(spec);
    const result = await parseTex(memoryFile(bytes));
    expect(result.unsupported).toEqual([]);
    expect([
      result.format,
      result.flags,
      result.textureWidth,
      result.textureHeight,
      result.width,
      result.height,
    ]).toEqual([spec.format, spec.flags, spec.textureWidth, spec.textureHeight, spec.width, spec.height]);
    const mips = result.images[0].mips;
    expect(mips.map((mip) => [mip.width, mip.height, mip.compression])).toEqual(
      spec.mips.map((mip) => [mip.width, mip.height, mip.lz4 ? 1 : 0]),
    );
    // LZ4 解出来与原始数据逐字节相同。不用 toEqual：1 MB 的 mip 走深比较要 5 秒以上，会碰到用例超时
    const same = (a: Uint8Array | undefined, b: Uint8Array) =>
      !!a && a.length === b.length && a.every((value, i) => value === b[i]);
    mips.forEach((mip, level) => expect(same(mip.bytes, raw[level]), `第 ${level} 级 mip`).toBe(true));
    // 渲染器的上传计划认得这张纹理：真实文件的每级字节数与格式表算出的紧排长度一致
    const texture = sceneTexture(result);
    const plan = planTextureUpload(texture);
    expect(plan.map((layout) => layout.byteLength)).toEqual(mips.map((mip) => mip.bytes!.length));
    expect(requiredFeatures([texture])).toEqual(
      spec.format === 6 || spec.format === 7 ? ["texture-compression-bc"] : [],
    );
  });
});

// ———— 视频纹理（P9a 步骤 2）：Worker 一个字节都不读，只给出视频在磁盘上的绝对区间 ————

/** 视频长度：远大于解析头部的 4 KiB 窗口，读了就看得出来（语料最大 674 MiB，经主线程代读不可接受）。 */
const VIDEO_LENGTH = 256 * 1024;

/**
 * 照 `ignore/p9/gen_v.py` 的 `make_tex`（头照语料 3828359750）：格式 0、标志 34（Video + ClampUVs）、纹理与图像都是 1280×720、
 * 一张图、一个 mip、uncompressedSize 0。`TEXB0004` 多一个 isVideoMp4（0），头共 91 字节；`TEXB0003` 87 字节。
 */
function videoTex(container: 3 | 4, video: Uint8Array): Uint8Array {
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(TEX_FLAGS.video | TEX_FLAGS.clampUVs),
    u32(1280),
    u32(720),
    u32(1280),
    u32(720),
    u32(0),
    magic(`TEXB000${container}`),
    u32(1),
    u32(-1),
    ...(container === 4 ? [u32(0)] : []),
    u32(1),
    u32(1280),
    u32(720),
    u32(0),
    u32(0),
    u32(video.length),
    video,
  );
}

/** 记下每次区间读（相对文件开头）的替身文件。 */
function recordingFile(
  bytes: Uint8Array,
  file: Omit<SceneFile, "readRange" | "source" | "path">,
  reads: [number, number][],
): SceneFile {
  return {
    source: "project",
    path: "materials/v.tex",
    ...file,
    async readRange(start: number, end: number) {
      reads.push([start, end]);
      return bytes.slice(start, end);
    },
  };
}

describe("parseTex：视频纹理不读 mip，只给磁盘上的绝对区间（P9a 步骤 2）", () => {
  const containers = [
    [4, 91],
    [3, 87],
  ] as const;

  it.each(containers)(
    "TEXB000%i（头 %i 字节）散文件：区间从文件开头算，头在首个 4 KiB 里、不再读任何东西",
    async (container, header) => {
      const bytes = videoTex(container, pattern(VIDEO_LENGTH, 7));
      expect(bytes.length).toBe(header + VIDEO_LENGTH);
      for (const decode of [true, false]) {
        const reads: [number, number][] = [];
        // 散文件同 `SceneFs.loose`：大小未知，head 是存在性探测那次 4 KiB 读的结果
        const file = recordingFile(
          bytes,
          { size: null, head: bytes.slice(0, 4096), location: { path: "P:/p/materials/v.tex", offset: 0 } },
          reads,
        );
        const result = await parseTex(file, decode);
        // 这一步照报（步骤 3 才删键）
        expect(result.unsupported).toEqual(["tex:video"]);
        const mip = result.images[0].mips[0];
        expect([mip.offset, mip.length, mip.bytes]).toEqual([header, VIDEO_LENGTH, undefined]);
        expect(result.video).toEqual({ path: "P:/p/materials/v.tex", start: header, end: header + VIDEO_LENGTH });
        expect(reads).toEqual([]);
      }
    },
  );

  it.each(containers)(
    "TEXB000%i（头 %i 字节）scene.pkg 条目：区间带条目偏移；只读头所在的 4 KiB 窗口一次",
    async (container, header) => {
      const bytes = videoTex(container, pattern(VIDEO_LENGTH, 9));
      const offset = 123_457;
      const reads: [number, number][] = [];
      const file = recordingFile(bytes, { size: bytes.length, location: { path: "P:/p/scene.pkg", offset } }, reads);
      const result = await parseTex(file);
      expect(result.images[0].mips[0].bytes).toBeUndefined();
      expect(result.video).toEqual({
        path: "P:/p/scene.pkg",
        start: offset + header,
        end: offset + header + VIDEO_LENGTH,
      });
      // 读头的窗口会顺带盖住视频开头不到 4 KiB（同散文件的 head）；没有从视频区间开始的读，也没有整段读
      expect(reads).toEqual([[0, 4096]]);
    },
  );

  it("编译：bundle 的纹理带绝对区间、没有 mip；经 SceneFs 读到的只有存在性探测那 4 KiB", async () => {
    const bytes = videoTex(4, pattern(VIDEO_LENGTH, 3));
    const reads: [string, number, number][] = [];
    const files: Record<string, Uint8Array | string> = {
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({
        general: { orthogonalprojection: { width: 1280, height: 720 } },
        objects: [{ id: 1, name: "v", image: "models/v.json", origin: "640 360 0" }],
      }),
      "P:/p/models/v.json": JSON.stringify({ material: "materials/v.json" }),
      "P:/p/materials/v.json": JSON.stringify({ passes: [{ shader: "s", textures: ["v"] }] }),
      "P:/p/materials/v.tex": bytes,
      "P:/p/shaders/s.vert": "void main() {}",
      "P:/p/shaders/s.frag": "void main() {}",
    };
    const content = (path: string) => {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      return typeof value === "string" ? new TextEncoder().encode(value) : value;
    };
    const bundle = await compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader: {
        readWhole: async (path) => content(path),
        readRange: async (path, start, end) => {
          reads.push([path.replace(/\\/g, "/"), start, end]);
          return content(path).slice(start, end);
        },
      },
      // 假翻译器：一律成功、没有接口，不依赖 wasm
      translator: {
        translate: async () => ({ ok: true, uniforms: [], textures: [], combos: [] }),
      } as unknown as Wpesl2wgsl,
      postprocess: "disabled",
      exhaustive: true,
    });
    expect(bundle.unsupported).toContain("tex:video");
    expect(bundle.textures).toHaveLength(1);
    const [texture] = bundle.textures;
    expect(texture.mips).toEqual([]);
    expect({ ...texture.video, path: texture.video?.path.replace(/\\/g, "/") }).toEqual({
      path: "P:/p/materials/v.tex",
      start: 91,
      end: 91 + VIDEO_LENGTH,
    });
    const videoReads = reads.filter(([path]) => path === "P:/p/materials/v.tex");
    expect(videoReads).toEqual([["P:/p/materials/v.tex", 0, 4096]]);
  });
});
