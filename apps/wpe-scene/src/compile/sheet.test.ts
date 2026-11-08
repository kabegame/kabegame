/**
 * P4b 步骤 2（粒子帧表）的编译期：TEXS 解析与归一化、`SceneSpriteSheet`（`g_RenderVar1`、NPOT）、帧表宏、`tex:animation`
 * 按用途过滤、帧表纹理解码 mip。纹理头照 assets 里真实帧表纹理的头（`ignore/p4/rea/p4b-render/texscan_assets.txt`），
 * 数据用确定的花样填，不依赖 `ignore/` 与本机 WPE；最后一组用真翻译器核对四种宏组合都能翻译（本机有 WPE 时）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  compileScene,
  particleRendererDefines,
  particleSheetDefines,
  particleTex0Format,
  spriteSheet,
  type ParticleSheetSystem,
} from "./bundle";
import { checkParticleProgram, checkProgramFeatures, PARTICLE_UNIFORMS } from "./features";
import { SceneFs, type SceneFile, type SceneReader } from "./fs";
import type { JsonObject } from "./model";
import { ShaderCompiler } from "./shader";
import { parseTex, TEX_FLAGS } from "./tex";
import { Wpesl2wgsl, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

const f32 = Math.fround;

function parts(...buffers: (Uint8Array | number[])[]): Uint8Array {
  const arrays = buffers.map((b) => (b instanceof Uint8Array ? b : new Uint8Array(b)));
  const out = new Uint8Array(arrays.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of arrays) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};
const i32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, true);
  return out;
};
const float = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value, true);
  return out;
};
const magic = (text: string) => parts(new TextEncoder().encode(text), [0]);

/** 一帧的文件内容：`[imageId, frametime, x, y, width, widthY, heightX, height]`（坐标是像素）。 */
type RawFrame = [number, number, number, number, number, number, number, number];

interface SheetSpec {
  format: number;
  flags?: number;
  textureWidth: number;
  textureHeight: number;
  width: number;
  height: number;
  container?: 2 | 3 | 4;
  /** 每张图像的 mip 尺寸（第一项是第 0 级）。缺省一张图像、一级 mip、纹理尺寸。 */
  images?: [number, number][][];
  /** TEXS 版本；不给时不是帧表。 */
  texs?: 1 | 2 | 3;
  frames?: RawFrame[];
}

/** 按 TextureParser 的布局拼一个 `.tex`，帧表块接在图像之后。mip 数据每像素 1 字节的花样，不按格式算长度。 */
function sheetTex(spec: SheetSpec): Uint8Array {
  const container = spec.container ?? 3;
  const images = spec.images ?? [[[spec.textureWidth, spec.textureHeight]]];
  const flags = (spec.flags ?? TEX_FLAGS.clampUVs) | (spec.texs ? TEX_FLAGS.animated : 0);
  const imageBytes = images.map((mips) =>
    parts(
      u32(mips.length),
      ...mips.map(([w, h], level) => {
        const data = new Uint8Array(w * h).map((_, i) => (i + level * 7) & 255);
        return parts(u32(w), u32(h), ...(container >= 2 ? [u32(0), u32(data.length)] : []), u32(data.length), data);
      }),
    ),
  );
  const texs = spec.texs
    ? parts(
        magic(`TEXS000${spec.texs}`),
        u32(spec.frames!.length),
        ...(spec.texs === 3 ? [u32(spec.width), u32(spec.height)] : []),
        ...spec.frames!.map(([image, time, ...coords]) =>
          parts(i32(image), float(time), ...coords.map((c) => (spec.texs === 1 ? i32(c) : float(c)))),
        ),
      )
    : new Uint8Array();
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(spec.format),
    u32(flags),
    u32(spec.textureWidth),
    u32(spec.textureHeight),
    u32(spec.width),
    u32(spec.height),
    u32(0),
    magic(`TEXB000${container}`),
    u32(images.length),
    ...(container >= 3 ? [u32(-1)] : []),
    ...(container === 4 ? [u32(0)] : []),
    ...imageBytes,
    texs,
  );
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

/** 一个网格帧表：`columns` 列、`count` 帧，每帧 `w × h` 像素，从左上开始按行排。 */
function grid(count: number, columns: number, w: number, h: number, time = 0.016): RawFrame[] {
  return Array.from({ length: count }, (_, i) => [0, time, (i % columns) * w, Math.floor(i / columns) * h, w, 0, 0, h]);
}

