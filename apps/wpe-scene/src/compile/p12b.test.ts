/**
 * P12b1 步骤 3、5 的编译侧单测（`.claude/plans/wpe-import/3-scene/phase12/phase-12b-attach-morph-clip.md`）：
 * - 挂点（步骤 3 点 1）：`attachment` 是字符串、`parent` 指向 skinned puppet、父排在子前面、`MDAT` 里有同名项（区分大小写、取第一个）才解析成
 *   `SceneLayer.attachment`，其余按普通父子；键本身中性（不再报 `object:attachment`）；
 * - 裁切遮罩（步骤 5 点 2）：遮罩 pass = `clippingmaskimage4` + puppet 组合键（基础材质 alphatocoverage 时加 `ALPHATOCOVERAGE`），槽 1 是记录的遮罩纹理，
 *   槽 0 直接上屏取基础材质的纹理、合成路径由渲染图填；目标 pass = 基础材质着色器 + puppet 组合键 + `CLIPPINGUVS` / `CLIPPINGTARGET`；
 * - `transferableBuffers` 带上变形纹理与裁切分段。
 * `buildPuppet`（步骤 1、2 的另一半）用 `vi.mock` 在真实结果上补挂点 / 变形 / 裁切字段，接口见 `compile/puppet.ts`。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { compileScene, resolveAttachment, transferableBuffers } from "./bundle";
import { existsSync, readFileSync, readSync, openSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkObjectFeatures } from "./features";
import { FetchSceneReader } from "./fs";
import { Wpesl2wgsl as RealTranslator } from "../wpesl2wgsl";
import type { SceneReader } from "./fs";
import type { ScenePuppet } from "./puppet";
import modes from "../puppet/fixtures/p12-modes.json";
import type { TranslateRequest, TranslateResult, Wpesl2wgsl } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

/** 测试里给真实的 `buildPuppet` 结果补字段（挂点、变形、裁切）；没设时原样。 */
const patch = vi.hoisted(() => ({ value: null as null | ((puppet: ScenePuppet) => void) }));
vi.mock("./puppet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./puppet")>();
  return {
    ...actual,
    buildPuppet: (...args: Parameters<typeof actual.buildPuppet>) => {
      const built = actual.buildPuppet(...args);
      if (built.puppet) patch.value?.(built.puppet);
      return built;
    },
  };
});

const loop10 = modes.puppets.find((item) => item.name === "loop10")!;
const mdl = new Uint8Array(gunzipSync(Buffer.from(loop10.mdlGzip, "base64")));
const animationId = (loop10.layers[0] as { animation: number }).animation;

function parts(...buffers: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(buffers.reduce((sum, bytes) => sum + bytes.length, 0));
  let at = 0;
  for (const bytes of buffers) {
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}
const u32 = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};
const magic = (text: string) => parts(new TextEncoder().encode(text), new Uint8Array([0]));
/** RGBA8 单 mip 的 `.tex`（遮罩纹理的替身）。 */
function tex(size = 8): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  return parts(
    magic("TEXV0005"),
    magic("TEXI0001"),
    u32(0),
    u32(0),
    u32(size),
    u32(size),
    u32(size),
    u32(size),
    u32(0),
    magic("TEXB0002"),
    u32(1),
    u32(1),
    u32(size),
    u32(size),
    u32(0),
    u32(data.length),
    u32(data.length),
    data,
  );
}

function memoryReader(files: Record<string, Uint8Array | string>): SceneReader {
  const bytes = (path: string) => {
    const value = files[path.replace(/\\/g, "/")];
    if (value === undefined) throw new TypeError("Failed to fetch");
    return typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
  };
  return {
    async readWhole(path) {
      return bytes(path);
    },
    async readRange(path, start, end) {
      return bytes(path).slice(start, end);
    },
  };
}

