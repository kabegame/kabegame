/**
 * kbp corpus scan 的 vitest 入口（点 5）：照 `ignore/p4/c5/corpus.test.ts`，对默认工程与创意工坊工程跑真实编译管线
 * `compileScene(exhaustive)`，每个场景一行 `{ sample, unsupported[], …附加字段 }`，出错的一行 `{ sample, error }`。
 * 附加字段做成插件（`KBP_CORPUS_EXTRA`，JSON 数组），不再每步改测试文件：
 *   - `modules`：每个粒子层里指定模块的字段原文（去掉 id），行字段 `modules[]`（b3、b4 的写法；名单 `category:name`）；
 *   - `controlpoints`：每个粒子层的 flags、控制点数组、读控制点的模块、实例覆盖的控制点、renderer 原文，行字段 `systems[]`
 *     （c1–c5 的写法；c1–c4 没有 `renderer`，c5 起有）；
 *   - `sheets`：帧表纹理绑在哪里（`animatedUsages[]`），以及帧表粒子材质按同样的宏重译一次的结果（`sheets[]`，b2 的写法；
 *     源码没有帧表实现（`particleSheetDefines`）时只有 `animatedUsages`）；
 *   - `requests:<目录>`（P7a 步骤 1）：编译前给翻译器包一层，录下编译管线真实发出的翻译请求（只留结果不是 `include` 的那次，
 *     即头文件补齐后的最终请求），按规范化 JSON 的 SHA-1 去重写 `<目录>/<sha1>.json`，供 `src-tauri/wpesl2wgsl/tests/corpus.rs`
 *     重放；行字段 `requests`（本场景录到的不同请求数）。目录由 kbp.py 检查（非空且没给 --overwrite 时拒绝）。
 * 参数经环境变量（kbp.py 设）：
 *   KBP_SRC          产品源码目录（快照的 src/），翻译器 wasm 跟着它走
 *   KBP_CORPUS_OUT   结果文件（JSON，indent 1，同旧脚本）
 *   KBP_CORPUS_EXTRA 插件，JSON 数组 [{ name, args }]
 *   KBP_CORPUS_ONLY  只跑这些场景（逗号分隔，目录名）
 *   KBP_CORPUS_DIRS  另加的工程目录（JSON 数组；`[名字, 目录]`），排在语料之后
 *   KABEGAME_WPE_ROOT WPE 安装目录（创意工坊是 <WPE>/../../workshop/content/431960）
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path, { join } from "node:path";

const slash = (p: string) => p.replace(/\\/g, "/");
const SRC = slash(path.resolve(process.env.KBP_SRC ?? "apps/wpe-scene/src"));
const ROOT = process.env.KABEGAME_WPE_ROOT ?? "D:/Applications/Steam/steamapps/common/wallpaper_engine";
const ASSETS = join(ROOT, "assets");
const OUT = process.env.KBP_CORPUS_OUT;
const WASM = `${SRC}/wpesl2wgsl/wpesl2wgsl.wasm`;

interface Extra {
  name: string;
  args: string[];
}
const EXTRAS: Extra[] = JSON.parse(process.env.KBP_CORPUS_EXTRA ?? "[]");
const ONLY = process.env.KBP_CORPUS_ONLY?.split(",").filter(Boolean);
const DIRS: [string, string][] = JSON.parse(process.env.KBP_CORPUS_DIRS ?? "[]");

/** 读控制点的模块（rea-p4c-sim.md 第 3 节）；不写 `controlpoint` 时读控制点 0（c1–c5 的 CP_MODULES）。 */
const CP_MODULES = new Set([
  "emitter:sphererandom",
  "emitter:boxrandom",
  "initializer:inheritcontrolpointvelocity",
  "initializer:mapsequencearoundcontrolpoint",
  "initializer:mapsequencebetweencontrolpoints",
  "operator:controlpointattract",
  "operator:maintaindistancetocontrolpoint",
  "operator:maintaindistancebetweencontrolpoints",
  "operator:reducemovementnearcontrolpoint",
  "operator:vortex",
  "operator:vortex_v2",
  "operator:remapvalue",
  "initializer:remapinitialvalue",
]);

