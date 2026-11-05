/**
 * WPE SceneScript 的 `localStorage`（报告 A：`set` / `get` / `delete` / `clear` 加两个位置常量，没有 `remove`）。
 *
 * 数值在报告与官方文档里都没有（文档的函数签名把 `location` 写成 `String`，实际类型未核实），这里按 0 / 1 **推断**；
 * 本机样本都按常量名传，脚本拿到的是不透明的值。
 * 官方文档写明所有函数的默认位置是 `LOCATION_SCREEN`（「By default, local storage stores data per screen」）。
 */
export const LOCATION_GLOBAL = 0;
export const LOCATION_SCREEN = 1;

/** 键前缀：`kabegame:wpe-scene:ls:<图片 id>:<g|s>:`。场景键见 3c 已定 7，位置见已定 8。 */
export const SCENE_STORAGE_PREFIX = "kabegame:wpe-scene:ls:";

export interface SceneScriptStorageOptions {
  /**
   * 反序列化函数。脚本侧传 realm 的 `JSON.parse`，`get` 返回的对象 / 数组在脚本里 `instanceof` 才成立；
   * 单测与宿主内部默认用宿主的 `JSON.parse`。
   */
  parse?: (text: string) => unknown;
  debug?: (message: string) => void;
}

/**
 * 一个场景（图片 id）的 WPE `localStorage` 存储。底层是宿主所在 `file:` 来源的浏览器 `Storage`，
 * 按「场景键 + 位置」加前缀隔离：脚本看不到宿主、网页壁纸与别的场景存的东西。
 */
export class SceneScriptStorage {
  private readonly parse: (text: string) => unknown;
  private readonly debug: (message: string) => void;

  constructor(
    private readonly storage: Storage,
    private readonly sceneKey: string,
    options: SceneScriptStorageOptions = {},
  ) {
    this.parse = options.parse ?? ((text) => JSON.parse(text));
    this.debug = options.debug ?? (() => {});
  }

  /** 没有的键、坏 JSON 都是 `undefined`（后者记一条 debug，值仍留在存储里）。 */
  get(key: string, location: number = LOCATION_SCREEN): unknown {
    const text = this.storage.getItem(this.prefix(location) + key);
    if (text === null) return undefined;
    try {
      return this.parse(text);
    } catch {
      this.debug(`场景脚本存储 ${key} 的值不是合法 JSON`);
      return undefined;
    }
  }

  /** 值按 JSON 存取；超配额让 `Storage` 的异常照常抛出（宿主的回调包装负责禁用那一段）。 */
  set(key: string, value: unknown, location: number = LOCATION_SCREEN): void {
    const text = JSON.stringify(value);
    // `JSON.stringify(undefined)` 与函数返回 undefined：按 JSON 语义写成 null（推断）。
    this.storage.setItem(this.prefix(location) + key, text === undefined ? "null" : text);
  }

  /** 官方文档写明返回 `Boolean`；这里取「键原本是否存在」，含义是推断。 */
  delete(key: string, location: number = LOCATION_SCREEN): boolean {
    const name = this.prefix(location) + key;
    const existed = this.storage.getItem(name) !== null;
    this.storage.removeItem(name);
    return existed;
  }

  /** 只删本场景、本位置前缀下的键；`LOCATION_GLOBAL` 之外的取值都按屏幕处理（默认值同 WPE 文档）。 */
  clear(location: number = LOCATION_SCREEN): void {
    clearStoragePrefix(this.storage, this.prefix(location));
  }

  private prefix(location: number): string {
    const scope = location === LOCATION_GLOBAL ? "g" : "s";
    return `${SCENE_STORAGE_PREFIX}${this.sceneKey}:${scope}:`;
  }
}

/**
 * 删掉以 `prefix` 开头的全部键。`Storage.length` 边删边变，先收集再删，避免遍历跳项。
 * 语料等临时前缀清理也走这里。
 */
export function clearStoragePrefix(storage: Storage, prefix: string): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null && key.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
}

/** 删掉一个场景全部位置（`g` 与 `s`）下的键，别的场景与前缀外的键不动（面板的「清空脚本存储」）。 */
export function clearSceneStorage(storage: Storage, sceneKey: string): void {
  clearStoragePrefix(storage, `${SCENE_STORAGE_PREFIX}${sceneKey}:`);
}

/** 内存 `Storage`：宿主没有图片 id（不读写持久存储）与单测用。 */
export function createMemoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    key(index: number) {
      return [...items.keys()][index] ?? null;
    },
    getItem(key: string) {
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      items.set(key, String(value));
    },
    removeItem(key: string) {
      items.delete(key);
    },
    clear() {
      items.clear();
    },
  };
}

/** 宿主的浏览器 `Storage`；不可用时返回 null（调用方退回 `createMemoryStorage`）。 */
export function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
