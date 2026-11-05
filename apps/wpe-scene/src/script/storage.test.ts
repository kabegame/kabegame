import { describe, expect, it, vi } from "vitest";
import { createWpeLocalStorage } from "./api";
import {
  clearSceneStorage,
  createMemoryStorage,
  LOCATION_GLOBAL,
  LOCATION_SCREEN,
  SCENE_STORAGE_PREFIX,
  SceneScriptStorage,
} from "./storage";

function backendKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
    (key): key is string => key !== null,
  );
}

describe("SceneScriptStorage（内存 Storage）", () => {
  it("set / get 往返数字、字符串、布尔、对象、数组；没有的键返回 undefined", () => {
    const backend = createMemoryStorage();
    const storage = new SceneScriptStorage(backend, "42");
    const values = [12, 0, "", "文本值", true, false, { a: [1, 2], b: null }, [1, "x", [2]]];
    for (const [index, value] of values.entries()) {
      storage.set(`k${index}`, value);
      expect(storage.get(`k${index}`)).toEqual(value);
    }
    expect(storage.get("missing")).toBeUndefined();
    expect(backendKeys(backend).sort()).toEqual(
      values.map((_, index) => `${SCENE_STORAGE_PREFIX}42:s:k${index}`).sort(),
    );
  });

  it("delete 返回键原本是否存在", () => {
    const storage = new SceneScriptStorage(createMemoryStorage(), "42");
    storage.set("k", 1);
    expect(storage.delete("k")).toBe(true);
    expect(storage.delete("k")).toBe(false);
    expect(storage.get("k")).toBeUndefined();
  });

  it("两个场景键、两个位置互不可见，clear 只删自己的前缀", () => {
    const backend = createMemoryStorage();
    const first = new SceneScriptStorage(backend, "1");
    const second = new SceneScriptStorage(backend, "2");
    first.set("k", 1);
    second.set("k", 2);
    first.set("k", 3, LOCATION_GLOBAL);
    expect(first.get("k")).toBe(1);
    expect(second.get("k")).toBe(2);
    expect(first.get("k", LOCATION_SCREEN)).toBe(1);
    expect(first.get("k", LOCATION_GLOBAL)).toBe(3);
    expect(second.get("k", LOCATION_GLOBAL)).toBeUndefined();
    first.clear(LOCATION_SCREEN);
    expect(first.get("k")).toBeUndefined();
    expect(first.get("k", LOCATION_GLOBAL)).toBe(3);
    expect(second.get("k")).toBe(2);
    first.clear(LOCATION_GLOBAL);
    expect(first.get("k", LOCATION_GLOBAL)).toBeUndefined();
    expect(second.get("k")).toBe(2);
  });

  it("前缀外的键（宿主的 dev 开关等）读不到、删不掉", () => {
    const backend = createMemoryStorage();
    const hostKey = "kabegame-dev-scene-force-render";
    backend.setItem(hostKey, "1");
    const storage = new SceneScriptStorage(backend, "1");
    expect(storage.get(hostKey)).toBeUndefined();
    storage.delete(hostKey);
    storage.clear(LOCATION_SCREEN);
    storage.clear(LOCATION_GLOBAL);
    expect(backend.getItem(hostKey)).toBe("1");
    expect(backend.length).toBe(1);
  });

  it("坏 JSON 返回 undefined 并记一条 debug，值留在存储里", () => {
    const backend = createMemoryStorage();
    const debug = vi.fn();
    const storage = new SceneScriptStorage(backend, "1", { debug });
    backend.setItem(`${SCENE_STORAGE_PREFIX}1:s:bad`, "{oops");
    expect(storage.get("bad")).toBeUndefined();
    expect(debug).toHaveBeenCalledOnce();
    expect(backend.getItem(`${SCENE_STORAGE_PREFIX}1:s:bad`)).toBe("{oops");
  });

  it("超配额异常照常抛出（交给回调的出错处理）", () => {
    const backend = createMemoryStorage();
    backend.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    const storage = new SceneScriptStorage(backend, "1");
    expect(() => storage.set("k", 1)).toThrow("QuotaExceededError");
  });

  it("clear 遍历时不会因为边删边遍历而漏键", () => {
    const backend = createMemoryStorage();
    const storage = new SceneScriptStorage(backend, "1");
    for (let index = 0; index < 20; index++) storage.set(`k${index}`, index);
    storage.clear();
    expect(backendKeys(backend)).toEqual([]);
  });

  it("clearSceneStorage 删本场景的 g 与 s，别的场景与前缀外的键不动", () => {
    const backend = createMemoryStorage();
    const scene = new SceneScriptStorage(backend, "1");
    scene.set("a", 1, LOCATION_GLOBAL);
    scene.set("a", 2, LOCATION_SCREEN);
    scene.set("b", 3, LOCATION_SCREEN);
    // 前缀相近的场景：id 12 不能被当成 id 1 删掉
    const similar = new SceneScriptStorage(backend, "12");
    similar.set("a", 4);
    backend.setItem("kabegame-dev-scene-force-render", "1");
    clearSceneStorage(backend, "1");
    expect(backendKeys(backend).sort()).toEqual(["kabegame-dev-scene-force-render", `${SCENE_STORAGE_PREFIX}12:s:a`]);
    expect(similar.get("a")).toBe(4);
  });
});

describe("WPE localStorage 对象（作用域与 realm 解析）", () => {
  it("模块求值期间调用抛错，之后可正常存取；没有 remove；get 用 realm 的 JSON.parse", () => {
    const backend = createMemoryStorage();
    let evaluating = true;
    // 用自己的 JSON.parse 证明取的是传入（realm）的那份
    const realmJson = { parse: (text: string) => ({ realm: text }) };
    const object = createWpeLocalStorage({
      global: { Object, JSON: realmJson } as unknown as Record<string, unknown>,
      backend,
      sceneKey: "1",
      isEvaluating: () => evaluating,
    }) as Record<string, unknown>;
    expect(() => (object.get as (key: string) => unknown)("k")).toThrow("模块求值期间");
    expect(() => (object.set as (key: string, value: unknown) => void)("k", 1)).toThrow("模块求值期间");
    expect(() => (object.delete as (key: string) => void)("k")).toThrow("模块求值期间");
    expect(() => (object.clear as () => void)()).toThrow("模块求值期间");
    evaluating = false;
    (object.set as (key: string, value: unknown) => void)("k", { a: 1 });
    expect((object.get as (key: string) => unknown)("k")).toEqual({ realm: '{"a":1}' });
    expect((object.get as (key: string) => unknown)("missing")).toBeUndefined();
    expect("remove" in object).toBe(false);
    expect(backendKeys(backend)).toEqual([`${SCENE_STORAGE_PREFIX}1:s:k`]);
  });

  it("位置参数缺省为 LOCATION_SCREEN", () => {
    const backend = createMemoryStorage();
    const object = createWpeLocalStorage({
      global: { Object, JSON } as unknown as Record<string, unknown>,
      backend,
      sceneKey: "1",
      isEvaluating: () => false,
    }) as Record<string, unknown>;
    (object.set as (key: string, value: unknown) => void)("k", 1);
    expect(backendKeys(backend)).toEqual([`${SCENE_STORAGE_PREFIX}1:s:k`]);
    expect(backend.getItem(`${SCENE_STORAGE_PREFIX}1:g:k`)).toBeNull();
    expect(LOCATION_GLOBAL).toBe(0);
    expect(LOCATION_SCREEN).toBe(1);
  });
});
