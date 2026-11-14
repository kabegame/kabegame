/**
 * kbp corners offline 的备料（点 7）：收 `ignore/p4/step4|c5|d1/corners-offline.test.ts`。用产品代码编译工程，对每个粒子系统、
 * 抓帧的每一帧，取 WPE 轨迹里的顶点输入，按产品代码算 uniform（`particleUniformValues`，renderer 取编译结果，模型矩阵同
 * `GpuScene.particleModel`）、写顶点、判朝向，备好改写成计算着色器的顶点着色器（`rewriteVertexAsCompute`，同 dev 探针
 * `particleCorners`）与 uniform / 顶点字节，交给 `corners.ts` 在 Deno 的 WebGPU 上跑，和 WPE 的 `gs_out` 比。
 *
 * 两种轨迹形状（`kbp rdc track` 的认法）：
 * - points（每粒子一行，P4c 的 sprite / 拖尾，c5 的写法）：位置、尺寸、旋转、颜色、alpha，拖尾另有 TEXCOORD1 = 速度 xyz + frame；
 *   `writeVertices` 写四角顶点（拖尾带 `trailEye`、退化的不写），`orientationBasis` 为 null 时整次不画；四角和 WPE 轨迹的 `corners` 比。
 * - draws（按绘制原样保存，P4d 的绳，d1 的写法）：WPE 的 vs_in 每段一行按 `ropeVertexLayout` 写成段顶点，几何着色器展开
 *   （`maxVertices`、输出 `v_TexCoord`、`v_Color`），和 `gs_out` 逐顶点比；另把我们算的 uniform 和 WPE 读到的常量逐项比。
 *
 * 参数经环境变量（kbp.py 设）：KBP_SRC、KBP_DATA、KBP_CORNERS_OUT（输出目录）、KBP_CORNERS_TAGS（JSON：[{ tag, project }]，
 * project 是工程目录）、KABEGAME_WPE_ROOT。产物：<out>/offline-*（wgsl、uniform、顶点）与 <out>/offline.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";

const slash = (p: string) => p.replace(/\\/g, "/");
const SRC = slash(path.resolve(process.env.KBP_SRC ?? "apps/wpe-scene/src"));
const DATA = path.resolve(process.env.KBP_DATA ?? "ignore/p4");
const ROOT = process.env.KABEGAME_WPE_ROOT ?? "D:/Applications/Steam/steamapps/common/wallpaper_engine";
const OUT = process.env.KBP_CORNERS_OUT;
const TAGS: { tag: string; project: string }[] = JSON.parse(process.env.KBP_CORNERS_TAGS ?? "[]");
/** 绳：WPE vs_in 的列 → 我们的段布局字段（rea-p4d-rope.md 1.3 的元素代码 1、9、12、15、18、25）。 */
const ROPE_COLUMNS = ["POSITION", "TEXCOORD0", "TEXCOORD1", "TEXCOORD2", "TEXCOORD3", "COLOR"] as const;
const ROPE_FIELDS = ["start", "end", "cp0", "cp1", "endColor", "color"] as const;

