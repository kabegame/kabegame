// kbp corners offline 的比较一半（点 7）：在 Deno 的 WebGPU 上跑 corners.test.ts 备好的计算着色器，读回四角 / 整条带子，
// 和 WPE 的 gs_out 比（收 ignore/p4/c5/corners-offline.ts 与 ignore/p4/d1/corners-offline.ts）。
// 运行：deno run --unstable-webgpu --allow-read --allow-write corners.ts <输出目录> [选项 JSON]
//   选项：{ skip: [系统名], expectHidden: ["<标签或工程>/<系统>"], limit: 像素限值（缺省 0.01）, uniformLimit: 1e-6 }
// 结果写 <输出目录>/corners.txt 与 corners-result.json；退出码 0（比完）或 2（出错）。超限、「画不画」不符、uniform 超限
// 的处数在 corners-result.json 的 failures 里，由 kbp.py 判定。
//
// - points（c5）：我们的 4 个角按 uv 对上 WPE gs_out（三角形列表，按 uv 去重成 4 角）；位置差按窗口像素（裁剪坐标 / w 后 × 宽高 / 2）。
//   「不画」：我们整次跳过（朝向 NaN）或一个顶点也没写 ⇔ WPE 四角全是 NaN；给了 expectHidden 时还要在名单里（同 c5 的 NOT_DRAWN）。
// - draws（d1 的绳）：gs_out 是三角形列表：带上 4 + 2·sub 个顶点 → 2 + 2·sub 个三角形，奇数号写成 (v1, v3, v2)；还原成带后逐顶点比
//   位置（场景像素）、uv、颜色。WPE 一段里有 NaN 顶点 ⇔ 我们这一段每个顶点都是 (2, 2, 2, 1)（翻译器的「整段放到裁剪体外」）。
//   另把备料时比好的 uniform 差（WPE 读到的常量）汇总，超过 uniformLimit 算不符。
const OUT = Deno.args[0];
if (!OUT) throw new Error("要给输出目录");
const options = JSON.parse(Deno.args[1] ?? "{}");
const LIMIT_PIXELS: number = options.limit ?? 0.01;
const UNIFORM_LIMIT: number = options.uniformLimit ?? 1e-6;
const SKIP = new Set<string>(options.skip ?? []);
const EXPECT_HIDDEN: Set<string> | null = options.expectHidden ? new Set(options.expectHidden) : null;
const { projects, uniformChecks, cases } = JSON.parse(await Deno.readTextFile(`${OUT}/offline.json`));
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) throw new Error("没有 WebGPU adapter");
const device = await adapter.requestDevice();
const COMPUTE = 4;
/** 我们的 4 个角（顶点顺序，`CORNER_UVS`）。 */
const UVS = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

interface Entry {
  binding: number;
  buffer?: unknown;
  texture?: unknown;
  sampler?: unknown;
}

async function run(
  item: { wgsl: string; uniform: string; vertex: string; entries: Entry[] },
  vertices: number,
  values: number,
) {
  const code = await Deno.readTextFile(item.wgsl);
  const uniform = await Deno.readFile(item.uniform);
  const vertex = await Deno.readFile(item.vertex);
  device.pushErrorScope("validation");
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === "error");
  if (errors.length)
    throw new Error(`${item.wgsl}: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("；")}`);
  const group0 = device.createBindGroupLayout({
    entries: item.entries.map((entry) => ({ ...entry, visibility: COMPUTE })) as GPUBindGroupLayoutEntry[],
  });
  const group1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: COMPUTE, buffer: { type: "storage" } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [group0, group1] }),
    compute: { module, entryPoint: "kb_corner_main" },
  });
  const make = (data: Uint8Array<ArrayBuffer>, usage: number) => {
    const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const bytes = Math.max(16, vertices * values * 16);
  const uniformBuffer = make(uniform, GPUBufferUsage.UNIFORM);
  const input = make(vertex, GPUBufferUsage.STORAGE);
  const output = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const texture = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING });
  const sampler = device.createSampler();
  const entries0 = item.entries.map((entry) =>
    entry.buffer
      ? { binding: entry.binding, resource: { buffer: uniformBuffer } }
      : entry.texture
        ? { binding: entry.binding, resource: texture.createView() }
        : { binding: entry.binding, resource: sampler },
  );
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, device.createBindGroup({ layout: group0, entries: entries0 }));
  pass.setBindGroup(
    1,
    device.createBindGroup({
      layout: group1,
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
      ],
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(vertices / 64));
  pass.end();
  encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
  const error = await device.popErrorScope();
  if (error) throw new Error(`${item.wgsl}: ${error.message}`);
  await readback.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(readback.getMappedRange().slice(0));
  readback.unmap();
  for (const buffer of [uniformBuffer, input, output, readback]) buffer.destroy();
  texture.destroy();
  return out;
}

