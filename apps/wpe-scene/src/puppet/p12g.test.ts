/**
 * P12g：puppet 骨骼的局部读写（`getLocalBone*` / `setLocalBone*`）按 WPE 实测的逐帧回放（`p12g-local`、`p12g-args` 两个生成工程）。
 *
 * 夹具 `fixtures/p12g-local.json`（生成脚本 `ignore/p12/g/fix/mkfix_g.py`，工程与脚本原文 `ignore/p12/g/defs/p12g.py`，实测报告 `ignore/p12/g/meas/REPORT.md`）：
 * 每个 puppet 的 mdl、origin、`animationlayers`，WPE 日志的逐帧 dt（第 k 帧在下标 k − 1），脚本日志（`[kbp] p12g <名> ` 之后的原文），抓帧的 `g_Bones`
 * （键是帧号，= rdc 帧号 + 1，每骨骼 12 个 float）。
 *
 * 做法：一个工程的全部 puppet 建在同一个 `ScenePuppets` 里，第 k 帧 `frame(dt[k − 1], sink, hooks)`（推进、事件）之后，按 `p12g.py` 里各 puppet 的脚本逻辑
 * 调 `ScenePuppets` 的方法（等价于脚本阶段）。`sink.world` 是 T(origin)，origin 可被脚本改（la 在第 18 / 19 帧），写入现取调用时刻的值。
 * 比对两样：脚本日志的读回值（`String(f32)` 逐字）与抓帧 `g_Bones`（按位）。
 *
 * 不移植 WPE 的 `Mat4.rotate / translate / scale`：le1 / le3 的写入值取日志里记下的 after 矩阵，只在有日志的帧写（le1 前 30 帧、le3 的写入帧）；
 * 它们和 lr（照 3820240793 的脚本）的整段 `g_Bones` 由 dev 真 GPU 路径对照。只有 `Angles` 的三角函数允许 1 ulp（本文件里没有用到，见 localBones.test.ts）。
 */
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseMdl } from "../compile/mdl";
import { buildPuppet } from "../compile/puppet";
import fixture from "./fixtures/p12g-local.json";
import { ScenePuppets, type PuppetHooks, type PuppetSink } from "./player";

interface FixturePuppet {
  name: string;
  object: number;
  origin: string;
  mdl: string;
  layers: unknown[] | null;
}
interface Section {
  puppets: FixturePuppet[];
  dt: number[];
  logs: Record<string, string[]>;
  bones: Record<string, Record<string, number[]>>;
}
const root = fixture as unknown as { local: Section; args: Section };

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const f = Math.fround;
const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

/** `String(f32)` 逐个、空格连接（脚本里的 `M()` / `V()`）。 */
const join = (values: ArrayLike<number>): string => Array.from(values, String).join(" ");
/** 日志里的矩阵串 → float32 数组。 */
const parse = (text: string): Float32Array => Float32Array.from(text.split(" ").map(Number));

/** 一个工程的回放现场。 */
function build(section: Section) {
  const list = section.puppets.map((item) => {
    const { puppet, issues } = buildPuppet(parseMdl(mdlBytes(item.mdl)), item.layers ?? [], "p");
    expect([...issues], item.name).toEqual([]);
    return { object: item.object, puppet: puppet! };
  });
  const puppets = new ScenePuppets(list);
  const origins = new Map(section.puppets.map((item) => [item.object, item.origin.split(" ").map(Number)]));
  // 图层世界矩阵 = T(origin)（scale 1、angles 0、alignment 缺省 center）；每次现算，脚本改 origin 后下一次调用就看到
  const sink: PuppetSink = {
    animationLayer: () => undefined,
    world: (object) => {
      const o = origins.get(object)!;
      return Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, o[0], o[1], o[2], 1]);
    },
  };
  const object = (name: string) => section.puppets.find((item) => item.name === name)!.object;
  return { puppets, sink, origins, object };
}
type Rig = ReturnType<typeof build>;

