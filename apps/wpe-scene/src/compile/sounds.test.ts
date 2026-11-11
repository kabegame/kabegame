/**
 * 声音表与能力表（P6a 步骤 1、2）：编译期把声音对象解析进 `bundle.sounds`、`volume` 登记成就地目标、各键的报与不报，
 * `volume` 挂 `{script}` 的写回目标（步骤 2），以及场景里有粒子层时脚本的播放控制按任意接收者报（`scriptApi.ts` 的
 * `PARTICLE_LAYER_METHODS`）。
 */
import { describe, expect, it, vi } from "vitest";
import { planApply } from "./bindings";
import { compileScene } from "./bundle";
import { checkObjectFeatures, isSoundObject } from "./features";
import type { SceneReader } from "./fs";
import type { SceneObject } from "./model";
import { MISSING_SCRIPT_API, PARTICLE_LAYER_METHODS, scanScriptApi } from "./scriptApi";
import { soundExtension, soundFlag, soundMode, soundVolume } from "./sounds";
import { SceneState } from "../render/state";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

function reader(map: Record<string, string>): SceneReader {
  const bytes = (path: string) => {
    const text = map[path.replace(/\\/g, "/")];
    if (text === undefined) throw new TypeError("Failed to fetch");
    return new TextEncoder().encode(text);
  };
  return {
    readWhole: async (path) => bytes(path),
    readRange: async (path, start, end) => bytes(path).slice(start, end),
  };
}

function compile(objects: unknown[], extra: Record<string, string> = {}, userProperties: Record<string, unknown> = {}) {
  return compileScene({
    projectDir: "P:/p",
    sceneAssets: ["A:/assets"],
    reader: reader({
      "P:/p/project.json": JSON.stringify({
        file: "scene.json",
        general: { properties: { vol: { value: 0.5 }, quiet: { value: false } } },
      }),
      "P:/p/scene.json": JSON.stringify({ general: { orthogonalprojection: { width: 64, height: 32 } }, objects }),
      "P:/p/sounds/a.mp3": "a",
      "P:/p/sounds/B.MP3": "b",
      "P:/p/sounds/c.txt": "c",
      ...extra,
    }),
    userProperties,
    translator: null,
    postprocess: "disabled",
    exhaustive: true,
  });
}