/** assets 里的真实帧表纹理（只复刻头部与帧表，2026-11-08 读头）。 */
const SAMPLES: Record<string, SheetSpec> = {
  /** R8 1024²，TEXS0003，64 帧 128²。 */
  fog1: {
    format: 9,
    textureWidth: 1024,
    textureHeight: 1024,
    width: 1024,
    height: 1024,
    texs: 3,
    frames: grid(64, 8, 128, 128),
  },
  /** R8 1024²，4 帧 512²。 */
  rain1: {
    format: 9,
    textureWidth: 1024,
    textureHeight: 1024,
    width: 1024,
    height: 1024,
    texs: 3,
    frames: grid(4, 2, 512, 512, 0.25),
  },
  /** RGBA 512²，30 帧 85.334 × 102.4（非整数像素的帧）。 */
  bubble1: {
    format: 0,
    textureWidth: 512,
    textureHeight: 512,
    width: 512,
    height: 512,
    texs: 3,
    frames: Array.from({ length: 30 }, (_, i) => [
      0,
      0.033,
      f32((i % 6) * 85.334),
      f32(Math.floor(i / 6) * 102.4),
      f32(85.334),
      0,
      0,
      f32(102.4),
    ]),
  },
  /** R8 1024×512，TEXS0002，32 帧 256×64：纹理不是正方形，帧宽高比 0.25。 */
  lightning2: {
    format: 9,
    container: 2,
    textureWidth: 1024,
    textureHeight: 512,
    width: 1024,
    height: 512,
    texs: 2,
    frames: grid(32, 4, 256, 64, 0),
  },
  /** R8 1024²，TEXS0002，128 帧 64×128：帧宽高比 2。 */
  fire3: {
    format: 9,
    container: 2,
    textureWidth: 1024,
    textureHeight: 1024,
    width: 1024,
    height: 1024,
    texs: 2,
    frames: grid(128, 16, 64, 128, 0),
  },
  /** DXT5 256²，8 帧 32×128：帧宽高比 4。 */
  raindrops: {
    format: 4,
    container: 4,
    textureWidth: 256,
    textureHeight: 256,
    width: 256,
    height: 256,
    texs: 3,
    frames: grid(8, 8, 32, 128, 0.125),
  },
};