/** 脚本里常用的读法（失败时的单位阵 / 零向量同 API）。 */
function view(rig: Rig, name: string) {
  const { puppets } = rig;
  const object = rig.object(name);
  return {
    object,
    local: (bone: number | string) => puppets.localBoneTransform(object, bone) ?? IDENTITY,
    angles: (bone: number | string) => puppets.localBoneAngles(object, bone) ?? [0, 0, 0],
    origin: (bone: number | string) => puppets.localBoneOrigin(object, bone) ?? [0, 0, 0],
    world: (bone: number | string) => puppets.boneTransform(object, bone) ?? IDENTITY,
    /** `getBoneTransform(i).translation()` 的 `V()`。 */
    wt: (bone: number | string) => join((puppets.boneTransform(object, bone) ?? IDENTITY).slice(12, 15)),
    setMat: (bone: number | string, m: ArrayLike<number>) => puppets.setLocalBoneTransform(object, bone, m),
    setAng: (bone: number | string, v: [number, number, number]) => puppets.setLocalBoneAngles(object, bone, v),
    setOrg: (bone: number | string, v: [number, number, number]) => puppets.setLocalBoneOrigin(object, bone, v),
  };
}
type View = ReturnType<typeof view>;

/** 回放：每帧 `frame()` 之后调 `scripts(k)`；抓帧的帧记下每个 puppet 的 `skin`。 */
function replay(section: Section, rig: Rig, scripts: (k: number) => void, hooks?: PuppetHooks) {
  const wanted = new Set(Object.keys(section.bones).map(Number));
  const skins = new Map<number, Map<number, Float32Array>>();
  for (let k = 1; k <= section.dt.length; k++) {
    rig.puppets.frame(section.dt[k - 1], rig.sink, hooks);
    scripts(k);
    if (wanted.has(k)) {
      const frame = new Map<number, Float32Array>();
      for (const item of section.puppets) {
        const skin = rig.puppets.skin(item.object);
        if (skin) frame.set(item.object, Float32Array.from(skin));
      }
      skins.set(k, frame);
    }
  }
  return skins;
}

/** 一个 puppet 的 `g_Bones` 与 WPE 抓帧比：返回不逐位相同的 (帧, 骨骼分量下标, 我们, WPE)。 */
function boneDiffs(section: Section, skins: Map<number, Map<number, Float32Array>>, names: string[], tolerance = 0) {
  const diffs: { name: string; frame: number; index: number; ours: number; wpe: number }[] = [];
  const compared: Record<string, number> = {};
  for (const [frameText, perPuppet] of Object.entries(section.bones)) {
    const frame = Number(frameText);
    for (const [name, want] of Object.entries(perPuppet)) {
      if (!names.includes(name)) continue;
      const object = section.puppets.find((item) => item.name === name)!.object;
      const ours = skins.get(frame)!.get(object)!;
      expect(ours.length, `${name} 帧 ${frame}`).toBeGreaterThanOrEqual(want.length);
      compared[name] = (compared[name] ?? 0) + 1;
      for (let i = 0; i < want.length; i++)
        if (Math.abs(ours[i] - f(want[i])) > tolerance)
          diffs.push({ name, frame, index: i, ours: ours[i], wpe: f(want[i]) });
    }
  }
  return { diffs, compared };
}

const ulps = (a: number, b: number): number => {
  const buf = new Float32Array(2);
  const ints = new Int32Array(buf.buffer);
  buf[0] = a;
  buf[1] = b;
  return Math.abs(ints[0] - ints[1]);
};

// —— la：读回、写入、先后、W（第 2–25 帧每帧一件事） ——