/** `modules` 插件的预置名单：`@b3`、`@b4` 是 P4b 步骤 3、4 的模块集合（b3、b4 的 STEP3）。 */
const MODULE_PRESETS: Record<string, string[]> = {
  b3: [
    "emitter:sphererandom",
    "emitter:boxrandom",
    "initializer:alpharandom",
    "operator:sizechange",
    "operator:alphachange",
    "operator:colorchange",
    "operator:oscillatesize",
    "operator:vortex",
    "operator:capvelocity",
  ],
  b4: ["initializer:turbulentvelocityrandom", "initializer:positionoffsetrandom", "operator:turbulence"],
};

const nodeReader = {
  async readWhole(file: string): Promise<Uint8Array> {
    if (!existsSync(file)) throw new TypeError("Failed to fetch");
    return new Uint8Array(readFileSync(file));
  },
  async readRange(file: string, start: number, end: number): Promise<Uint8Array> {
    if (!existsSync(file)) throw new TypeError("Failed to fetch");
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (start >= size) throw new TypeError("Failed to fetch");
      const bytes = new Uint8Array(Math.max(0, Math.min(end, size) - start));
      readSync(fd, bytes, 0, bytes.length, start);
      return bytes;
    } finally {
      closeSync(fd);
    }
  },
};

/** 同旧脚本：默认工程（有 project.json + scene.pkg，或 scene.json，或 project.json 的 file 是现存的 .json）加有 scene.pkg 的创意工坊工程。 */
function listProjects(): [string, string][] {
  const defaults = join(ROOT, "projects", "defaultprojects");
  const workshop = join(ROOT, "..", "..", "workshop", "content", "431960");
  const dirs = readdirSync(defaults)
    .map((name) => join(defaults, name))
    .filter((dir) => {
      if (existsSync(join(dir, "project.json")) && existsSync(join(dir, "scene.pkg"))) return true;
      if (existsSync(join(dir, "scene.json"))) return true;
      try {
        const p = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
        return typeof p.file === "string" && p.file.endsWith(".json") && existsSync(join(dir, p.file));
      } catch {
        return false;
      }
    });
  if (existsSync(workshop))
    dirs.push(
      ...readdirSync(workshop)
        .map((id) => join(workshop, id))
        .filter((dir) => existsSync(join(dir, "scene.pkg"))),
    );
  const out: [string, string][] = dirs.map((dir) => [dir.split(/[\\/]/).at(-1)!, dir]);
  out.push(...DIRS);
  return out;
}

type Json = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** 键排序的规范化 JSON（去重与写文件都用它，两次扫描逐字节相同）。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const key of Object.keys(value as Json).sort()) out[key] = canonical((value as Json)[key]);
    return out;
  }
  return value;
}

const SHADER_EXT = /\.(vert|frag)$/;
const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/^﻿/, "");

/** 路径里第一个 `shaders` 段之后、去掉扩展名的部分，即产品 `shader:<名>:…` 键里的名字；不在 `shaders/` 下返回 null。 */
function shaderName(rel: string): string | null {
  const parts = slash(rel).split("/");
  const at = parts.indexOf("shaders");
  if (at < 0 || at === parts.length - 1) return null;
  return parts.slice(at + 1).join("/").replace(SHADER_EXT, "");
}

/** 着色器源码 → 名字（按来源顺序：散文件、scene.pkg、assets，同一份源码在多处时第一个在前）。 */
type ShaderIndex = Map<string, string[]>;

function addShader(index: ShaderIndex, rel: string, text: string) {
  const name = shaderName(rel);
  if (!name) return;
  const key = `${rel.endsWith(".vert") ? "v" : "f"}\0${text}`;
  const names = index.get(key);
  if (!names) index.set(key, [name]);
  else if (!names.includes(name)) names.push(name);
}