describe("parseTex：TEXS 帧表（rea-p4b-render.md 2.1）", () => {
  it("TEXS0003：头里多宽高；坐标是 f32，按第 0 级 mip 尺寸精确除（float32）", async () => {
    const result = await parseTex(memoryFile(sheetTex(SAMPLES.bubble1)));
    expect(result.animatedVersion).toBe(3);
    expect([result.frameCount, result.gifWidth, result.gifHeight]).toEqual([30, 512, 512]);
    expect(result.frames).toHaveLength(30);
    const [first, second] = result.frames!;
    expect(first).toEqual({
      image: 0,
      frametime: f32(0.033),
      x: 0,
      y: 0,
      width: f32(f32(85.334) / 512),
      widthY: 0,
      heightX: 0,
      height: f32(f32(102.4) / 512),
    });
    expect(second.x).toBe(f32(f32(85.334) / 512));
    expect(result.frames![6].y).toBe(f32(f32(102.4) / 512));
  });

  it("TEXS0001：6 个坐标是 i32（转 float 再除）；frametime 仍是 f32；纵横分母分开取", async () => {
    const result = await parseTex(
      memoryFile(
        sheetTex({
          format: 0,
          container: 2,
          textureWidth: 256,
          textureHeight: 128,
          width: 256,
          height: 128,
          texs: 1,
          frames: [
            [0, 0.5, 64, 32, 64, 16, 8, 32],
            [0, 0.25, 128, 96, -64, 0, 0, 32],
          ],
        }),
      ),
    );
    expect(result.animatedVersion).toBe(1);
    expect(result.gifWidth).toBeUndefined();
    expect(result.frames).toEqual([
      { image: 0, frametime: 0.5, x: 0.25, y: 0.25, width: 0.25, widthY: 0.125, heightX: 0.03125, height: 0.25 },
      { image: 0, frametime: 0.25, x: 0.5, y: 0.75, width: -0.25, widthY: 0, heightX: 0, height: 0.25 },
    ]);
  });

  it("TEXS0002：坐标是 f32、没有头宽高", async () => {
    const result = await parseTex(memoryFile(sheetTex(SAMPLES.lightning2)));
    expect(result.animatedVersion).toBe(2);
    expect(result.gifWidth).toBeUndefined();
    expect(result.frames![0]).toMatchObject({ x: 0, y: 0, width: 0.25, height: 0.125 });
    expect(result.frames![5]).toMatchObject({ x: 0.25, y: 0.125 });
  });

  it("分母是第 0 级 mip（填充后的尺寸），不是头里的图像尺寸；imageId 越界时 6 个坐标为 0", async () => {
    // 图像宽 896（NPOT，照 p4b-tex 的 fog1_w896）：mip0 仍是 1024，归一化不变；更小的 mip 不参与
    const npot = await parseTex(
      memoryFile(
        sheetTex({
          ...SAMPLES.fog1,
          width: 896,
          images: [
            [
              [1024, 1024],
              [512, 512],
              [256, 256],
            ],
          ],
        }),
      ),
    );
    expect(npot.images[0].mips).toHaveLength(3);
    expect(npot.frames![1]).toMatchObject({ x: 0.125, width: 0.125, height: 0.125 });
    const stray = await parseTex(
      memoryFile(
        sheetTex({
          ...SAMPLES.rain1,
          frames: [
            [1, 0.25, 512, 0, 512, 0, 0, 512],
            [-1, 0.25, 512, 0, 512, 0, 0, 512],
            [0, 0.25, 512, 512, 512, 0, 0, 512],
          ],
        }),
      ),
    );
    expect(stray.frames!.map((frame) => [frame.image, frame.x, frame.width, frame.height])).toEqual([
      [1, 0, 0, 0],
      [-1, 0, 0, 0],
      [0, 0.5, 0.5, 0.5],
    ]);
  });

  it("帧表纹理照报 tex:animation，但 mip 照常解码（粒子槽 0 要上传）；多图像、空帧表另报", async () => {
    const sheet = await parseTex(memoryFile(sheetTex(SAMPLES.rain1)));
    expect(sheet.unsupported).toEqual(["tex:animation"]);
    expect(sheet.images[0].mips[0].bytes?.length).toBe(1024 * 1024);
    // 还有别的不支持项时照旧不解码
    const other = await parseTex(memoryFile(sheetTex({ ...SAMPLES.rain1, format: 10 })));
    expect(other.unsupported).toEqual(["tex:animation", "tex:format:10"]);
    expect(other.images[0].mips[0].bytes).toBeUndefined();
    // 调用方要求不解码时不解码
    expect((await parseTex(memoryFile(sheetTex(SAMPLES.rain1)), false)).images[0].mips[0].bytes).toBeUndefined();
    const multi = await parseTex(
      memoryFile(
        sheetTex({
          ...SAMPLES.rain1,
          images: [[[1024, 1024]], [[512, 512]]],
          frames: [
            [0, 0.25, 0, 0, 512, 0, 0, 512],
            [1, 0.25, 0, 0, 256, 0, 0, 256],
          ],
        }),
      ),
    );
    expect(multi.unsupported).toEqual(["tex:animation", "tex:animation:multi-image"]);
    // 第二帧按自己所在图像（512²）归一化
    expect(multi.frames![1]).toMatchObject({ image: 1, width: 0.5, height: 0.5 });
    const empty = await parseTex(memoryFile(sheetTex({ ...SAMPLES.rain1, frames: [] })));
    expect(empty.unsupported).toEqual(["tex:animation", "tex:animation:empty"]);
    expect(empty.frames).toEqual([]);
    // 不是帧表的纹理：没有 frames
    const plain = await parseTex(memoryFile(sheetTex({ ...SAMPLES.rain1, texs: undefined })));
    expect(plain.frames).toBeUndefined();
    expect(plain.unsupported).toEqual([]);
  });
});

