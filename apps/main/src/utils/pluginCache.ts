interface BrowserPlugin {
  id: string;
  name: string;
  desp: string;
  icon?: string;
  filePath?: string;
  doc?: string;
}

export interface CachedPluginData {
  plugin: BrowserPlugin;
  renderedDoc: string;
}

// LRU 缓存实现
export class LRUCache<K, V> {
  private capacity: number;
  private cache: Map<K, V>;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      console.log(
        `[LRU缓存] 未找到键: ${key}，当前缓存键:`,
        Array.from(this.cache.keys())
      );
      return undefined;
    }
    // 将访问的项移到末尾（最近使用）
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    console.log(`[LRU缓存] 找到键: ${key}，缓存大小: ${this.cache.size}`);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // 如果已存在，先删除再添加（移到末尾）
      this.cache.delete(key);
      console.log(`[LRU缓存] 更新已存在的键: ${key}`);
    } else if (this.cache.size >= this.capacity) {
      // 如果缓存已满，删除最旧的项（第一个）
      const it = this.cache.keys().next();
      if (!it.done) {
        const firstKey = it.value;
        this.cache.delete(firstKey);
        console.log(`[LRU缓存] 缓存已满，删除最旧的键: ${firstKey}`);
      }
    }
    this.cache.set(key, value);
    console.log(`[LRU缓存] 设置键: ${key}，缓存大小: ${this.cache.size}`);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

// 创建全局插件详情缓存（大小 10）
export const pluginCache = new LRUCache<string, CachedPluginData>(10);