function laScripts(rig: Rig, lines: string[]): (k: number) => void {
  const a = view(rig, "la");
  const logAll = (tag: string) =>
    lines.push(
      `${tag},local,${[0, 1, 2, 3].map((i) => join(a.local(i))).join(";")},world,${[0, 1, 2, 3].map((i) => a.wt(i)).join(";")}`,
    );
  const moved = (i: number, dx: number): Float32Array => {
    const m = Float32Array.from(a.world(i));
    m[12] = m[12] + dx;
    return m;
  };
  const move = (dx: number) => {
    const o = rig.origins.get(a.object)!;
    o[0] += dx;
  };
  const tests: Record<number, () => void> = {
    2: () => {
      a.setOrg(0, [10, 20, 30]);
      logAll("t2");
      lines.push(`t2,w2,${join(a.world(2))}`);
    },
    3: () => logAll("t3"),
    4: () => {
      a.setAng(0, [0, 0, f(1.5707964)]);
      lines.push(`t4,${join(a.local(0))}`);
    },
    5: () => {
      a.setAng(0, [f(0.3), f(0.4), f(0.5)]);
      lines.push(`t5,${join(a.local(0))},ang,${join(a.angles(0))}`);
    },
    6: () => {
      a.setAng(0, [0, 2, 0]);
      lines.push(`t6,${join(a.local(0))},ang,${join(a.angles(0))}`);
    },
    7: () => {
      lines.push(`t7,ang1,${join(a.angles(1))}`);
      const c = Math.cos(0.5);
      const s = Math.sin(0.5);
      a.setMat(1, Float32Array.from([1, 0, 0, 0, 0, 2 * c, 2 * s, 0, 0, -s, c, 0, 100, 0, 0, 1]));
      lines.push(`t7,set,${join(a.local(1))},ang,${join(a.angles(1))}`);
    },
    8: () => {
      a.setAng(1, [f(0.5), 0, 0]);
      lines.push(`t8,${join(a.local(1))}`);
      logAll("t8");
    },
    9: () => {
      a.setOrg(1, [11, 22, 33]);
      lines.push(`t9,${join(a.local(1))}`);
    },
    // 缺参写入（API 层把缺省换成单位阵 / (0, 0, 0)，见 p12gBonesApi.test.ts）：这里直接给换好的值
    10: () => {
      a.setMat(0, IDENTITY);
      lines.push(`t10,${join(a.local(0))}`);
    },
    11: () => {
      a.setMat(0, IDENTITY);
      lines.push(`t11,${join(a.local(0))}`);
    },
    12: () => {
      a.setAng(0, [0, 0, 0]);
      lines.push(`t12,${join(a.local(0))}`);
    },
    13: () => {
      a.setOrg(0, [0, 0, 0]);
      lines.push(`t13,${join(a.local(0))}`);
    },
    // 选骨失败的写（空串、1.5、越界、−1、大小写不对、数字字符串；true / null 在 API 里规整成空串）：什么都不做
    14: () => {
      const m = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 500, 500, 0, 1]);
      for (const key of ["", 1.5, 99, -1, "B0", "0", "", ""]) a.setMat(key, m);
      logAll("t14");
    },
    15: () => {
      a.setMat("b0", Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]));
      logAll("t15");
    },
    16: () => {
      rig.puppets.setBoneTransform(a.object, 1, moved(1, 50));
      a.setMat(2, a.local(2));
      logAll("t16");
    },
    17: () => {
      a.setMat(2, a.local(2));
      rig.puppets.setBoneTransform(a.object, 1, moved(1, 50));
      logAll("t17");
    },
    // 调用时刻的 W：同帧先把图层 origin +100 再写 b1，子树用新 W、子树外的骨骼仍是推进时的
    18: () => {
      move(100);
      a.setMat(1, a.local(1));
      logAll("t18");
    },
    19: () => {
      move(-100);
      logAll("t19");
    },
    20: () => {
      a.setOrg("b1", [0, 50, 0]);
      logAll("t20");
    },
    22: () => {
      a.setOrg(0, [5, 0, 7]);
      lines.push(`t22,${join(a.local(0))}`);
    },
    23: () => {
      a.setMat(0, Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 5, 1]));
      lines.push(`t23,${join(a.local(0))}`);
    },
    24: () => {
      a.setAng(0, [0, 0, f(0.5)]);
      a.setOrg(0, [40, 0, 0]);
      logAll("t24");
    },
    25: () => logAll("t25"),
  };
  return (k) => {
    if (k === 1) {
      logAll("u1");
      for (const key of [99, -1, 1.5, "", "B1", "b1", "1", 4])
        lines.push(`u1,localk,${JSON.stringify(key)},${join(a.local(key))}`);
      for (const i of [0, 1, 2, 3]) lines.push(`u1,ang,${i},${join(a.angles(i))},org,${join(a.origin(i))}`);
      lines.push(`u1,ang,b1name,${join(a.angles("b1"))},orgk99,${join(a.origin(99))},angk,${join(a.angles(""))}`);
    }
    tests[k]?.();
  };
}

/** 夹具里能在 `ScenePuppets` 层复现的 la 行（API 层的 init / 非 puppet / 静态 puppet / t21 / 返回 undefined 的行不在这里比）。 */
const LA_SKIP = /^(init,|u1,(nonpup|static),|t21,|t(2|10|11|12|13),r,|t14,(?!local,)|t\d+,done)/;