describe("spriteSheet：g_RenderVar1 与 NPOT（rea-p4b-render.md 2.2、2.4）", () => {
  const sheetOf = async (spec: SheetSpec) => {
    const tex = await parseTex(memoryFile(sheetTex(spec)), false);
    return spriteSheet(tex, tex.textureWidth, tex.textureHeight);
  };

  it.each([
    // 读码给出的例子与计划的帧宽高比（lightning 0.25、fire 2、bubble 1.2、raindrops 4）
    ["fog1", [0.125, 0.125, 64, 1]],
    ["rain1", [0.5, 0.5, 4, 1]],
    ["bubble1", [f32(f32(85.334) / 512), f32(0.2), 30, f32(f32(f32(102.4) / 512) / f32(f32(85.334) / 512))]],
    ["lightning2", [0.25, 0.125, 32, 0.25]],
    ["fire3", [0.0625, 0.125, 128, 2]],
    ["raindrops", [0.125, 0.5, 8, 4]],
  ] as const)("%s：renderVar1 = (帧宽, 帧高, 帧数, (纹理高 / 纹理宽)·(帧高 / 帧宽))", async (name, expected) => {
    const sheet = await sheetOf(SAMPLES[name]);
    expect(sheet?.renderVar1).toEqual(expected);
    expect(sheet?.npot).toBe(false);
  });

  it("bubble1 的帧宽高比约 1.2（帧宽是 85.334，不是 512 / 6）", async () => {
    expect((await sheetOf(SAMPLES.bubble1))!.renderVar1[3]).toBeCloseTo(1.2, 4);
  });

  it("纹理宽高比进 w：同样的归一化帧，纹理 1024×512 时 w 减半", async () => {
    const square = await sheetOf({ ...SAMPLES.lightning2, textureHeight: 1024, height: 1024, images: [[[1024, 512]]] });
    // 帧坐标仍按 mip0（1024×512）归一化，只有头里的纹理高变了
    expect(square!.renderVar1).toEqual([0.25, 0.125, 32, 0.5]);
  });

  it("NPOT 只比宽度：图像宽 896 < 纹理宽是 NPOT；只改图像高不是", async () => {
    expect((await sheetOf({ ...SAMPLES.fog1, width: 896 }))!.npot).toBe(true);
    expect((await sheetOf({ ...SAMPLES.fog1, height: 896 }))!.npot).toBe(false);
    // NPOT 不改 renderVar1（帧坐标按填充后的 mip0 归一化）
    expect((await sheetOf({ ...SAMPLES.fog1, width: 896 }))!.renderVar1).toEqual([0.125, 0.125, 64, 1]);
  });

  it("不是帧表或帧表为空：没有 sheet", async () => {
    expect(await sheetOf({ ...SAMPLES.fog1, texs: undefined })).toBeUndefined();
    expect(await sheetOf({ ...SAMPLES.fog1, frames: [] })).toBeUndefined();
  });
});

describe("particleSheetDefines：帧表宏（FUN_1401d2340）", () => {
  const sheet = { renderVar1: [0.125, 0.125, 64, 1] as [number, number, number, number], npot: false };
  const sequence: ParticleSheetSystem = { flags: 0, animationMode: "sequence" };

  it("四种组合：混帧看系统 flags bit1 与 randomframe，NPOT 看 sheet.npot；值为 0 的宏也写键", () => {
    expect(particleSheetDefines(sheet, sequence)).toEqual({
      THICKFORMAT: "1",
      SPRITESHEET: "1",
      SPRITESHEETBLEND: "1",
      SPRITESHEETBLENDNPOT: "0",
    });
    expect(particleSheetDefines({ ...sheet, npot: true }, sequence)).toEqual({
      THICKFORMAT: "1",
      SPRITESHEET: "1",
      SPRITESHEETBLEND: "1",
      SPRITESHEETBLENDNPOT: "1",
    });
    expect(particleSheetDefines(sheet, { flags: 2, animationMode: "sequence" })).toMatchObject({
      SPRITESHEETBLEND: "0",
      SPRITESHEETBLENDNPOT: "0",
    });
    expect(particleSheetDefines({ ...sheet, npot: true }, { flags: 0, animationMode: "randomframe" })).toEqual({
      THICKFORMAT: "1",
      SPRITESHEET: "1",
      SPRITESHEETBLEND: "0",
      SPRITESHEETBLENDNPOT: "1",
    });
    // 别的位不影响混帧
    expect(particleSheetDefines(sheet, { flags: 4 | 8 | 128, animationMode: "sequence" }).SPRITESHEETBLEND).toBe("1");
    expect(particleSheetDefines(sheet, { flags: 255, animationMode: "sequence" }).SPRITESHEETBLEND).toBe("0");
  });

  it("没有帧表：空对象（宏与缓存键和步骤 1 逐字相同）", () => {
    expect(particleSheetDefines(undefined, sequence)).toEqual({});
    expect(particleSheetDefines(undefined, { flags: 2, animationMode: "randomframe" })).toEqual({});
  });
});