/** 假翻译器：组合键原样回给 `combos`，带 `SKINNING` 时多一个 `g_Bones`；记下每次请求（顶点原文区分着色器）。 */
function fakeTranslator(requests: TranslateRequest[]): Wpesl2wgsl {
  return {
    async translate(request: TranslateRequest): Promise<TranslateResult> {
      requests.push(request);
      const combos = Object.entries(request.combos ?? {}).map(([name, value]) => ({
        name,
        value: Number(value),
        source: "request" as const,
      }));
      const bones = Number(request.combos?.BONECOUNT ?? 0);
      // 顶点原文带 RV0 的着色器读 g_RenderVar0（遮罩着色器 clippingmaskimage4 真实就读它）
      const renderVar = request.vertex.includes("RV0")
        ? [{ name: "g_RenderVar0", type: "vec4<f32>", declared: "vec4", offset: 4096, size: 16 }]
        : [];
      return {
        ok: true,
        uniforms: request.combos?.SKINNING
          ? [
              {
                name: "g_Bones",
                type: `array<mat4x3<f32>, ${bones}>`,
                declared: "mat4x3",
                offset: 0,
                size: 64 * bones,
                array: bones,
                stride: 64,
              },
              ...renderVar,
            ]
          : renderVar,
        uniformBlockSize: request.combos?.SKINNING ? 64 * bones : 0,
        textures: [],
        combos,
      } as unknown as TranslateResult;
    },
  } as unknown as Wpesl2wgsl;
}

async function compile(
  objects: Record<string, unknown>[],
  options: { files?: Record<string, Uint8Array | string>; material?: Record<string, unknown> } = {},
) {
  const requests: TranslateRequest[] = [];
  const bundle = await compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: memoryReader({
      "P:/p/project.json": JSON.stringify({ file: "scene.json" }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 1920, height: 1080 } }, objects }),
      "P:/p/models/pup.json": JSON.stringify({ material: "materials/a.json", puppet: "models/pup.mdl" }),
      "P:/p/models/plain.json": JSON.stringify({ material: "materials/a.json" }),
      "P:/p/models/pup.mdl": mdl,
      "P:/p/materials/a.json": JSON.stringify({
        passes: [{ shader: "s", blending: "translucent", textures: ["masks/base"], ...options.material }],
      }),
      "P:/p/materials/masks/base.tex": tex(),
      "P:/p/materials/masks/clipping_mask_a.tex": tex(),
      "P:/p/materials/masks/clipping_mask_b.tex": tex(),
      "P:/p/materials/util/effectpassthrough.json": JSON.stringify({
        passes: [
          { shader: "pt", blending: "normal", depthtest: "disabled", depthwrite: "disabled", cullmode: "nocull" },
        ],
      }),
      "P:/p/materials/util/clippingmaskimage4.json": JSON.stringify({
        passes: [
          { shader: "clippingmaskimage4", depthtest: "disabled", depthwrite: "disabled", blending: "translucent" },
        ],
      }),
      "P:/p/shaders/s.vert": "// base",
      "P:/p/shaders/s.frag": "void main() {}",
      "P:/p/shaders/pt.vert": "// pt",
      "P:/p/shaders/pt.frag": "void main() {}",
      "P:/p/shaders/clippingmaskimage4.vert": "// clipmask",
      "P:/p/shaders/clippingmaskimage4.frag": "void main() {}",
      ...options.files,
    }),
    translator: fakeTranslator(requests),
    postprocess: "disabled",
    exhaustive: true,
  });
  return { bundle, requests };
}

const puppetObject = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  name: "P",
  image: "models/pup.json",
  origin: "960 540 0",
  animationlayers: [{ animation: animationId, name: "walk", rate: 1, blend: 1, visible: true }],
  ...extra,
});
const childObject = (extra: Record<string, unknown> = {}) => ({
  id: 2,
  name: "C",
  image: "models/plain.json",
  parent: 1,
  attachment: "head",
  ...extra,
});
const matrix = (x: number) => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);