const reader = {
  async readWhole(file: string) {
    if (!existsSync(file)) throw new TypeError("Failed to fetch");
    return new Uint8Array(readFileSync(file));
  },
  async readRange(file: string, start: number, end: number) {
    return (await reader.readWhole(file)).slice(start, end);
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
interface TrackParticle {
  pos: number[];
  size: number;
  color: number[];
  alpha: number;
  rot: number[];
  TEXCOORD1?: number[];
}
interface RdDraw {
  vs_count: number;
  vs_in: Record<string, number[][]>;
  consts: { vertex: Record<string, number[]>; geometry: Record<string, number[]> };
  maxout: number;
  gs_out: { count: number; columns: Record<string, (number | null)[][]> };
}
interface Frame {
  frame: number;
  systems: Record<string, TrackParticle[] | RdDraw>;
  corners?: Record<string, { stage: string; rows: [number[], (number | null)[]][] } | null>;
}

/** 轨迹 JSON 里有 NaN（四角、gs_out），按 null 读。 */
const readTrack = (file: string): { project?: string; frames: Frame[] } =>
  JSON.parse(readFileSync(file, "utf8").replace(/\bNaN\b/g, "null"));

it("kbp corners offline（备料）", async () => {
  if (!OUT) throw new Error("KBP_CORNERS_OUT 没给");
  if (!TAGS.length) throw new Error("KBP_CORNERS_TAGS 为空");
  vi.doMock(`${SRC}/fileUrl`, () => ({ fileToUrl: (file: string) => file }));
  const { compileScene } = await import(`${SRC}/compile/bundle`);
  const { Wpesl2wgsl } = await import(`${SRC}/wpesl2wgsl/index`);
  const programs = await import(`${SRC}/render/programs`);
  const { bindGroupLayoutEntries, WGSL_PRELUDE } = programs;
  const { cornerInputs, rewriteVertexAsCompute } = await import(`${SRC}/dev/particleCorners`);
  const { particleUniformValues, UniformBlock } = await import(`${SRC}/render/uniforms`);
  const { eyePosition, particleViewProjection, sceneViewProjection, worldMatrixOf } = await import(
    `${SRC}/render/layout`
  );
  const { identity } = await import(`${SRC}/render/math`);
  const { SceneState } = await import(`${SRC}/render/state`);
  const { orientationBasis, VIEW_FORWARD, VIEW_UP } = await import(`${SRC}/particles/orientation`);
  const translator = await Wpesl2wgsl.fromBytes(readFileSync(`${SRC}/wpesl2wgsl/wpesl2wgsl.wasm`));
  // 老源码（P4c）只有 vertexPacking(attributes)；P4d 起有 programVertexPacking(result)（几何着色器的输入另算）
  const packingOf = (result: Any) =>
    programs.programVertexPacking
      ? programs.programVertexPacking(result)
      : programs.vertexPacking(result.attributes ?? []);
  mkdirSync(OUT, { recursive: true });
  const cases: unknown[] = [];
  const projects: unknown[] = [];
  const uniformChecks: unknown[] = [];
  const compiled = new Map<string, Any>();
  const systemModule = await import(`${SRC}/particles/system`).catch(() => null);
  const randomModule = await import(`${SRC}/particles/random`).catch(() => null);

  /**
   * 一个粒子层要比的绘制（P4f 步骤 4）：按绘制先序（`ParticleSystem.forEachDrawn`，只建不步进，所以只有 static 子系统）列出系统，每个系统
   * 按 `draws` 每个 renderer 一项（老源码没有 `draws` 时取 `renderer` 与 `passes`，一项）。键：顶层是图层名，子系统按 kbp-meta.json 的
   * `children`（模板路径每层经 `children[i].index` 换成 JSON 条目下标，同 replayLib 的 `childName`）；第 r 个 renderer（r ≥ 1）加 `#<r + 1>`。
   * 老源码（P4e 以前）没有 `forEachDrawn` 时只有顶层，模型矩阵同以前（世界空间是单位阵，本地是对象世界矩阵）。
   */
  const particleDrawsOf = (
    layer: Any,
    state: Any,
    metaChildren: Record<string, string[]>,
  ): { key: string; layer: Any; def: Any; pass: Any; renderer: Any; model: number[] }[] => {
    const world = worldMatrixOf(layer.object, state.layers, new Map());
    const systems: [string, Any, number[]][] = [];
    const ParticleSystem = systemModule?.ParticleSystem;
    if (layer.particle.children?.length && ParticleSystem?.prototype?.forEachDrawn && randomModule) {
      const root = new ParticleSystem(layer.particle, new randomModule.SeededRandom(1), 1);
      root.forEachDrawn((system: Any, template: readonly number[], model: number[]) => {
        let name: string | undefined = layer.name;
        let def = layer.particle;
        for (const index of template) {
          const link = def?.children?.[index];
          name = name === undefined ? undefined : metaChildren[name]?.[link?.index ?? index];
          def = link?.system;
        }
        if (name === undefined)
          throw new Error(`kbp-meta.json 的 children 里找不到 ${layer.name} 的子系统 ${template}`);
        systems.push([name, system.def, model]);
      }, world);
    } else systems.push([layer.name, layer.particle, layer.particle.flags & 1 ? identity() : world]);
    return systems.flatMap(([name, def, model]) =>
      ((def.draws as Any[] | undefined) ?? [{ renderer: def.renderer, passes: def.passes }])
        .filter((draw) => draw.passes?.[0])
        .map((draw, r) => ({
          key: r ? `${name}#${r + 1}` : name,
          layer,
          def,
          pass: draw.passes[0],
          renderer: draw.renderer,
          model,
        })),
    );
  };

  // 同一个工程的标签合成一组：工程 → 图层 → 标签 → 帧（c5 每个工程一个标签；d1 两个 fps 的标签共用 p4d-rope，图层在外）
  const groups = new Map<string, string[]>();
  for (const { tag, project } of TAGS) groups.set(project, [...(groups.get(project) ?? []), tag]);
  for (const [project, tags] of groups) {
    const projectName = project.split(/[\\/]/).filter(Boolean).at(-1)!;
    const bundle = await compileScene({
      projectDir: project,
      sceneAssets: [join(ROOT, "assets")],
      reader,
      translator,
      postprocess: "disabled",
      exhaustive: true,
    });
    const state = SceneState.fromBundle(bundle);
    compiled.set(project, { bundle, state });
    const layers = bundle.layers.filter((layer: { particle: unknown }) => layer.particle);
    const tracks = tags.map((tag) => {
      const frames = readTrack(join(DATA, "tracks", `rd-${tag}.json`)).frames;
      const drawsMode = frames.some((f) => Object.values(f.systems).some((s) => s && !Array.isArray(s)));
      projects.push({
        tag,
        project: projectName,
        mode: drawsMode ? "draws" : "points",
        unsupported: bundle.unsupported,
        layers: layers.map(
          (layer: { name: string; particle: { renderer: unknown; flags: number; draws?: Any[] } }) => ({
            name: layer.name,
            flags: layer.particle.flags,
            renderer: layer.particle.renderer,
            // 多个 renderer（P4f 步骤 4）：各次绘制的种类；老源码没有
            ...(layer.particle.draws ? { draws: layer.particle.draws.map((draw: Any) => draw.renderer.kind) } : {}),
          }),
        ),
      });
      return { tag, frames, drawsMode };
    });
    const metaFile = join(project, "kbp-meta.json");
    const metaChildren: Record<string, string[]> = existsSync(metaFile)
      ? (JSON.parse(readFileSync(metaFile, "utf8")).children ?? {})
      : {};
    // 每个系统的每个 renderer 一项（P4f 步骤 4）：键是轨迹里的名字，第 r 个 renderer（r ≥ 1）是 `名字#<r + 1>`（WPE 同一系统连着画的第
    // r + 1 次绘制）；static 子系统（P4e）按 kbp-meta.json 的 children 取名
    const drawItems = (
      await Promise.all(layers.map((layer: Any) => particleDrawsOf(layer, state, metaChildren)))
    ).flat();
    for (const item of drawItems)
      for (const { tag, frames, drawsMode } of tracks) {
        const particle = item.def;
        const { pass, renderer, key } = item;
        const result = bundle.programs[pass.program];
        if (!frames.some((f) => f.systems[key] !== undefined)) continue;
        const packing = packingOf(result);
        const perspective = (particle.flags & 4) !== 0;
        const slots = Math.max(10, ...(result.textures ?? []).map((t: { slot: number }) => t.slot + 1));
        const textures = Array.from({ length: slots }, (_, slot) =>
          pass.textures[slot] === undefined ? undefined : bundle.textures[pass.textures[slot]],
        );
        // 绘制的模型矩阵：同 GpuScene.particleModel（世界空间系统是单位阵，本地系统是对象世界矩阵，static 子系统沿 forEachDrawn）
        const model = item.model;
        const layer = item.layer;
        const base = pass.textures[0];
        const input: Any = {
          layer: state.layers.get(layer.object),
          world: model,
          constants: state.constants.get(pass.key) ?? {},
          viewProjection: perspective ? particleViewProjection(bundle.general) : sceneViewProjection(bundle.general),
          colorScale: 1,
          screenSize: [bundle.general.width, bundle.general.height],
          textures,
          eye: eyePosition(bundle.general),
          ambient: state.general.ambientcolor,
          skylight: state.general.skylightcolor,
          renderer,
        };
        if (!drawsMode) input.sheet = base === undefined ? undefined : bundle.textures[base]?.sheet;
        const values = particleUniformValues(input);
        const uniformSize = result.uniforms?.length
          ? Math.max(16, Math.ceil((result.uniformBlockSize ?? 0) / 16) * 16)
          : 0;
        const block = new UniformBlock(result.uniforms ?? [], uniformSize);
        for (const [name, v] of Object.entries(values)) block.set(name, v as number[]);
        const tagged = `${tag}-${key.replace(/[^A-Za-z0-9-]/g, "_")}`;
        const wgslFile = join(OUT, `offline-${tagged}.wgsl`);
        const uniformFile = join(OUT, `offline-${tagged}.uniform.bin`);
        writeFileSync(uniformFile, new Uint8Array(block.data));

        if (!drawsMode) {
          // ———— points（c5）————
          const { particleVertexLayout, trailEye, writeVertices } = await import(`${SRC}/particles/vertices`);
          const { ParticleColumns } = await import(`${SRC}/particles/columns`);
          const { layout } = particleVertexLayout(packing);
          writeFileSync(
            wgslFile,
            WGSL_PRELUDE +
              rewriteVertexAsCompute(
                result.vertex.wgsl,
                result.vertex.entryPoint,
                cornerInputs(packing.attributes),
                layout.stride,
              ),
          );
          const hidden = orientationBasis(renderer.orientation, model, VIEW_FORWARD, VIEW_UP) === null;
          const eye = renderer.kind === "spritetrail" ? trailEye(eyePosition(bundle.general), model) : null;
          for (const frame of frames) {
            const track = frame.systems[key] as TrackParticle[] | undefined;
            if (!track?.length) continue;
            // 轨迹的顶点列作输入（几何和模拟分开）
            const columns = new ParticleColumns(track.length, 1 | 8 | 16);
            track.forEach((p, i) => {
              columns.life[i] = 1;
              for (let k = 0; k < 3; k++) {
                columns.position[k][i] = p.pos[k];
                columns.rotation[k][i] = p.rot[k];
                columns.color[k][i] = p.color[k];
                columns.velocity[k][i] = p.TEXCOORD1?.[k] ?? 0;
              }
              columns.size[i] = p.size;
              columns.alpha[i] = p.alpha;
              columns.frame[i] = p.TEXCOORD1?.[3] ?? 0;
            });
            const vertices = new Float32Array(track.length * 4 * layout.stride);
            const count = writeVertices({ columns, highWater: track.length }, layout, vertices, eye);
            const vertexFile = join(OUT, `offline-${tagged}-${frame.frame}.vertex.bin`);
            writeFileSync(vertexFile, new Uint8Array(vertices.buffer, 0, count * 4 * layout.stride * 4));
            cases.push({
              kind: "points",
              tag,
              project: projectName,
              system: key,
              frame: frame.frame,
              perspective,
              trail: renderer.kind === "spritetrail",
              hidden,
              count,
              particles: track.length,
              wgsl: wgslFile,
              uniform: uniformFile,
              vertex: vertexFile,
              entries: bindGroupLayoutEntries(result, 4),
              width: bundle.general.width,
              height: bundle.general.height,
              wpe: frame.corners?.[key] ?? null,
              renderVar0: values.g_RenderVar0,
              orientation: [values.g_OrientationRight, values.g_OrientationUp, values.g_OrientationForward],
            });
          }
          continue;
        }

        // ———— draws（d1 的绳）————
        if (!result.geometry) throw new Error(`${tag}/${key}：按绘制认的轨迹，但程序没有几何着色器（不是绳？）`);
        const { ropeVertexLayout } = await import(`${SRC}/particles/rope`);
        const maxVertices = result.geometry.maxVertices;
        const { layout, problems } = ropeVertexLayout(packing);
        if (problems?.length) throw new Error(`${tag}/${key}：ropeVertexLayout ${JSON.stringify(problems)}`);
        writeFileSync(
          wgslFile,
          WGSL_PRELUDE +
            rewriteVertexAsCompute(
              result.vertex.wgsl,
              result.vertex.entryPoint,
              cornerInputs(packing.attributes),
              layout.stride,
              {
                maxVertices,
                outputs: ["v_TexCoord", "v_Color"],
              },
            ),
        );
        // 同 GpuScene.refreshParticleGeometry：rope 的 screen 朝向不跳过，其余朝向是 NaN 时整次跳过
        const hidden =
          renderer.orientation.mode === 0
            ? false
            : orientationBasis(renderer.orientation, model, VIEW_FORWARD, VIEW_UP) === null;
        for (const frame of frames) {
          const draw = frame.systems[key] as RdDraw | undefined;
          if (!draw) continue;
          // WPE 读到的常量（顶点、几何两个阶段）和我们写的 uniform 逐项比
          const consts = { ...draw.consts.vertex, ...draw.consts.geometry };
          const uniformDiff: Record<string, number | null> = {};
          for (const [name, wpe] of Object.entries(consts)) {
            const ours = values[name] as number[] | undefined;
            const d = ours ? Math.max(...wpe.map((v, i) => Math.abs(v - (ours[i] ?? NaN)))) : NaN;
            uniformDiff[name] = Number.isNaN(d) ? null : d;
          }
          uniformChecks.push({ tag, system: key, frame: frame.frame, uniformDiff });
          const segments = draw.vs_count;
          const vertices = new Float32Array(segments * layout.stride);
          for (let k = 0; k < segments; k++)
            ROPE_COLUMNS.forEach((column, c) => {
              const offset = layout[ROPE_FIELDS[c]];
              for (let j = 0; j < 4; j++) vertices[k * layout.stride + offset + j] = draw.vs_in[column][k][j];
            });
          const vertexFile = join(OUT, `offline-${tagged}-${frame.frame}.vertex.bin`);
          writeFileSync(vertexFile, new Uint8Array(vertices.buffer));
          cases.push({
            kind: "draws",
            tag,
            project: projectName,
            system: key,
            frame: frame.frame,
            hidden,
            segments,
            maxVertices,
            wpeMaxout: draw.maxout,
            wgsl: wgslFile,
            uniform: uniformFile,
            vertex: vertexFile,
            entries: bindGroupLayoutEntries(result, 4),
            width: bundle.general.width,
            height: bundle.general.height,
            wpe: {
              count: draw.gs_out.count,
              position: draw.gs_out.columns.SV_POSITION,
              uv: draw.gs_out.columns.TEXCOORD0,
              color: draw.gs_out.columns.TEXCOORD1,
            },
          });
        }
      }
  }
  writeFileSync(join(OUT, "offline.json"), JSON.stringify({ projects, uniformChecks, cases }, null, 1));
  console.log(`备好 ${cases.length} 组`);
}, 600_000);
