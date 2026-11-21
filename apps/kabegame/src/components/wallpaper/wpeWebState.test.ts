import { describe, expect, it } from "vitest";
import {
  WPE_STATE_MESSAGE,
  changedUserProperties,
  directoryChanges,
  fullStateMessage,
  readyStateMessage,
  stateDelta,
  type WpeWebState,
} from "./wpeWebState";

const BASE: WpeWebState = {
  imageId: "1",
  user: {
    speed: { type: "slider", value: 1 },
    pic: { type: "file", value: "D:/a.jpg" },
    dir: { type: "directory", value: "D:/pics" },
    note: { type: "text", value: false },
  },
  general: { language: "zh-chs", fps: 30 },
  directories: {
    dir: { mode: "fetchall", files: ["D:/pics/1.jpg", "D:/pics/2.jpg"] },
    lazy: { mode: "ondemand", files: ["D:/l/1.jpg"] },
  },
};

describe("wpeWebState 消息", () => {
  it("整份与就绪的形状", () => {
    expect(fullStateMessage(BASE)).toEqual({ type: WPE_STATE_MESSAGE, full: true, state: BASE });
    expect(readyStateMessage(BASE.directories)).toEqual({
      type: WPE_STATE_MESSAGE,
      full: false,
      user: null,
      general: null,
      directories: BASE.directories,
      directoryChanges: {},
    });
  });
});

describe("changedUserProperties（搬自垫片，规则不变）", () => {
  it("只含值变了的键；没变返回 null", () => {
    expect(changedUserProperties(BASE.user, BASE.user)).toBeNull();
    const next = { ...BASE.user, speed: { type: "slider", value: 2 } };
    expect(changedUserProperties(BASE.user, next)).toEqual({ speed: { type: "slider", value: 2 } });
  });

  it("新增的键照推；作者删掉的普通键不推，没有默认值的 file / directory 重置后补空路径", () => {
    const next = { speed: BASE.user.speed, extra: { type: "bool", value: true } };
    expect(changedUserProperties(BASE.user, next)).toEqual({
      extra: { type: "bool", value: true },
      pic: { type: "file", value: "" },
      dir: { type: "directory", value: "" },
    });
  });
});

describe("directoryChanges", () => {
  it("prev 为 null（整份）时 fetchall 全部算新增，ondemand 不算", () => {
    expect(directoryChanges(null, BASE.directories)).toEqual({
      dir: { added: ["D:/pics/1.jpg", "D:/pics/2.jpg"], removed: [] },
    });
  });

  it("按文件增删；目录没了算全部删除；改成 ondemand 算全部删除", () => {
    expect(
      directoryChanges(BASE.directories, {
        dir: { mode: "fetchall", files: ["D:/pics/2.jpg", "D:/pics/3.jpg"] },
      }),
    ).toEqual({ dir: { added: ["D:/pics/3.jpg"], removed: ["D:/pics/1.jpg"] } });
    expect(directoryChanges(BASE.directories, {})).toEqual({
      dir: { added: [], removed: ["D:/pics/1.jpg", "D:/pics/2.jpg"] },
    });
    expect(directoryChanges(BASE.directories, { dir: { mode: "ondemand", files: ["D:/pics/1.jpg"] } })).toEqual({
      dir: { added: [], removed: ["D:/pics/1.jpg", "D:/pics/2.jpg"] },
    });
  });
});

describe("stateDelta", () => {
  it("什么都没变返回 null", () => {
    expect(stateDelta(BASE, structuredClone(BASE))).toBeNull();
  });

  it("通用属性变了整份；用户属性只含变的键；目录带增删与最新整份", () => {
    const next: WpeWebState = {
      ...BASE,
      user: { ...BASE.user, speed: { type: "slider", value: 3 } },
      general: { language: "en-us", fps: 30 },
      directories: { ...BASE.directories, dir: { mode: "fetchall", files: ["D:/pics/2.jpg"] } },
    };
    expect(stateDelta(BASE, next)).toEqual({
      type: WPE_STATE_MESSAGE,
      full: false,
      user: { speed: { type: "slider", value: 3 } },
      general: { language: "en-us", fps: 30 },
      directories: next.directories,
      directoryChanges: { dir: { added: [], removed: ["D:/pics/1.jpg"] } },
    });
  });

  it("只有 ondemand 目录的文件变了：照发（垫片要最新列表回答随机文件），没有回调项", () => {
    const next: WpeWebState = { ...BASE, directories: { ...BASE.directories, lazy: { mode: "ondemand", files: [] } } };
    expect(stateDelta(BASE, next)).toEqual({
      type: WPE_STATE_MESSAGE,
      full: false,
      user: null,
      general: null,
      directories: next.directories,
      directoryChanges: {},
    });
  });
});