function memoryReader(files: Record<string, unknown>): SceneReader {
  const reader: SceneReader = {
    async readWhole(path) {
      const value = files[path.replace(/\\/g, "/")];
      if (value === undefined) throw new TypeError("Failed to fetch");
      if (value instanceof Uint8Array) return value;
      return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
    },
    async readRange(path, start, end) {
      return (await reader.readWhole(path)).slice(start, end);
    },
  };
  return reader;
}
function fakeTranslator(reply: (request: TranslateRequest) => TranslateResult = () => ({ ok: true })) {
  const requests: TranslateRequest[] = [];
  const translator = {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      return reply(request);
    },
  } as unknown as Wpesl2wgsl;
  return { translator, requests };
}

describe("renderer 的宏（P4c 步骤 5，FUN_1401d2340，rea-p4c-render.md 6.2、rea-p4b-render.md 2.4）", () => {
  const system = (kind: "sprite" | "spritetrail", mode: 0 | 1 | 2 = 0): ParticleSheetSystem => ({
    flags: 0,
    animationMode: "sequence",
    renderer: { kind, orientation: { mode } },
  });

  it("particleRendererDefines：拖尾写 THICKFORMAT、TRAILRENDERER；sprite（任何朝向）与缺省不写", () => {
    expect(particleRendererDefines(system("spritetrail"))).toEqual({ THICKFORMAT: "1", TRAILRENDERER: "1" });
    expect(particleRendererDefines(system("spritetrail", 2))).toEqual({ THICKFORMAT: "1", TRAILRENDERER: "1" });
    for (const mode of [0, 1, 2] as const) expect(particleRendererDefines(system("sprite", mode))).toEqual({});
    expect(particleRendererDefines({ flags: 0, animationMode: "sequence" })).toEqual({});
  });

  it("particleTex0Format：厚格式只看 8–11；非厚格式 sprite 的非 screen 朝向对任何格式都写；格式未知不写", () => {
    for (const format of [0, 4, 6, 7, 12]) {
      expect(particleTex0Format(format, false, system("sprite", 0)), `${format}`).toBeUndefined();
      expect(particleTex0Format(format, false, system("sprite", 1)), `${format}`).toBe(format);
      expect(particleTex0Format(format, false, system("sprite", 2)), `${format}`).toBe(format);
      // 厚格式（帧表的 sprite、拖尾）：朝向不起作用
      expect(particleTex0Format(format, true, system("sprite", 2)), `${format}`).toBeUndefined();
      expect(particleTex0Format(format, true, system("spritetrail", 1)), `${format}`).toBeUndefined();
    }
    for (const format of [8, 9, 10, 11])
      for (const thick of [false, true])
        for (const mode of [0, 1, 2] as const)
          expect(particleTex0Format(format, thick, system("sprite", mode))).toBe(format);
    expect(particleTex0Format(undefined, false, system("sprite", 2))).toBeUndefined();
    expect(particleTex0Format(0, false, { flags: 0, animationMode: "sequence" })).toBeUndefined();
  });
});