describe("resolveAttachment（P12b1 步骤 3 点 1）", () => {
  const puppet = {
    skeleton: { parents: new Int32Array(3) },
    attachments: [
      { name: "head", bone: 1, matrix: matrix(5) },
      { name: "head", bone: 2, matrix: matrix(9) },
      { name: "Hand", bone: 0, matrix: matrix(1) },
    ],
  } as unknown as ScenePuppet;
  const lookup = (object: number) => (object === 0 ? puppet : null);

  it("字符串 + 父是 skinned puppet + 父在前 + 名字存在：取第一个同名项", () => {
    const found = resolveAttachment(1, 0, "head", lookup);
    expect(found).toEqual({ parent: 0, bone: 1, matrix: matrix(5) });
    expect(found!.matrix).toBe(puppet.attachments[0].matrix);
  });

  it("名字区分大小写；找不到、不是字符串、没有父、父不是 puppet、父排在子后面、静态 puppet、骨骼越界都是 null", () => {
    expect(resolveAttachment(1, 0, "hand", lookup)).toBeNull();
    expect(resolveAttachment(1, 0, "Hand", lookup)?.bone).toBe(0);
    expect(resolveAttachment(1, 0, "missing", lookup)).toBeNull();
    expect(resolveAttachment(1, 0, 5, lookup)).toBeNull();
    expect(resolveAttachment(1, 0, undefined, lookup)).toBeNull();
    expect(resolveAttachment(1, null, "head", lookup)).toBeNull();
    expect(resolveAttachment(1, 3, "head", lookup)).toBeNull();
    // 父排在子后面：加载时挂点丢失（rea-AP 1.1）
    expect(resolveAttachment(0, 1, "head", (object) => (object === 1 ? puppet : null))).toBeNull();
    expect(resolveAttachment(0, 0, "head", () => puppet)).toBeNull();
    const staticPuppet = { ...puppet, skeleton: null } as unknown as ScenePuppet;
    expect(resolveAttachment(1, 0, "head", () => staticPuppet)).toBeNull();
    const outOfRange = {
      ...puppet,
      attachments: [{ name: "x", bone: 3, matrix: matrix(0) }],
    } as unknown as ScenePuppet;
    expect(resolveAttachment(1, 0, "x", () => outOfRange)).toBeNull();
  });

  it("attachment 键本身中性：图像层、模型对象上都不再报 object:attachment", () => {
    for (const object of [
      { id: 1, image: "models/a.json", attachment: "head" },
      { id: 1, model: "models/a.mdl", attachment: "head" },
    ]) {
      const out = new Set<string>();
      checkObjectFeatures(object as never, out);
      expect([...out]).toEqual([]);
    }
  });
});

describe("compileScene：挂点（P12b1 步骤 3）", () => {
  const withAttachments = (attachments: ScenePuppet["attachments"]) => {
    patch.value = (puppet) => {
      puppet.attachments = attachments;
    };
  };

  it("找得到：子对象的 attachment = { 父的 objects 下标, 骨骼, 矩阵 }，不报任何键", async () => {
    withAttachments([{ name: "head", bone: 0, matrix: matrix(7) }]);
    const { bundle } = await compile([puppetObject(), childObject()]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers[0].attachment).toBeUndefined();
    expect(bundle.layers[1].attachment).toEqual({ parent: 0, bone: 0, matrix: matrix(7) });
  });

  it("找不到名字 / 不是字符串 / 父在子后面：不写字段，按普通父子，也不报键", async () => {
    withAttachments([{ name: "head", bone: 0, matrix: matrix(7) }]);
    const missing = await compile([puppetObject(), childObject({ attachment: "tail" })]);
    expect(missing.bundle.layers[1].attachment).toBeUndefined();
    expect(missing.bundle.layers[1].parent).toBe(0);
    expect(missing.bundle.unsupported).toEqual([]);
    const notString = await compile([puppetObject(), childObject({ attachment: 3 })]);
    expect(notString.bundle.layers[1].attachment).toBeUndefined();
    // 子在父前：对象 id 2 排在前面、父 id 1 在后面
    const reversed = await compile([childObject(), puppetObject()]);
    expect(reversed.bundle.layers[0].attachment).toBeUndefined();
    expect(reversed.bundle.layers[0].parent).toBe(1);
  });

  it("重名取第一个（区分大小写）；父不是 puppet 时按普通父子", async () => {
    withAttachments([
      { name: "head", bone: 0, matrix: matrix(1) },
      { name: "head", bone: 0, matrix: matrix(2) },
    ]);
    const duplicate = await compile([puppetObject(), childObject()]);
    expect(duplicate.bundle.layers[1].attachment!.matrix).toEqual(matrix(1));
    patch.value = null;
    const plainParent = await compile([puppetObject({ image: "models/plain.json" }), childObject()]);
    expect(plainParent.bundle.layers[1].attachment).toBeUndefined();
    expect(plainParent.bundle.unsupported).toEqual([]);
  });
});