describe("p12g-local：脚本读写按 WPE 的帧时间回放", () => {
  const section = root.local;
  const rig = build(section);
  const logs: Record<string, string[]> = {
    la: [],
    lb: [],
    le1: [],
    le2: [],
    le3: [],
    le4: [],
    lg: [],
    lf1: [],
    lf2: [],
    lf3: [],
  };
  const wantLogs = section.logs;

  // le4 的事件回调（animationEvent）：before / 写 b0 原点 (200, 0, 0) / 读回
  const le4 = view(rig, "le4");
  let le4n = 0;
  let le4fired = 0;
  const hooks: PuppetHooks = {
    event(object, json) {
      if (object !== le4.object) return;
      const before = join(le4.origin(0));
      le4.setOrg(0, [200, 0, 0]);
      le4fired++;
      logs.le4.push(`ev,${le4n},${JSON.parse(json).name},before,${before},org0,${join(le4.origin(0))},w1,${le4.wt(1)}`);
    },
  };

  // 脚本阶段：各 puppet 的逻辑照 p12g.py
  const la = laScripts(rig, logs.la);
  const lb = view(rig, "lb");
  const lc = view(rig, "lc");
  const le1 = view(rig, "le1");
  const le2 = view(rig, "le2");
  const le3 = view(rig, "le3");
  const lg = view(rig, "lg");
  const lf = ["lf1", "lf2", "lf3"].map((name) => view(rig, name));
  const lcBase = wantLogs.lc[0].slice("base,".length).split(";").map(parse);
  const field = (line: string, index: number) => line.split(",")[index];
  const le1Want = new Map(wantLogs.le1.map((line) => [Number(field(line, 1)), line.split(",")]));
  const le3Write = new Map(
    wantLogs.le3.filter((line) => line.startsWith("w,")).map((line) => [Number(field(line, 1)), line.split(",")]),
  );
  const le2Base = parse(field(wantLogs.le2[0], 2));
  const lfBase: Float32Array[][] = [];

  const scripts = (k: number) => {
    la(k);
    // lb：每 3 帧写 b0 原点 (n % 97 + 1, 0, 0)，3 帧中的第 1 帧读回
    if (k % 3 === 0) {
      lb.setOrg(0, [(k % 97) + 1, 0, 0]);
      logs.lb.push(`w,${k},${(k % 97) + 1},org0,${join(lb.origin(0))},w2,${join(lb.world(2))},wc,${lb.wt(3)}`);
    } else if (k % 3 === 1 && k > 1) logs.lb.push(`r,${k},org0,${join(lb.origin(0))},w2,${join(lb.world(2))}`);
    // lc：每帧把 4 根骨骼的局部矩阵原样写回（基准取自第 1 帧的读回）
    for (let i = 0; i < 4; i++) lc.setMat(i, lcBase[i]);
    // le1：get → rotate 0.1 → set；写入值取日志的 after 矩阵，只在有日志的帧（前 30 帧）
    const row = le1Want.get(k);
    if (row) {
      const before = join(le1.local(1));
      le1.setMat(1, parse(row[3]));
      logs.le1.push(`f,${k},${before},${join(le1.local(1))},${join(le1.local(2))}`);
    }
    // le2：每帧 set(第 1 帧读到的 base)
    const le2Before = join(le2.local(1));
    le2.setMat(1, le2Base);
    if (k <= 30) logs.le2.push(`f,${k},${le2Before},${join(le2.local(2))}`);
    // le3：每 40 帧的第 20 帧写一次（值取日志），19 / 21 帧读回
    const m = k % 40;
    if (m === 19 || m === 21) logs.le3.push(`r,${k},${join(le3.local(1))}`);
    if (m === 20) {
      const before = join(le3.local(1));
      le3.setMat(1, parse(le3Write.get(k)![3]));
      logs.le3.push(`w,${k},${before},${join(le3.local(1))}`);
    }
    // le4 的 update：读回与复位
    le4n = k;
    if (le4fired > 0 || k <= 3) {
      logs.le4.push(`u,${k},fired,${le4fired},org0,${join(le4.origin(0))},w1,${le4.wt(1)}`);
      le4fired = 0;
    }
    // lf1–lf3：每 60 帧对 b2 冲量；lf1 每帧写 b0，lf2 每帧写 c0，lf3 每 90 帧切换写 b0 与不写
    lf.forEach((a, index) => {
      const mode = ["b0", "c0", "toggle"][index];
      if (!lfBase[index]) lfBase[index] = [Float32Array.from(a.local(0)), Float32Array.from(a.local(3))];
      if (k % 60 === 1) rig.puppets.applyBonePhysicsImpulse(a.object, 2, [500, 0, 0], [0, 0, 0]);
      const write = mode === "b0" || (mode === "toggle" && Math.floor(k / 90) % 2 === 0);
      if (write) a.setMat(0, lfBase[index][0]);
      if (mode === "c0") a.setMat(3, lfBase[index][1]);
      if (k <= 400 && k % 10 === 0) logs[`lf${index + 1}`].push(`f,${k},${write},w2,${a.wt(2)}`);
    });
    // lg：每帧摆动 b1 原点
    const swing = 30 * Math.sin(k * 0.1);
    lg.setOrg(1, [f(100 + swing), 0, 0]);
    // 日志里的 swing 是 V8 的双精度 `Math.sin`，末位偶尔和 node 不同（写进去的值取 float32 后相同），所以只比 w1
    if (k <= 30) logs.lg.push(`f,${k},w1,${lg.wt(1)}`);
  };
  const skins = replay(section, rig, scripts, hooks);

  /** 脚本日志按行比：只比夹具里有的行（夹具对长日志裁过）。 */
  const sameLines = (name: string, pick: (line: string) => boolean = () => true) => {
    const want = wantLogs[name].filter(pick);
    const got = logs[name].filter(pick);
    expect(got, name).toEqual(want);
  };

  /** 同 sameLines，数字在容差内（非数字部分逐字相同）。 */
  const close = (name: string, tolerance: number, pick: (line: string) => boolean = () => true) => {
    const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g;
    const want = wantLogs[name].filter(pick);
    const got = logs[name].filter(pick);
    expect(got.length, name).toBe(want.length);
    let worst = 0;
    want.forEach((line, i) => {
      expect(got[i].replace(NUMBER, "#"), `${name} 第 ${i} 行形状`).toBe(line.replace(NUMBER, "#"));
      const a = (got[i].match(NUMBER) ?? []).map(Number);
      const b = (line.match(NUMBER) ?? []).map(Number);
      a.forEach((value, k) => (worst = Math.max(worst, Math.abs(value - b[k]))));
    });
    console.log(`[p12g] ${name} 日志最大数值差 ${worst.toExponential(2)}`);
    expect(worst, name).toBeLessThanOrEqual(tolerance);
  };

  it("la：读回、写入（Transform / Angles / Origin）、选骨失败、先后、调用时刻的 W 逐字相同（t2–t25）", () => {
    const want = wantLogs.la.filter((line) => !LA_SKIP.test(line));
    expect(logs.la).toEqual(want);
    // 不是空比：写入帧的世界矩阵确实被重算（t2 的 b2 平移 413.92…）、t18 的 W 取调用时刻的（b0 仍 200、b1 400）
    expect(want.some((line) => line.includes("413.92303466796875"))).toBe(true);
    expect(want.find((line) => line.startsWith("t18,"))).toContain(
      "world,200 900 0;400 900 0;503.92303466796875 960 0",
    );
  });

  it("lb：每 3 帧写一次 b0 原点，写入帧读回新值、子树当场重算、下一帧复位（逐字相同）", () => {
    const wantRows = wantLogs.lb.filter((line) => Number(field(line, 1)) <= section.dt.length);
    const got = new Map(logs.lb.map((line) => [Number(field(line, 1)), line]));
    expect(wantRows.length).toBeGreaterThan(40);
    for (const line of wantRows) expect(got.get(Number(field(line, 1))), line).toBe(line);
  });

  it("le1：每帧读到的是纯动画值，写入不累积（前 30 帧）；le2 同；le3 写一次后动画接着播（动画值在 1e-6 内）", () => {
    // 动画的局部矩阵来自四元数转矩阵（`rsqrtps` 不复刻，p12-REPORT），个别帧末几位和 WPE 不同；写入 / 复位 / 不累积的判断是数量级的（0.1 弧度）
    close("le1", 1e-6);
    close("le2", 1e-6);
    close("le3", 1e-6, (line) => Number(field(line, 1)) <= section.dt.length);
  });

  it("le4：animationEvent 里写入当帧读回、同帧 update 里已复位（派发在重写局部矩阵之前）", () => {
    sameLines("le4", (line) => Number(field(line, 1)) <= section.dt.length);
    expect(logs.le4.some((line) => line.startsWith("ev,"))).toBe(true);
  });

  it("lf1–lf3：物理骨骼在被写骨骼的子树里时当帧读到的世界矩阵（逐字相同）", () => {
    for (const name of ["lf1", "lf2", "lf3"]) sameLines(name);
  });

  it("lg：每帧摆动 b1，世界矩阵跟着动", () => {
    const want = wantLogs.lg.map((line) => line.replace(/^f,(\d+),[^,]+,/, "f,$1,"));
    expect(logs.lg).toEqual(want);
  });

  it("g_Bones 与 WPE 抓帧逐位相同：la、lb、lc、ld、lg（帧 124–129、525–530；±0 不分）", () => {
    const names = ["la", "lb", "lc", "ld", "lg"];
    const { diffs, compared } = boneDiffs(section, skins, names);
    for (const name of names) expect(compared[name], name).toBe(12);
    expect(diffs).toEqual([]);
  });

  it("g_Bones：动画驱动的 le2 / le3 / le4 与 WPE 抓帧在 1e-4 px 内（动画本身的四元数转矩阵不复刻 rsqrtps，写入与复位不引入差异）", () => {
    const names = ["le2", "le3", "le4"];
    const { diffs, compared } = boneDiffs(section, skins, names, 1e-4);
    for (const name of names) expect(compared[name], name).toBe(12);
    expect(diffs).toEqual([]);
    const exact = boneDiffs(section, skins, names).diffs;
    console.log(`[p12g] le2 / le3 / le4 的 g_Bones：不逐位相同 ${exact.length} 个分量（动画值 1e-8 级），其余逐位相同`);
  });

  it("g_Bones：物理骨骼（lf1–lf3）与 WPE 抓帧：打印差异，逐位相同的比例见日志", () => {
    const { diffs, compared } = boneDiffs(section, skins, ["lf1", "lf2", "lf3"]);
    for (const name of ["lf1", "lf2", "lf3"]) expect(compared[name], name).toBe(12);
    const worst = diffs.reduce((max, item) => Math.max(max, ulps(item.ours, item.wpe)), 0);
    console.log(`[p12g] 物理骨骼 g_Bones：不逐位相同 ${diffs.length} 个分量，最大 ${worst} ulp`);
    expect(diffs, JSON.stringify(diffs.slice(0, 6))).toEqual([]);
  });
});

