import { describe, expect, it } from "vitest";
import { classifyScriptError } from "./scriptErrors";

describe("脚本报错归类（P3b 步骤 6 的报错文本）", () => {
  it.each([
    ["engine.registerAudioBuffers is not a function (line 44, col 28)", "api", "engine.registerAudioBuffers"],
    ["thisLayer.getParent is not a function (line 21, col 9)", "api", "thisLayer.getParent"],
    ["thisObject.getAnimation is not a function (line 7, col 12)", "api", "thisObject.getAnimation"],
    ["thisLayer.isPlaying is not a function (line 12, col 3)", "api", "thisLayer.isPlaying"],
    ["input is not defined (line 5, col 1)", "api", "input"],
    ["localStorage is not defined (line 46, col 25)", "api", "localStorage"],
    ["video.getVideoTexture is not a function (line 18, col 10)", "indirect", "getVideoTexture"],
    ["audioLayer.stop is not a function (line 30, col 5)", "indirect", "stop"],
    ["audioLayer.play is not a function (line 31, col 5)", "indirect", "play"],
    ["cachedSongs[index].isPlaying is not a function (line 9, col 7)", "indirect", "isPlaying"],
    ["cachedSongs[1].play is not a function (line 9, col 7)", "indirect", "play"],
    ["Cannot read properties of undefined (reading 'scale') (line 14, col 22)", "consequential", "scale"],
    ["scene is not defined (line 2, col 0)", "sample", "scene"],
    ["localStorage.remove is not a function (line 9, col 3)", "sample", "localStorage.remove"],
    ["console.warn is not a function (line 4, col 5)", "sample", "console.warn"],
    [
      "Cannot create property 'x' on boolean 'true' (line 116, col 10)",
      "other",
      "Cannot create property 'x' on boolean 'true'",
    ],
  ])("%s", (message, kind, name) => {
    expect(classifyScriptError(message)).toEqual({ kind, name });
  });

  it("去掉 runtime 记录的「回调：」前缀", () => {
    expect(classifyScriptError("init: localStorage is not defined (line 46, col 25)")).toEqual({
      kind: "api",
      name: "localStorage",
    });
    expect(classifyScriptError("update: Cannot read properties of undefined (reading 'x')")).toEqual({
      kind: "consequential",
      name: "x",
    });
    expect(classifyScriptError("ended: thisLayer.getParent is not a function (line 3, col 1)")).toEqual({
      kind: "api",
      name: "thisLayer.getParent",
    });
  });

  it("其它全局未定义不冒充缺失 API", () => {
    expect(classifyScriptError("foo is not defined")).toEqual({ kind: "other", name: "foo" });
  });
});
