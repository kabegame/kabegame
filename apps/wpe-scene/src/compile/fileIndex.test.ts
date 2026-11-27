/**
 * 场景文件表（`wpe_scene_files`）：键的规整、三处并成脚本用的键集、形状校验、目录写法比较、按根查真实写法。
 */
import { describe, expect, it } from "vitest";
import {
  isSceneFileList,
  sameSceneDir,
  sceneFileKey,
  sceneFileKeys,
  SceneRootIndex,
  type SceneFileList,
} from "./fileIndex";

const LIST: SceneFileList = {
  project: { dir: "D:\\proj", files: ["project.json", "Models/Bar.json"] },
  pkg: ["scene.json"],
  assets: [{ dir: "D:\\wpe\\assets", files: ["shaders/common.h"] }],
};

describe("sceneFileKey", () => {
  it("反斜杠、开头的 ./ 与 /、连续的 / 规整掉，ASCII 字母不分大小写", () => {
    expect(sceneFileKey(".\\Models//Bar.JSON")).toBe("models/bar.json");
    expect(sceneFileKey("/materials/Ä.tex")).toBe("materials/Ä.tex");
  });
});

describe("sceneFileKeys", () => {
  it("三处的文件都进键集", () => {
    const keys = sceneFileKeys(LIST);
    for (const path of ["project.json", "models/bar.json", "scene.json", "shaders/common.h"])
      expect(keys.has(path)).toBe(true);
    expect(keys.size).toBe(4);
  });
});

describe("isSceneFileList", () => {
  it("认按来源分开的形状，不认旧的扁平数组与缺项", () => {
    expect(isSceneFileList(LIST)).toBe(true);
    expect(isSceneFileList(["scene.pkg"])).toBe(false);
    expect(isSceneFileList({ ...LIST, pkg: undefined })).toBe(false);
    expect(isSceneFileList({ ...LIST, assets: [{ dir: "x", files: [1] }] })).toBe(false);
    expect(isSceneFileList(null)).toBe(false);
  });
});

describe("sameSceneDir", () => {
  it("斜杠方向与末尾分隔符不算差别，其余逐字比", () => {
    expect(sameSceneDir("D:\\wpe\\assets", "D:/wpe/assets/")).toBe(true);
    expect(sameSceneDir("/home/a", "/home/a")).toBe(true);
    expect(sameSceneDir("/home/a", "/home/b")).toBe(false);
  });
});

describe("SceneRootIndex", () => {
  it("原写法在表里时用原写法，否则按键找第一个出现的真实写法，没有为 null", () => {
    const index = new SceneRootIndex(["Models/Bar.json", "models/bar.json", "Fonts/A.ttf"]);
    expect(index.find("models/bar.json")).toBe("models/bar.json");
    expect(index.find("MODELS/BAR.json")).toBe("Models/Bar.json");
    expect(index.find("fonts/a.ttf")).toBe("Fonts/A.ttf");
    expect(index.find("fonts/b.ttf")).toBeNull();
  });
});