describe("compileScene：裁切遮罩的材质（P12b1 步骤 5 点 2）", () => {
  const withClipping = (morph = true) => {
    patch.value = (puppet) => {
      puppet.combos = { ...puppet.combos, SKINNING_ALPHA: 1, ...(morph ? { MORPHING: 1 } : {}) };
      puppet.boneAlpha = true;
      puppet.clipping = {
        commands: [
          { kind: "normal", segment: 0 },
          { kind: "clip", record: 0, mask: 1, target: 2 },
          { kind: "clip", record: 1, mask: 3, target: 4 },
          { kind: "normal", segment: 5 },
        ],
        segments: [0, 1, 2, 3, 4, 5].map(() => new Uint16Array([0, 1, 2])),
        records: [{ mask: "materials/masks/clipping_mask_a.tex" }, { mask: "materials/masks/clipping_mask_b.tex" }],
      };
    };
  };
  const clipRequests = (requests: TranslateRequest[]) =>
    requests.filter((request) => request.vertex.startsWith("// clipmask"));
  const baseRequests = (requests: TranslateRequest[]) =>
    requests.filter((request) => request.vertex.startsWith("// base"));

  it("直接上屏：每条记录一个遮罩 pass（槽 0 = 基础反照率、槽 1 = 记录纹理、g_RenderVar0 = 0），目标 pass 带 CLIPPINGUVS / CLIPPINGTARGET", async () => {
    withClipping();
    const { bundle, requests } = await compile([puppetObject()]);
    expect(bundle.unsupported).toEqual([]);
    const puppet = bundle.layers[0].puppet!;
    expect(puppet.composite).toBe(false);
    const clip = puppet.clip!;
    expect(clip.masks.map((pass) => pass.key)).toEqual(["objects/0/puppetclip/0", "objects/0/puppetclip/1"]);
    const baseTexture = puppet.passes[0].textures[0];
    expect(baseTexture).toBeDefined();
    for (const [r, pass] of clip.masks.entries()) {
      expect(pass.textures[0]).toBe(baseTexture);
      const maskTexture = pass.textures[1];
      expect(bundle.textures[maskTexture].path).toBe(`materials/masks/clipping_mask_${r === 0 ? "a" : "b"}.tex`);
      expect(pass.uniforms.g_RenderVar0).toEqual([0, 0, 0, 0]);
      expect(pass.blending).toBe("translucent");
    }
    // 目标 pass：稳定键同基础 pass（常量与属性绑定共用），槽 0 同基础
    expect(clip.target.key).toBe("objects/0/passes/0");
    expect(clip.target.textures[0]).toBe(baseTexture);
    // 翻译请求：遮罩 = puppet 组合键（含 SKINNING_ALPHA / MORPHING），目标 = 基础着色器 + puppet 组合键 + CLIPPING*
    const masks = clipRequests(requests);
    // 两条记录的着色器与组合键相同，翻译结果共用（只请求一次）
    expect(masks).toHaveLength(1);
    expect(masks[0].combos).toMatchObject({ SKINNING: 1, BONECOUNT: 1, SKINNING_ALPHA: 1, MORPHING: 1 });
    expect(masks[0].combos).not.toHaveProperty("ALPHATOCOVERAGE");
    expect(masks[0].combos).not.toHaveProperty("CLIPPINGTARGET");
    expect(baseRequests(requests).map((request) => request.combos ?? {})).toContainEqual(
      expect.objectContaining({ SKINNING: 1, CLIPPINGUVS: 1, CLIPPINGTARGET: 1, MORPHING: 1 }),
    );
  });

  it("基础材质 alphatocoverage：遮罩加 ALPHATOCOVERAGE；没有变形时不带 MORPHING", async () => {
    withClipping(false);
    const { requests } = await compile([puppetObject()], { material: { blending: "alphatocoverage" } });
    for (const request of clipRequests(requests)) {
      expect(request.combos).toMatchObject({ ALPHATOCOVERAGE: 1, SKINNING: 1, SKINNING_ALPHA: 1 });
      expect(request.combos).not.toHaveProperty("MORPHING");
    }
  });

  it("合成路径（有 colorBlendMode 混合）：遮罩 pass 没有静态槽 0（渲染图填合成 RT），目标 pass 同；命令表照旧", async () => {
    withClipping();
    const { bundle } = await compile([puppetObject({ colorBlendMode: 7 })]);
    expect(bundle.unsupported).toEqual([]);
    const puppet = bundle.layers[0].puppet!;
    expect(puppet.composite).toBe(true);
    expect(puppet.passes).toEqual([]);
    const clip = puppet.clip!;
    for (const pass of clip.masks) {
      expect(pass.textures[0]).toBeUndefined();
      expect(pass.textures[1]).toBeDefined();
    }
    expect(clip.target.textures[0]).toBeUndefined();
    expect(clip.target.key).toBe("objects/0/passes/0");
    expect(puppet.clipping!.commands).toHaveLength(4);
  });

  it("没有 clipping 的 puppet 没有 clip 字段；transferableBuffers 带上变形纹理与裁切分段", async () => {
    patch.value = null;
    const plain = await compile([puppetObject()]);
    expect(plain.bundle.layers[0].puppet!.clip).toBeUndefined();
    withClipping();
    patch.value = ((inner) => (puppet: ScenePuppet) => {
      inner(puppet);
      puppet.morph = { scale: 1, vertices: 1, targets: 1, side: 2, texels: new Int16Array(16) };
    })(patch.value!);
    const { bundle } = await compile([puppetObject()]);
    const puppet = bundle.layers[0].puppet!;
    const buffers = transferableBuffers(bundle);
    expect(buffers).toContain(puppet.morph!.texels.buffer);
    for (const segment of puppet.clipping!.segments) expect(buffers).toContain(segment.buffer);
  });
});

