/**
 * 声音表与能力表（P6a 步骤 1）：编译期把声音对象解析进 `bundle.sounds`、`volume` 登记成就地目标、各键的报与不报，
 * 以及场景里有声音对象时脚本的播放控制按任意接收者报（`scriptApi.ts` 的 `SOUND_LAYER_METHODS`）。
 */
import { describe, expect, it, vi } from "vitest";
import { planApply } from "./bindings";
import { compileScene } from "./bundle";
import { checkObjectFeatures, isSoundObject } from "./features";
import type { SceneReader } from "./fs";
import type { SceneObject } from "./model";
import { scanScriptApi } from "./scriptApi";
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

  it("新键：三维声音、未知播放模式、volume 挂脚本、没有回调的键绑了属性", () => {
    expect(check({ sound: "a.mp3", spatialization: true })).toEqual(["object:spatialization"]);
    expect(check({ sound: "a.mp3", spatialization: { value: true } })).toEqual(["object:spatialization"]);
    expect(check({ sound: "a.mp3", playbackmode: "shuffle" })).toEqual(["sound:playbackmode:shuffle"]);
    expect(check({ sound: "a.mp3", volume: { script: "export function update(v) { return v; }", value: 1 } })).toEqual([
      "sound:volume:script",
    ]);
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

describe("能力表：有声音对象时的脚本播放控制", () => {
  const source = [
    "export function init() {",
    "  let music = thisScene.getLayer('music');",
    "  music.play(); music.pause(); thisScene.getLayer(1).stop();",
    "  if (music.isPlaying()) {}",
    "}",
  ].join("\n");

  it("任意接收者上的 play / pause / stop / isPlaying 都报 layer.<名>；没有声音对象时照旧只认 thisLayer", () => {
    const script = { source, owner: { kind: "layer" as const }, layer: 0 };
    expect(scanScriptApi(script, { soundLayers: true })).toEqual([
      "layer.isPlaying",
      "layer.pause",
      "layer.play",
      "layer.stop",
    ]);
    expect(scanScriptApi(script)).toEqual([]);
    // general 上的脚本同样
    expect(
      scanScriptApi({ source: "thisLayer.play();", owner: { kind: "general" }, layer: null }, { soundLayers: true }),
    ).toEqual(["layer.play"]);
  });

  it("编译：场景有声音对象时报，没有时不报", async () => {
    const scripted = { id: 9, name: "ctrl", visible: { script: source, value: true } };
    const withSound = await compile([scripted, { name: "music", sound: "sounds/a.mp3" }]);
    expect(withSound.unsupported).toEqual([
      "script:api:layer.isPlaying",
      "script:api:layer.pause",
      "script:api:layer.play",
      "script:api:layer.stop",
    ]);
    const without = await compile([scripted]);
    expect(without.unsupported).toEqual([]);
  });
});