/** gs_out（三角形列表）的第 k 段还原成带：`per` 个顶点。 */
function strip<T>(rows: T[], k: number, per: number): T[] {
  const tris = per - 2;
  const base = 3 * tris * k;
  const out = [rows[base], rows[base + 1]];
  for (let t = 0; t < tris; t++) out.push(rows[base + 3 * t + (t % 2 === 0 ? 2 : 1)]);
  return out;
}
const isNaNRow = (row: (number | null)[]) => row.some((v) => v === null || Number.isNaN(v as number));

const lines: string[] = [];
let failures = 0;
const failed: string[] = [];
const fail = (line: string) => {
  failures++;
  failed.push(line);
};
for (const project of projects)
  lines.push(
    `编译 ${project.tag}（${project.project}，${project.mode}）的不支持项：${JSON.stringify(project.unsupported)}`,
  );
lines.push("");

interface Worst {
  kind: string;
  frames: number;
  clip: number;
  pixel: number;
  uv: number;
  color: number;
  segments: number;
  nan: number;
}
const worst = new Map<string, Worst>();
const worstOf = (key: string, kind: string) => {
  const entry = worst.get(key) ?? { kind, frames: 0, clip: 0, pixel: 0, uv: 0, color: 0, segments: 0, nan: 0 };
  worst.set(key, entry);
  return entry;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const item of cases as any[]) {
  const key = `${item.tag}/${item.system}`;
  if (SKIP.has(item.system)) continue;
  if (item.kind === "points") {
    const rows: [number[], (number | null)[]][] = item.wpe?.rows ?? [];
    const wpeNaN = rows.length > 0 && rows.every(([, pos]) => pos.every((v) => v === null));
    const drawn = !item.hidden && item.count > 0;
    const listed = EXPECT_HIDDEN ? EXPECT_HIDDEN.has(key) || EXPECT_HIDDEN.has(`${item.project}/${item.system}`) : null;
    if (listed || !drawn || wpeNaN) {
      const ok = !drawn && wpeNaN && (listed ?? true);
      const line = `${key} 帧 ${item.frame}：我们${item.hidden ? "整次绘制跳过（朝向 NaN）" : drawn ? "画" : `不写顶点（写了 ${item.count} / ${item.particles} 个）`}；WPE 四角${wpeNaN ? "全是 NaN" : "有值"}${ok ? "" : "  ← 不符"}`;
      lines.push(line);
      if (!ok) fail(line);
      continue;
    }
    const clip = await run(item, item.count * 4, 1);
    const corners = new Map<string, number[]>();
    for (const [uv, pos] of rows) corners.set(`${uv[0]},${uv[1]}`, pos as number[]);
    let clipDiff = 0;
    let pixelDiff = 0;
    const pixel = (v: number[]) => [((v[0] / v[3] + 1) / 2) * item.width, ((1 - v[1] / v[3]) / 2) * item.height];
    const detail: string[] = [];
    UVS.forEach(([u, v], k) => {
      const ours = Array.from(clip.subarray(k * 4, k * 4 + 4));
      const wpe = corners.get(`${u},${v}`);
      if (!wpe) throw new Error(`${key} 帧 ${item.frame}：WPE 没有 uv (${u},${v})`);
      clipDiff = Math.max(clipDiff, ...ours.map((x, j) => Math.abs(x - wpe[j])));
      const [a, b] = [pixel(ours), pixel(wpe)];
      pixelDiff = Math.max(pixelDiff, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
      detail.push(
        `(${u},${v}) 我们 ${a.map((x) => x.toFixed(4)).join(",")} WPE ${b.map((x) => x.toFixed(4)).join(",")}`,
      );
    });
    const over = !(pixelDiff <= LIMIT_PIXELS);
    const line = `${key} 帧 ${item.frame}${item.perspective ? "（透视粒子）" : ""}：裁剪坐标最大差 ${clipDiff.toExponential(2)}，像素最大差 ${pixelDiff.toExponential(2)}${over ? "  ← 超限" : ""}`;
    lines.push(line);
    if (over) {
      fail(line);
      for (const d of detail) lines.push(`    ${d}`);
    }
    const entry = worstOf(key, "points");
    entry.clip = Math.max(entry.clip, clipDiff);
    entry.pixel = Math.max(entry.pixel, pixelDiff);
    entry.frames++;
    continue;
  }
  // ———— draws ————
  const per = item.maxVertices;
  const entry = worstOf(key, "draws");
  entry.frames++;
  if (per !== item.wpeMaxout) {
    const line = `${key} 帧 ${item.frame}：我们每段 ${per} 个顶点，WPE maxout ${item.wpeMaxout}  ← 不符`;
    lines.push(line);
    fail(line);
    continue;
  }
  if (item.wpe.count !== 3 * (per - 2) * item.segments) {
    const line = `${key} 帧 ${item.frame}：WPE gs_out ${item.wpe.count} 个顶点，和 ${item.segments} 段对不上  ← 不符`;
    lines.push(line);
    fail(line);
    continue;
  }
  if (item.hidden) {
    const line = `${key} 帧 ${item.frame}：我们整次跳过（朝向 NaN），WPE 画了  ← 不符`;
    lines.push(line);
    fail(line);
    continue;
  }
  const VALUES = 3;
  const out = await run(item, item.segments * per, VALUES);
  const at = (vertex: number, j: number) =>
    Array.from(out.subarray((vertex * VALUES + j) * 4, (vertex * VALUES + j) * 4 + 4));
  let framePixel = 0;
  for (let k = 0; k < item.segments; k++) {
    entry.segments++;
    const wpePos = strip(item.wpe.position as (number | null)[][], k, per);
    const wpeUv = strip(item.wpe.uv as (number | null)[][], k, per);
    const wpeColor = strip(item.wpe.color as (number | null)[][], k, per);
    const ours = Array.from({ length: per }, (_, v) => at(k * per + v, 0));
    const degenerate = ours.every((p) => p[0] === 2 && p[1] === 2 && p[2] === 2 && p[3] === 1);
    const wpeNaN = wpePos.some(isNaNRow);
    if (wpeNaN || degenerate) {
      entry.nan++;
      if (wpeNaN !== degenerate) {
        const line =
          `${key} 帧 ${item.frame} 段 ${k}：WPE ${wpeNaN ? `有 ${wpePos.filter(isNaNRow).length} 个 NaN 顶点` : "没有 NaN"}，` +
          `我们${degenerate ? "整段在裁剪体外" : "照常输出"}  ← 不符`;
        lines.push(line);
        fail(line);
      }
      continue;
    }
    const detail: string[] = [];
    for (let v = 0; v < per; v++) {
      const p = ours[v];
      const w = wpePos[v] as number[];
      const dx = Math.abs(p[0] / p[3] - w[0] / w[3]) * (item.width / 2);
      const dy = Math.abs(p[1] / p[3] - w[1] / w[3]) * (item.height / 2);
      const pixel = Math.max(dx, dy);
      framePixel = Math.max(framePixel, pixel);
      entry.pixel = Math.max(entry.pixel, pixel);
      const uv = at(k * per + v, 1);
      entry.uv = Math.max(entry.uv, ...[0, 1].map((j) => Math.abs(uv[j] - (wpeUv[v][j] as number))));
      const color = at(k * per + v, 2);
      entry.color = Math.max(entry.color, ...[0, 1, 2, 3].map((j) => Math.abs(color[j] - (wpeColor[v][j] as number))));
      if (!(pixel <= LIMIT_PIXELS))
        detail.push(
          `顶点 ${v} 我们 ${p.map((x) => x.toFixed(6)).join(",")} WPE ${w.map((x) => x.toFixed(6)).join(",")}`,
        );
    }
    if (detail.length) {
      const line = `${key} 帧 ${item.frame} 段 ${k}：超限`;
      lines.push(line);
      fail(line);
      for (const d of detail.slice(0, 4)) lines.push(`    ${d}`);
    }
  }
  lines.push(`${key} 帧 ${item.frame}：${item.segments} 段 × ${per} 顶点，像素最大差 ${framePixel.toExponential(2)}`);
}

// uniform（只有 draws 有）：WPE 读到的常量和我们写的逐项比
const uniformWorst: Record<string, number | null> = {};
for (const check of (uniformChecks ?? []) as { uniformDiff: Record<string, number | null> }[])
  for (const [name, diff] of Object.entries(check.uniformDiff)) {
    const prev = uniformWorst[name];
    uniformWorst[name] = diff === null || prev === null ? null : Math.max(prev ?? 0, diff);
  }
lines.push("");
// 表头措辞：按粒子认同 c5（窗口像素），全是按绘制认同 d1（场景像素）
const allDraws = worst.size > 0 && [...worst.values()].every((e) => e.kind === "draws");
lines.push(
  allDraws
    ? `每个系统的最大差（位置限值 ${LIMIT_PIXELS} 场景像素）：`
    : `每个系统的最大差（限值 ${LIMIT_PIXELS} 像素）：`,
);
let overall = 0;
let uvOverall = 0;
let colorOverall = 0;
for (const [key, e] of worst) {
  overall = Math.max(overall, e.pixel);
  if (e.kind === "points") {
    lines.push(`  ${key}：${e.frames} 帧，裁剪坐标 ${e.clip.toExponential(2)}，像素 ${e.pixel.toExponential(2)}`);
  } else {
    uvOverall = Math.max(uvOverall, e.uv);
    colorOverall = Math.max(colorOverall, e.color);
    lines.push(
      `  ${key}：${e.frames} 帧 ${e.segments} 段（其中 NaN / 整段在裁剪体外 ${e.nan} 段），像素 ${e.pixel.toExponential(2)}，` +
        `uv ${e.uv.toExponential(2)}，颜色 ${e.color.toExponential(2)}`,
    );
  }
}
if (Object.keys(uniformWorst).length) {
  const bad = Object.entries(uniformWorst).filter(([, d]) => d === null || !(d < UNIFORM_LIMIT));
  lines.push(`uniform 和 WPE 读到的常量的最大差（限值 ${UNIFORM_LIMIT}）：${JSON.stringify(uniformWorst)}`);
  for (const [name, d] of bad) fail(`uniform ${name} 差 ${d === null ? "NaN（我们没有）" : d}`);
}
lines.push(
  `比了 ${worst.size} 个系统，像素最大差 ${overall.toExponential(2)}` +
    ([...worst.values()].some((e) => e.kind === "draws")
      ? `，uv ${uvOverall.toExponential(2)}，颜色 ${colorOverall.toExponential(2)}`
      : "") +
    `；不符 ${failures} 处`,
);
console.log(lines.join("\n"));
await Deno.writeTextFile(`${OUT}/corners.txt`, lines.join("\n") + "\n");
await Deno.writeTextFile(
  `${OUT}/corners-result.json`,
  JSON.stringify(
    {
      systems: worst.size,
      pixel: overall,
      uv: uvOverall,
      color: colorOverall,
      failures,
      failed,
      uniform: uniformWorst,
      worst: Object.fromEntries(worst),
    },
    null,
    1,
  ),
);
device.destroy();