describe("裁切遮罩 pass 读 g_RenderVar0（P12b1 步骤 5）", () => {
  const clipping = () => {
    patch.value = (puppet) => {
      puppet.clipping = {
        commands: [{ kind: "clip", record: 0, mask: 0, target: 1 }],
        segments: [new Uint16Array([0, 1, 2]), new Uint16Array([0, 1, 2])],
        records: [{ mask: "materials/masks/clipping_mask_a.tex" }],
      };
    };
  };

  it("遮罩 pass 读 g_RenderVar0 不报", async () => {
    clipping();
    const { bundle } = await compile([puppetObject()], {
      files: { "P:/p/shaders/clippingmaskimage4.vert": "// clipmask RV0" },
    });
    expect(bundle.unsupported).toEqual([]);
  });

  it("别的 puppet pass（基础材质的变体、目标 pass）读到 g_RenderVar0 照报 uniform:g_RenderVar0", async () => {
    clipping();
    const { bundle } = await compile([puppetObject()], { files: { "P:/p/shaders/s.vert": "// base RV0" } });
    expect(bundle.unsupported).toContain("uniform:g_RenderVar0");
  });
});

// ———— 本机语料：整张编译（有 WPE 与订阅的工坊场景时才跑） ————

const wpeRoot = process.env.KABEGAME_WPE_ROOT;
const workshop = wpeRoot ? join(wpeRoot, "..", "..", "workshop", "content", "431960") : "";
const wasm = new URL("../wpesl2wgsl/wpesl2wgsl.wasm", import.meta.url);

describe.skipIf(!wpeRoot || !existsSync(wasm) || !existsSync(join(workshop, "3491865410")))(
  "本机语料：puppet 解锁场景整张编译（P12b1）",
  () => {
    const nodeFetch: typeof fetch = async (input, init) => {
      const path = String(input);
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        throw new TypeError("Failed to fetch");
      }
      const range = new Headers(init?.headers).get("Range")?.match(/^bytes=(\d+)-(\d+)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range ? Number(range[2]) + 1 : size;
      if (range && start >= size) throw new TypeError("Failed to fetch");
      const fd = openSync(path, "r");
      try {
        const bytes = new Uint8Array(Math.max(0, Math.min(end, size) - start));
        readSync(fd, bytes, 0, bytes.length, start);
        return new Response(bytes.buffer, { status: 200 });
      } finally {
        closeSync(fd);
      }
    };

    // 3491865410：裁切 + 挂点；其余五张是 P12b1 解锁的挂点 / 透明度 / 变形场景（没订阅的机器上跳过）
    const ids = ["3491865410", "3463520581", "3829467967", "2964778792", "3500648585", "3253330537"];
    it.each(ids)(
      "%s 整张编译 unsupported 为空",
      async (id) => {
        if (!existsSync(join(workshop, id))) return;
        patch.value = null;
        vi.stubGlobal("fetch", nodeFetch);
        try {
          const translator = await RealTranslator.fromBytes(readFileSync(wasm));
          const bundle = await compileScene({
            projectDir: join(workshop, id),
            sceneAssets: [join(wpeRoot!, "assets")],
            reader: new FetchSceneReader(),
            translator,
            postprocess: "disabled",
            reflection: "disabled",
            exhaustive: true,
          });
          expect(bundle.unsupported).toEqual([]);
          if (id === "3491865410") expect(bundle.layers.some((layer) => layer.puppet?.clip)).toBe(true);
        } finally {
          vi.unstubAllGlobals();
        }
      },
      120000,
    );
  },
);