describe("compileScene：帧表纹理按用途（P4b 步骤 2）", () => {
  const ORTHO = { orthogonalprojection: { width: 1920, height: 1080 } };
  const system = (extra: JsonObject = {}) => ({
    material: "materials/pm.json",
    maxcount: 3,
    emitter: [{ name: "sphererandom", rate: 1 }],
    ...extra,
  });
  const files = (extra: Record<string, unknown> = {}) => ({
    "P:/p/project.json": { file: "scene.json" },
    "P:/p/scene.json": { general: ORTHO, objects: [{ id: 1, particle: "particles/p.json" }] },
    "P:/p/particles/p.json": system(),
    "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: ["particle/fog1"] }] },
    "P:/p/materials/particle/fog1.tex": sheetTex(SAMPLES.fog1),
    "P:/p/materials/particle/fog1w.tex": sheetTex({ ...SAMPLES.fog1, width: 896 }),
    "P:/p/materials/particle/plain.tex": sheetTex({ ...SAMPLES.fog1, texs: undefined, format: 8 }),
    "P:/p/models/a.json": { material: "materials/a.json", width: 40, height: 60 },
    "P:/p/materials/a.json": { passes: [{ shader: "genericimage2", textures: ["particle/fog1"] }] },
    "P:/p/shaders/genericparticle.vert": "void main(){}",
    "P:/p/shaders/genericparticle.frag": "void main(){}",
    "P:/p/shaders/genericimage2.vert": "void main(){}",
    "P:/p/shaders/genericimage2.frag": "void main(){}",
    ...extra,
  });
  const compile = (reader: SceneReader, translator: Wpesl2wgsl) =>
    compileScene({
      projectDir: "P:/p",
      sceneAssets: ["A:/assets"],
      reader,
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });

  it("粒子材质槽 0 是帧表：不报 tex:animation，写帧表宏，sheet 进 bundle，spriteSheet 为 true，mip 已解码", async () => {
    const { translator, requests } = fakeTranslator();
    const bundle = await compile(memoryReader(files()), translator);
    expect(bundle.unsupported).toEqual([]);
    expect(requests.map((request) => request.defines)).toEqual([
      {
        SCENE_ORTHO: "1",
        THICKFORMAT: "1",
        SPRITESHEET: "1",
        SPRITESHEETBLEND: "1",
        SPRITESHEETBLENDNPOT: "0",
        TEX0FORMAT: "9",
      },
    ]);
    expect(bundle.textures[0].sheet).toEqual({ renderVar1: [0.125, 0.125, 64, 1], npot: false });
    expect(bundle.textures[0].mips.map((mip) => mip.bytes?.length)).toEqual([1024 * 1024]);
    expect(bundle.layers[0].particle!.spriteSheet).toBe(true);
    expect(bundle.layers[0].particle!.passes[0].textures).toEqual({ 0: 0 });
  });

  it.each([
    [{ flags: 2 }, "particle/fog1", "0", "0"],
    [{ animationmode: "randomframe" }, "particle/fog1", "0", "0"],
    [{}, "particle/fog1w", "1", "1"],
    [{ animationmode: "randomframe", flags: 2 }, "particle/fog1w", "0", "1"],
  ] as const)("系统 %j、纹理 %s：SPRITESHEETBLEND %s、SPRITESHEETBLENDNPOT %s", async (top, name, blend, npot) => {
    const { translator, requests } = fakeTranslator();
    const bundle = await compile(
      memoryReader(
        files({
          "P:/p/particles/p.json": system(top),
          "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: [name] }] },
        }),
      ),
      translator,
    );
    expect(bundle.unsupported).toEqual([]);
    expect(requests[0].defines).toMatchObject({ SPRITESHEETBLEND: blend, SPRITESHEETBLENDNPOT: npot });
  });

  it("槽 0 没按名字写、着色器注解默认是帧表纹理：同样按帧表处理", async () => {
    const { translator, requests } = fakeTranslator(() => ({
      ok: true,
      textures: [
        { slot: 0, name: "g_Texture0", kind: "2d", binding: 1, samplerBinding: 2, meta: { default: "particle/fog1" } },
      ],
    }));
    const bundle = await compile(
      memoryReader(files({ "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle" }] } })),
      translator,
    );
    expect(bundle.unsupported).toEqual([]);
    expect(requests.map((request) => request.defines?.SPRITESHEET)).toEqual([undefined, "1"]);
    expect(bundle.layers[0].particle!.spriteSheet).toBe(true);
  });

  it("帧表纹理用在粒子槽 1：普通纹理，不报 tex:animation、不算帧表（P4b 步骤 5）；用在图像层照报，缓存命中也照报", async () => {
    const { translator, requests } = fakeTranslator();
    const slot1 = await compile(
      memoryReader(
        files({
          "P:/p/materials/pm.json": {
            passes: [{ shader: "genericparticle", textures: ["particle/plain", "particle/fog1"] }],
          },
        }),
      ),
      translator,
    );
    expect(slot1.unsupported).toEqual([]);
    expect(slot1.layers[0].particle!.passes[0].textures).toEqual({ 0: 0, 1: 1 });
    // 帧表语义只按槽 0：spriteSheet 为 false，宏只有槽 0 的 TEX0FORMAT
    expect(slot1.layers[0].particle!.spriteSheet).toBe(false);
    expect(requests.map((request) => request.defines)).toEqual([{ SCENE_ORTHO: "1", TEX0FORMAT: "8" }]);
    const image = await compile(
      memoryReader(
        files({
          // 先粒子（槽 0，合法），后图像层（缓存命中，按用途照报）
          "P:/p/scene.json": {
            general: ORTHO,
            objects: [
              { id: 1, particle: "particles/p.json" },
              { id: 2, image: "models/a.json" },
            ],
          },
        }),
      ),
      fakeTranslator().translator,
    );
    expect(image.unsupported).toEqual(["tex:animation"]);
    expect(image.textures).toHaveLength(1);
  });

  it("拖尾 + 帧表（P4c 步骤 5）：THICKFORMAT、TRAILRENDERER 之外照写 SPRITESHEET*；混帧规则不变", async () => {
    const { translator, requests } = fakeTranslator();
    const bundle = await compile(
      memoryReader(files({ "P:/p/particles/p.json": system({ renderer: [{ name: "spritetrail", minlength: 3 }] }) })),
      translator,
    );
    expect(bundle.unsupported).toEqual([]);
    expect(requests.map((request) => request.defines)).toEqual([
      {
        SCENE_ORTHO: "1",
        THICKFORMAT: "1",
        TRAILRENDERER: "1",
        SPRITESHEET: "1",
        SPRITESHEETBLEND: "1",
        SPRITESHEETBLENDNPOT: "0",
        TEX0FORMAT: "9",
      },
    ]);
    expect(bundle.layers[0].particle!.spriteSheet).toBe(true);
    expect(bundle.layers[0].particle!.renderer.trail).toEqual([Math.fround(0.05), 10, 3]);
  });

  it("没有帧表的粒子材质：宏逐字和步骤 1 相同（只有 TEX0FORMAT），spriteSheet 为 false", async () => {
    const { translator, requests } = fakeTranslator();
    const bundle = await compile(
      memoryReader(
        files({
          "P:/p/particles/p.json": system({ animationmode: "randomframe", sequencemultiplier: 3, flags: 2 }),
          "P:/p/materials/pm.json": { passes: [{ shader: "genericparticle", textures: ["particle/plain"] }] },
        }),
      ),
      translator,
    );
    expect(bundle.unsupported).toEqual([]);
    // 场景级的 SCENE_ORTHO 之外只有步骤 1 的 TEX0FORMAT
    expect(requests.map((request) => request.defines)).toEqual([{ SCENE_ORTHO: "1", TEX0FORMAT: "8" }]);
    expect(bundle.textures[0].sheet).toBeUndefined();
    expect("sheet" in bundle.textures[0]).toBe(false);
    expect(bundle.layers[0].particle!.spriteSheet).toBe(false);
  });
});