// —— p12g-args：缺参与非 Vec3 / Mat4 实参写 b1、不整的骨骼链（lh 原样写回 / li 不写） ——

describe("p12g-args：缺参写入与不整链的完整乘法", () => {
  const section = root.args;
  const rig = build(section);
  const la2 = view(rig, "la2");
  const lh = view(rig, "lh");
  const lines: string[] = [];
  // 每帧一件事：写的值已按 API 的转换规则换好（转换本身在 p12gBonesApi.test.ts 里用同样的实参驱动 API 比对）
  const writes: Record<number, () => void> = {
    2: () => la2.setMat(1, IDENTITY),
    3: () => la2.setMat(1, IDENTITY),
    4: () => la2.setAng(1, [0, 0, 0]),
    5: () => la2.setOrg(1, [0, 0, 0]),
    6: () => la2.setAng(1, [0, 0, 0]),
    7: () => la2.setOrg(1, [0, 0, 0]),
    8: () => la2.setMat(1, Float32Array.from([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    9: () => la2.setMat(1, Float32Array.from([1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1])),
    10: () => la2.setAng(1, [1, 0, 0]),
    11: () => la2.setOrg(1, [3, 4, 0]),
    12: () => la2.setMat(1, IDENTITY),
  };
  let base: Float32Array[] | null = null;
  const skins = replay(section, rig, (k) => {
    writes[k]?.();
    if (k >= 2 && k <= 13) lines.push(`t${k},${join(la2.local(1))}`);
    // lh：每帧把 4 根骨骼的局部矩阵原样写回（基准取第 1 帧的读回）
    base ??= [0, 1, 2, 3].map((i) => Float32Array.from(lh.local(i)));
    for (let i = 0; i < 4; i++) lh.setMat(i, base[i]);
  });

  it("la2：缺参与非法实参写入的结果逐字相同（t2–t13）", () => {
    const want = section.logs.la2.filter((line) => /^t\d+,\d/.test(line));
    expect(lines).toEqual(want);
  });

  it("g_Bones：la2（静止）、lh（原样写回，完整乘法）、li（不写）与 WPE 逐位相同，lh 与 li 低位确实不同", () => {
    const { diffs, compared } = boneDiffs(section, skins, ["la2", "lh", "li"]);
    for (const name of ["la2", "lh", "li"]) expect(compared[name], name).toBe(3);
    expect(diffs).toEqual([]);
    // 完整乘法与仿射乘法的差异是真的：同一个骨架，写回与不写在某些分量上不同
    const frame = skins.get(112)!;
    const a = frame.get(rig.object("lh"))!;
    const b = frame.get(rig.object("li"))!;
    expect(a.some((value, i) => value !== b[i])).toBe(true);
  });
});