/** 目录下（递归）全部 `.vert` / `.frag`，按名字排序；相对路径用 `/`。 */
function walkShaders(root: string, index: ShaderIndex, rel = "") {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkShaders(root, index, child);
    else if (SHADER_EXT.test(entry.name)) addShader(index, child, decodeText(readFileSync(join(root, child))));
  }
}

interface RecordedRequest {
  /** 编译时用这个请求的全部着色器名（同一份源码与参数可能出自不同名字，跨场景、同场景都有）。 */
  names: Set<string>;
  scenes: Set<string>;
  result: { ok: boolean; phase: string | null; firstError: string | null };
  request: unknown;
}

/** 正在翻译的着色器名：包住 `ShaderCompiler` 的 `translate`（第一个参数就是名字），经异步上下文传到翻译器包装层。 */
const compiling = new AsyncLocalStorage<string>();

/**
 * `requests` 插件的记录器：包住翻译器，录下每次结果不是 `include` 的请求（前端 `translateWithIncludes` 按 `missing` 补头文件
 * 重试，只有最后一次请求是完整的）。
 * 名字：首选产品自己的名字（{@link attach} 包住 `ShaderCompiler.translate`，和产品 `shader:<名>:…` 键逐字相同）；源码里没有这个
 * 方法时按请求里的顶点 / 片元源码在本场景的散文件、scene.pkg、WPE `assets/` 的 `shaders/**` 下反查（两段都对上的第一个名字），
 * 查不到写 `?`。反查在同一份源码出现在多处时会取错（工坊包里常把别人的 effect 原样拷一份、换个目录），所以只作后备。
 */
class RequestRecorder {
  readonly entries = new Map<string, RecordedRequest>();
  private assets: ShaderIndex | null = null;
  private scene: {
    sample: string;
    index: Promise<ShaderIndex> | null;
    build: () => Promise<ShaderIndex>;
    seen: Set<string>;
  } | null = null;

  constructor(readonly dir: string) {}

  /** 包住 `ShaderCompiler.prototype.translate`（运行时改原型，不改产品源码）。 */
  attach(ShaderCompiler: Any) {
    const proto = ShaderCompiler?.prototype;
    const original = proto?.translate;
    if (typeof original !== "function") return;
    proto.translate = function (this: unknown, shader: string, ...rest: unknown[]) {
      return compiling.run(shader, () => original.call(this, shader, ...rest));
    };
  }

  /** 换到下一个场景：散文件与 scene.pkg 的索引按需建（只在反查时用）。 */
  begin(sample: string, dir: string) {
    const build = async () => {
      const out: ShaderIndex = new Map();
      walkShaders(dir, out);
      const pkgFile = join(dir, "scene.pkg");
      if (existsSync(pkgFile)) {
        const { ScenePkg } = await import(`${SRC}/compile/pkg`);
        const pkg = await ScenePkg.open((start: number, end: number) => nodeReader.readRange(pkgFile, start, end));
        for (const entry of pkg.entries as { name: string }[]) {
          if (!SHADER_EXT.test(entry.name)) continue;
          const bytes = await pkg.readEntry(entry.name);
          if (bytes) addShader(out, entry.name, decodeText(bytes));
        }
      }
      if (!this.assets) {
        this.assets = new Map();
        walkShaders(ASSETS, this.assets);
      }
      for (const [key, names] of this.assets) {
        const have = out.get(key);
        if (!have) out.set(key, [...names]);
        else for (const name of names) if (!have.includes(name)) have.push(name);
      }
      return out;
    };
    this.scene = { sample, index: null, build, seen: new Set() };
  }

  /** 本场景录到的不同请求数（行字段 `requests`）。 */
  get count(): number {
    return this.scene?.seen.size ?? 0;
  }

  wrap(translator: Any): Any {
    const wrapped = Object.create(translator);
    wrapped.translate = async (request: Any) => {
      const shader = compiling.getStore();
      const result = await translator.translate(request);
      if (result.phase !== "include") await this.record(request, result, shader);
      return result;
    };
    return wrapped;
  }

