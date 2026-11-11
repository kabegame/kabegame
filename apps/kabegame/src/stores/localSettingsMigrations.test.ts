import { describe, expect, it } from "vitest";
import { runLocalSettingsMigrations } from "./localSettingsMigrations";

/** 只实现迁移用到的那几个 Storage 方法。 */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

const OLD_KEY = "kabegame-setting-currentWallpaperImageId";
const NEW_KEY = "kabegame-setting-wallpaperTargets";

describe("Web 版背景图并入本地壁纸目标", () => {
  it("旧键的图片 id 记到 multiple 目标的当前壁纸上，旧键删除", () => {
    const storage = memoryStorage({ [OLD_KEY]: "42" });
    runLocalSettingsMigrations(storage);
    expect(storage.getItem(OLD_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(NEW_KEY)!)).toEqual({
      multiple: { rotationPath: null, rotationPosition: 0, style: {}, transition: {}, currentImageId: "42" },
    });
  });

  it("重复执行不改结果", () => {
    const storage = memoryStorage({ [OLD_KEY]: "42" });
    runLocalSettingsMigrations(storage);
    const migrated = storage.getItem(NEW_KEY);
    runLocalSettingsMigrations(storage);
    expect(storage.getItem(NEW_KEY)).toBe(migrated);
  });

  it("新键已有值时不覆盖，只清掉旧键", () => {
    const existing = JSON.stringify({ multiple: { currentImageId: "7" } });
    const storage = memoryStorage({ [OLD_KEY]: "42", [NEW_KEY]: existing });
    runLocalSettingsMigrations(storage);
    expect(storage.getItem(NEW_KEY)).toBe(existing);
    expect(storage.getItem(OLD_KEY)).toBeNull();
  });

  it("旧键为空值时不建目标", () => {
    for (const legacy of ["", "  ", "null"]) {
      const storage = memoryStorage({ [OLD_KEY]: legacy });
      runLocalSettingsMigrations(storage);
      expect(storage.getItem(NEW_KEY)).toBeNull();
      expect(storage.getItem(OLD_KEY)).toBeNull();
    }
  });

  it("没有旧键（桌面 / Android）什么都不做", () => {
    const storage = memoryStorage();
    runLocalSettingsMigrations(storage);
    expect(storage.length).toBe(0);
  });
});