const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const diskReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (start >= bytes.length) throw new TypeError("Failed to fetch");
    return new Uint8Array(bytes.subarray(start, end));
  },
};

describe.skipIf(!root || !existsSync(wasm))("真翻译器：genericparticle 的帧表宏组合", () => {
  it("SPRITESHEETBLEND × SPRITESHEETBLENDNPOT × 格式都能翻译：多一组 a_TexCoordVec4C1，程序检查不报新项", async () => {
    const translator = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
    const fs = new SceneFs(join(root!, "projects", "defaultprojects", "none"), [join(root!, "assets")], diskReader);
    const shader = new ShaderCompiler(fs, translator, new Set());
    const pass = { shader: "genericparticle", textures: ["particle/fog/fog1"] };
    for (const blend of ["0", "1"])
      for (const npot of ["0", "1"])
        for (const format of [0, 4, 8, 9]) {
          const issues = new Set<string>();
          const defines: Record<string, string> = {
            THICKFORMAT: "1",
            SPRITESHEET: "1",
            SPRITESHEETBLEND: blend,
            SPRITESHEETBLENDNPOT: npot,
            ...(format >= 8 ? { TEX0FORMAT: String(format) } : {}),
          };
          const result = await shader.compile("genericparticle", {}, [{ slot: 0, format }], null, issues, defines);
          const label = JSON.stringify(defines);
          expect(result?.ok, label).toBe(true);
          expect(
            result!.attributes!.map((attribute) => `${attribute.name}:${attribute.type}`),
            label,
          ).toContain("a_TexCoordVec4C1:vec4");
          checkParticleProgram(pass, result, issues);
          checkProgramFeatures(result!, issues, PARTICLE_UNIFORMS);
          expect([...issues], label).toEqual([]);
          // g_RenderVar1 在顶点阶段真的被读（帧表数学全在着色器里）
          expect(result!.vertex!.wgsl, label).toContain("g_RenderVar1");
        }
  }, 120000);
});