  private async record(request: Any, result: Any, shader: string | undefined) {
    const scene = this.scene!;
    const normalized = canonical(JSON.parse(JSON.stringify(request)));
    const sha = createHash("sha1").update(JSON.stringify(normalized)).digest("hex");
    scene.seen.add(sha);
    let name = shader;
    if (name === undefined) {
      const index = await (scene.index ??= scene.build());
      const vertex = index.get(`v\0${request.vertex}`) ?? [];
      const fragment = index.get(`f\0${request.fragment}`) ?? [];
      name = fragment.find((n) => vertex.includes(n)) ?? "?";
    }
    let entry = this.entries.get(sha);
    if (!entry) {
      entry = {
        names: new Set(),
        scenes: new Set(),
        result: {
          ok: !!result.ok,
          phase: result.phase ?? null,
          // 同产品 `shader:<名>:<阶段>:<细节>` 的取法（requires → missing → 首条错误），不截断
          firstError: result.requires?.[0] ?? result.missing?.[0] ?? result.errors?.[0]?.message ?? null,
        },
        request: normalized,
      };
      this.entries.set(sha, entry);
    }
    entry.names.add(name);
    entry.scenes.add(scene.sample);
  }

  /**
   * 写 `<目录>/<sha1>.json`：`{ name, names, scenes, result, request }`。`names` 排好序，`name` 是它的第一个（导出键与报告按它）。
   */
  write() {
    mkdirSync(this.dir, { recursive: true });
    for (const [sha, entry] of [...this.entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const names = [...entry.names].sort();
      const out = {
        name: names[0],
        names,
        scenes: [...entry.scenes].sort(),
        result: entry.result,
        request: entry.request,
      };
      writeFileSync(join(this.dir, `${sha}.json`), JSON.stringify(out, null, 1));
    }
  }
}

interface PluginContext {
  dir: string;
  bundle: Any;
  fs: Any;
  mod: Record<string, Any>;
  translator: Any;
  recorder: RequestRecorder | null;
}

/** 每个插件：往行里写附加字段。插件内部出错不吞，整行记 error（同旧脚本的 try 范围）。 */
const PLUGINS: Record<string, (ctx: PluginContext, args: string[], row: Json) => Promise<void>> = {
  async modules(ctx, rawArgs, row) {
    // key=<字段名>：写到这个行字段（缺省 modules），同一次扫描里可以挂多套名单
    const key = rawArgs.find((a) => a.startsWith("key="))?.slice(4) || "modules";
    const args = rawArgs.filter((a) => !a.startsWith("key="));
    const wanted = new Set(args.flatMap((a) => (a.startsWith("@") ? (MODULE_PRESETS[a.slice(1)] ?? []) : [a])));
    for (const a of args)
      if (a.startsWith("@") && !MODULE_PRESETS[a.slice(1)]) throw new Error(`modules：没有预置名单 ${a}`);
    const modules: unknown[] = [];
    for (const layer of ctx.bundle.layers) {
      if (!layer.particle) continue;
      const text = await ctx.fs.text(layer.particle.file);
      if (!text) continue;
      const json = ctx.mod.parseWpeJson(text) as Json;
      for (const category of ["emitter", "initializer", "operator"]) {
        const list = json[category];
        if (!Array.isArray(list)) continue;
        for (const entry of list as Json[]) {
          if (!entry || !wanted.has(`${category}:${entry.name}`)) continue;
          const { id: _id, ...fields } = entry;
          modules.push({ file: layer.particle.file, category, ...fields });
        }
      }
    }
    row[key] = modules;
  },

  async controlpoints(ctx, args, row) {
    const renderer = !args.includes("norenderer");
    const systems: unknown[] = [];
    for (const layer of ctx.bundle.layers) {
      if (!layer.particle) continue;
      const text = await ctx.fs.text(layer.particle.file);
      if (!text) continue;
      const json = ctx.mod.parseWpeJson(text) as Json;
      const modules: unknown[] = [];
      for (const category of ["emitter", "initializer", "operator"]) {
        const list = json[category];
        if (!Array.isArray(list)) continue;
        for (const entry of list as Json[]) {
          if (!entry || typeof entry !== "object") continue;
          if (!("controlpoint" in entry) && !CP_MODULES.has(`${category}:${entry.name}`)) continue;
          modules.push({ category, name: entry.name, controlpoint: entry.controlpoint ?? null });
        }
      }
      const instance = layer.particle.instance as { controlpoints: unknown[]; controlpointAngles: unknown[] };
      const io: Json = {};
      instance.controlpoints.forEach((v, i) => v && (io[`controlpoint${i}`] = v));
      instance.controlpointAngles.forEach((v, i) => v && (io[`controlpointangle${i}`] = v));
      const system: Json = {
        file: layer.particle.file,
        flags: json.flags ?? null,
        controlpoint: json.controlpoint ?? null,
      };
      if (renderer) system.renderer = json.renderer ?? null;
      system.modules = modules;
      system.io = io;
      systems.push(system);
    }
    row.systems = systems;
  },

  async sheets(ctx, _args, row) {
    const bundle = ctx.bundle;
    const usages = new Set<string>();
    const note = (where: string, textures: Record<number, number>) => {
      for (const [slot, index] of Object.entries(textures))
        if (bundle.textures[index].flags & 4)
          usages.add(`${where === "particle" ? `particle-slot${slot}` : where}:${bundle.textures[index].path}`);
    };
    for (const layer of bundle.layers) {
      for (const pass of layer.passes) note("image", pass.textures);
      for (const effect of layer.effects)
        for (const step of effect.steps) if (step.kind === "draw") note("effect", step.pass.textures);
      if (layer.passthrough) note("passthrough", layer.passthrough.textures);
      for (const pass of layer.particle?.passes ?? []) note("particle", pass.textures);
    }
    row.animatedUsages = [...usages].sort();
    const sheetDefines = ctx.mod.bundle.particleSheetDefines;
    if (!sheetDefines) return;
    const tex0 = ctx.mod.bundle.particleWritesTex0Format as (format: number) => boolean;
    const { parseWpeJson, parseMaterial } = ctx.mod.model;
    const { ShaderCompiler } = ctx.mod.shader;
    const { engineDefines } = ctx.mod.lights;
    const { checkParticleProgram, checkProgramFeatures, PARTICLE_UNIFORMS } = ctx.mod.features;
    const sheets: unknown[] = [];
    for (const layer of bundle.layers) {
      const particle = layer.particle;
      const pass = particle?.passes[0];
      const slot0 = pass?.textures[0];
      const texture = slot0 === undefined ? undefined : bundle.textures[slot0];
      if (!particle || !pass || !texture?.sheet) continue;
      const json = parseWpeJson((await ctx.fs.text(particle.file))!) as Json;
      const materialPath = String(json.material);
      const material = parseMaterial((await ctx.fs.text(materialPath))!).passes[0];
      const shaderName = String(material.shader);
      const shaderFile = await ctx.fs.read(`shaders/${shaderName}.vert`);
      const system = { flags: particle.flags, animationMode: particle.animationMode };
      const defines: Record<string, string> = {
        ...sheetDefines(texture.sheet, system),
        ...(tex0 && tex0(texture.format) ? { TEX0FORMAT: String(texture.format) } : {}),
      };
      const formats = [
        ...Object.entries(pass.textures).map(([slot, index]) => ({
          slot: Number(slot),
          format: bundle.textures[index as number].format,
        })),
        ...Object.keys(pass.runtime).map((slot) => ({ slot: Number(slot), format: 0 })),
      ];
      const issues = new Set<string>();
      const shader = new ShaderCompiler(
        ctx.fs,
        ctx.translator,
        issues,
        {},
        engineDefines(bundle.general.postprocess.hdr, particle.orthographic),
      );
      const result = await shader.compile(shaderName, material.combos ?? {}, formats, null, issues, defines);
      if (result?.ok) {
        checkParticleProgram(material, result, issues);
        checkProgramFeatures(result, issues, PARTICLE_UNIFORMS);
      }
      sheets.push({
        object: layer.object,
        name: layer.name,
        file: particle.file,
        material: materialPath,
        shader: shaderName,
        shaderSource: shaderFile?.source ?? null,
        texture: texture.path,
        textureSource: texture.source,
        format: texture.format,
        size: [texture.textureWidth, texture.textureHeight, texture.width, texture.height],
        frames: texture.sheet.renderVar1[2],
        renderVar1: texture.sheet.renderVar1,
        npot: texture.sheet.npot,
        flags: particle.flags,
        animationMode: particle.animationMode,
        sequenceMultiplier: particle.sequenceMultiplier,
        defines,
        translated: !!result?.ok,
        program: pass.program !== null,
        hasThickAttribute: !!result?.attributes?.some((a: { name: string }) => a.name === "a_TexCoordVec4C1"),
        issues: [...issues].sort(),
      });
    }
    row.sheets = sheets;
  },

  async requests(ctx, _args, row) {
    // 记录在编译时已做完（见 RequestRecorder），这里只写计数
    row.requests = ctx.recorder?.count ?? 0;
  },
};

it("kbp corpus scan", async () => {
  if (!OUT) throw new Error("KBP_CORPUS_OUT 没给");
  for (const extra of EXTRAS) if (!PLUGINS[extra.name]) throw new Error(`没有附加字段插件 ${extra.name}`);
  vi.doMock(`${SRC}/fileUrl`, () => ({ fileToUrl: (file: string) => file }));
  const bundleModule = await import(`${SRC}/compile/bundle`);
  const { compileScene } = bundleModule;
  const { SceneFs } = await import(`${SRC}/compile/fs`);
  const model = await import(`${SRC}/compile/model`);
  const { Wpesl2wgsl } = await import(`${SRC}/wpesl2wgsl/index`);
  const translator = await Wpesl2wgsl.fromBytes(readFileSync(WASM));
  // sheets 插件另要的模块（只在用到时导入，老源码里可能没有）
  const mod: Record<string, Any> = { bundle: bundleModule, model, parseWpeJson: model.parseWpeJson };
  if (EXTRAS.some((e) => e.name === "sheets") && bundleModule.particleSheetDefines) {
    mod.shader = await import(`${SRC}/compile/shader`);
    mod.lights = await import(`${SRC}/compile/lights`);
    mod.features = await import(`${SRC}/compile/features`);
  }
  // requests 插件：编译管线拿包过一层的翻译器，其余插件仍用原翻译器（它们自己的翻译不录）
  const requestsExtra = EXTRAS.find((e) => e.name === "requests");
  if (requestsExtra && !requestsExtra.args[0]) throw new Error("requests 要给目录：requests:<目录>");
  const recorder = requestsExtra ? new RequestRecorder(requestsExtra.args[0]) : null;
  recorder?.attach((await import(`${SRC}/compile/shader`)).ShaderCompiler);
  const compileTranslator = recorder ? recorder.wrap(translator) : translator;
  const rows: unknown[] = [];
  for (const [sample, dir] of listProjects()) {
    if (ONLY && !ONLY.includes(sample)) continue;
    recorder?.begin(sample, dir);
    try {
      const bundle = await compileScene({
        projectDir: dir,
        sceneAssets: [ASSETS],
        reader: nodeReader,
        translator: compileTranslator,
        postprocess: "ultra",
        exhaustive: true,
      });
      const row: Json = { sample, unsupported: [...bundle.unsupported].sort() };
      const fs = new SceneFs(dir, [ASSETS], nodeReader);
      for (const extra of EXTRAS)
        await PLUGINS[extra.name]({ dir, bundle, fs, mod, translator, recorder }, extra.args, row);
      rows.push(row);
    } catch (error) {
      rows.push({ sample, error: String(error) });
    }
  }
  recorder?.write();
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(rows, null, 1));
  console.log("done", rows.length, "→", OUT);
}, 3_600_000);