describe("声音表", () => {
  it("声音对象进 sounds，同时仍是 layers 里没有 pass 的图层；缺省值同 WPE（volume 1、mintime 1、maxtime 5、loop）", async () => {
    const bundle = await compile([{ id: 7, name: "music", sound: "sounds/a.mp3" }]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.layers.map((layer) => [layer.object, layer.name, layer.passes.length])).toEqual([[0, "music", 0]]);
    expect(bundle.sounds).toEqual([
      {
        object: 0,
        files: [{ path: "sounds/a.mp3", location: { path: "P:/p\\sounds\\a.mp3", offset: 0 }, size: null }],
        mode: "loop",
        mintime: 1,
        maxtime: 5,
        startSilent: false,
        volume: 1,
      },
    ]);
  });

  it("文件：找不到的、格式不对的不进表（WPE 读不出就删掉、不报错）；扩展名不分大小写；数组与字符串都行", async () => {
    const bundle = await compile([
      { sound: ["sounds/a.mp3", "sounds/missing.wav", "sounds/c.txt", "sounds/B.MP3", 3, "../x.mp3"] },
      { sound: [] },
      { sound: "" },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.sounds?.map((sound) => [sound.object, sound.files.map((file) => file.path)])).toEqual([
      [0, ["sounds/a.mp3", "sounds/B.MP3"]],
      [1, []],
      [2, []],
    ]);
  });

  it("字段：模式、时间、startsilent、volume 2 不钳制；volume 绑用户属性登记成就地目标", async () => {
    const bundle = await compile(
      [
        {
          sound: "sounds/a.mp3",
          playbackmode: "random",
          mintime: 0.5,
          maxtime: 3,
          startsilent: true,
          volume: 2,
          muteineditor: true,
          attenuation: 1,
          mindistance: 1,
          spatialization: false,
          solid: true,
        },
        { sound: "sounds/a.mp3", playbackmode: "single", volume: { user: "vol", value: 1 } },
      ],
      {},
      { vol: 0.25 },
    );
    expect(bundle.unsupported).toEqual([]);
    expect(
      bundle.sounds?.map(({ mode, mintime, maxtime, startSilent, volume }) => ({
        mode,
        mintime,
        maxtime,
        startSilent,
        volume,
      })),
    ).toEqual([
      { mode: "random", mintime: 0.5, maxtime: 3, startSilent: true, volume: 2 },
      { mode: "single", mintime: 1, maxtime: 5, startSilent: false, volume: 0.25 },
    ]);
    expect(bundle.bindings).toEqual([{ property: "vol", target: { kind: "sound", object: 1, field: "volume" } }]);
  });

  it("挂在不可见父层下、自己不可见的声音照样进表（p6a-misc：可见性不停声音）", async () => {
    const bundle = await compile([
      { id: 1, name: "group", visible: false },
      { id: 2, parent: 1, sound: "sounds/a.mp3", visible: false },
    ]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.sounds?.map((sound) => sound.object)).toEqual([1]);
  });

  it("就地写 volume：planApply 分到就地一侧，SceneState 用编译期同一条取值规则；不合法的值不改", async () => {
    const bundle = await compile([
      { sound: "sounds/a.mp3", volume: { user: { name: "quiet", condition: "true" }, value: 1 } },
    ]);
    const state = SceneState.fromBundle(bundle);
    expect(state.sounds.get(0)).toEqual({ volume: 0 });
    const plan = planApply(bundle.bindings, new Map([["quiet", true]]));
    expect(plan.recompile).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    expect(state.write(plan.writes[0].binding, true)).toBe("applied");
    expect(state.sounds.get(0)).toEqual({ volume: 1 });
    const plain = { property: "v", target: { kind: "sound", object: 0, field: "volume" } } as const;
    state.write(plain, "0.3");
    expect(state.sounds.get(0)?.volume).toBe(0.3);
    state.write(plain, "abc");
    expect(state.sounds.get(0)?.volume).toBe(0.3);
    expect(state.takeDirty().layers.size).toBe(0);
  });

  it("取值规则", () => {
    expect([soundVolume(0.5), soundVolume("2"), soundVolume(true), soundVolume(""), soundVolume(null)]).toEqual([
      0.5,
      2,
      1,
      undefined,
      undefined,
    ]);
    expect([soundFlag(true), soundFlag({ value: true }), soundFlag("true"), soundFlag(1)]).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect([soundMode("single"), soundMode("Random"), soundMode(undefined)]).toEqual(["single", "loop", "loop"]);
    expect([soundExtension("a/B.MP3"), soundExtension("a.Flac"), soundExtension("a.m4a"), soundExtension("a")]).toEqual(
      ["mp3", "flac", null, null],
    );
  });
});

describe("能力表：声音对象", () => {
  const check = (object: Record<string, unknown>) => {
    const unsupported = new Set<string>();
    checkObjectFeatures(object as SceneObject, unsupported);
    return [...unsupported].sort();
  };

  it("不再报 object:sound 与它自己的键", () => {
    expect(
      check({
        sound: ["a.mp3"],
        playbackmode: "loop",
        volume: { user: "v", value: 1 },
        mintime: 1,
        maxtime: 5,
        startsilent: true,
        muteineditor: true,
        attenuation: 1,
        mindistance: 1,
        spatialization: false,
        origin: "1 2 3",
        parent: 3,
        solid: true,
      }),
    ).toEqual([]);
  });

  it("新键：三维声音、未知播放模式、没有回调的键绑了属性；volume 挂脚本不再报（步骤 2）", () => {
    expect(check({ sound: "a.mp3", spatialization: true })).toEqual(["object:spatialization"]);
    expect(check({ sound: "a.mp3", spatialization: { value: true } })).toEqual(["object:spatialization"]);
    expect(check({ sound: "a.mp3", playbackmode: "shuffle" })).toEqual(["sound:playbackmode:shuffle"]);
    expect(check({ sound: "a.mp3", volume: { script: "export function update(v) { return v; }", value: 1 } })).toEqual(
      [],
    );
    expect(
      check({
        sound: "a.mp3",
        startsilent: { user: "s", value: false },
        mintime: { user: "m", value: 1 },
        playbackmode: { user: "p", value: "loop" },
      }),
    ).toEqual(["sound:binding:mintime", "sound:binding:playbackmode", "sound:binding:startsilent"]);
  });

  it("不是声音对象时这些键照未知键报", () => {
    expect(check({ image: "models/a.json", playbackmode: "loop", volume: 1 })).toEqual([
      "object:playbackmode",
      "object:volume",
    ]);
  });

  it("isSoundObject：sound 不为 null 就是（空字符串、空数组也算），有图像内容的不算", () => {
    expect(
      [{ sound: "" }, { sound: [] }, { sound: null }, {}, { image: "a.json", sound: "x.mp3" }].map((object) =>
        isSoundObject(object as SceneObject),
      ),
    ).toEqual([true, true, false, false, false]);
  });
});

describe("能力表：播放控制（步骤 2）", () => {
  const source = [
    "export function init() {",
    "  let music = thisScene.getLayer('music');",
    "  music.play(); music.pause(); thisScene.getLayer(1).stop();",
    "  if (music.isPlaying()) {}",
    "  thisLayer.volume = 0.5;",
    "}",
  ].join("\n");

  it("有粒子层时任意接收者上的 play / pause / stop / isPlaying 都报 particle.<名>；没有粒子层时不报，thisLayer 上也不报", () => {
    const script = { source, owner: { kind: "layer" as const }, layer: 0 };
    expect(scanScriptApi(script, { particleLayers: true })).toEqual([
      "particle.isPlaying",
      "particle.pause",
      "particle.play",
      "particle.stop",
    ]);
    expect(scanScriptApi(script)).toEqual([]);
    // 根对象上同样：thisLayer / thisObject 不再按 layer 组报（声音层有了），有粒子层时照报 particle
    for (const root of ["thisLayer", "thisObject"]) {
      const rooted = { source: `${root}.play(); ${root}.isPlaying();`, owner: { kind: "layer" as const }, layer: 0 };
      expect(scanScriptApi(rooted)).toEqual([]);
      expect(scanScriptApi(rooted, { particleLayers: true })).toEqual(["particle.isPlaying", "particle.play"]);
    }
    expect(
      scanScriptApi(
        { source: "thisLayer['stop']?.();", owner: { kind: "general" }, layer: null },
        { particleLayers: true },
      ),
    ).toEqual(["particle.stop"]);
  });

  it("PARTICLE_LAYER_METHODS 不在 MISSING_SCRIPT_API 里；volume 与四个方法也从 layer 组删掉了", () => {
    const layer = MISSING_SCRIPT_API.layer.map((entry) => entry.name);
    for (const name of [...PARTICLE_LAYER_METHODS, "volume"]) expect(layer).not.toContain(name);
    for (const entries of Object.values(MISSING_SCRIPT_API))
      for (const { name } of entries) expect(PARTICLE_LAYER_METHODS).not.toContain(name);
  });

  it("编译：场景有粒子层时报 particle.<名>，只有声音层时不报（不再报 layer.<名>）", async () => {
    const scripted = { id: 9, name: "ctrl", visible: { script: source, value: true } };
    const apiKeys = (bundle: { unsupported: string[] }) =>
      bundle.unsupported.filter((key) => key.startsWith("script:api:"));
    const withSound = await compile([scripted, { name: "music", sound: "sounds/a.mp3" }]);
    expect(withSound.unsupported).toEqual([]);
    const withParticle = await compile([
      scripted,
      { name: "music", sound: "sounds/a.mp3" },
      { name: "fx", particle: "particles/a.json" },
    ]);
    expect(apiKeys(withParticle)).toEqual([
      "script:api:particle.isPlaying",
      "script:api:particle.pause",
      "script:api:particle.play",
      "script:api:particle.stop",
    ]);
    const without = await compile([scripted]);
    expect(without.unsupported).toEqual([]);
  });
});

describe("volume 挂 {script}（步骤 2）", () => {
  const update = "export function update(value) { return value * 0.5; }";

  it("声音对象：写回目标是就地的 sound 目标、形状 float，不报；volume 取脚本的 value", async () => {
    const bundle = await compile([{ name: "music", sound: "sounds/a.mp3", volume: { script: update, value: 0.8 } }]);
    expect(bundle.unsupported).toEqual([]);
    expect(bundle.sounds?.[0].volume).toBe(0.8);
    expect(bundle.scripts.list.map((script) => [script.id, script.target, script.valueType])).toEqual([
      ["objects/0/volume", { kind: "sound", object: 0, field: "volume" }, "float"],
    ]);
  });

  it("不是声音对象的 volume 脚本不写回到声音目标", async () => {
    const bundle = await compile([{ name: "img", volume: { script: update, value: 1 } }]);
    expect(bundle.scripts.list[0].target).toEqual({ kind: "unsupported", path: "objects/0/volume" });
  });
});
