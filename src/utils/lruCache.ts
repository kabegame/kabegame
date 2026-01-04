/**
 * LRU (Least Recently Used) 缓存实现
 * 当缓存大小超过容量时，自动移除最久未使用的项
 */
export class LRUCache<T> {
  private capacity: number;
  private cache: Map<string, T>;
  private accessOrder: string[]; // 记录访问顺序，最新的在末尾

  constructor(capacity: number) {
    this.capacity = capacity;
    this.cache = new Map();
    this.accessOrder = [];
  }

  /**
   * 获取值，如果存在则更新访问顺序
   */
  get(key: string): T | undefined {
    if (this.cache.has(key)) {
      // 更新访问顺序：移除旧位置，添加到末尾
      this.updateAccessOrder(key);
      return this.cache.get(key);
    }
    return undefined;
  }

  /**
   * 设置值，如果超过容量则移除最久未使用的项
   */
  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      // 更新现有值
      this.cache.set(key, value);
      this.updateAccessOrder(key);
    } else {
      // 添加新值
      if (this.cache.size >= this.capacity) {
        // 移除最久未使用的项（第一个）
        const oldestKey = this.accessOrder[0];
        this.cache.delete(oldestKey);
        this.accessOrder.shift();
      }
      this.cache.set(key, value);
      this.accessOrder.push(key);
    }
  }

  /**
   * 检查是否存在
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * 删除项
   */
  delete(key: string): boolean {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      const index = this.accessOrder.indexOf(key);
      if (index !== -1) {
        this.accessOrder.splice(index, 1);
      }
      return true;
    }
    return false;
  }

  /**
   * 清空缓存
   */
  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * 获取当前大小
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * 获取所有键
   */
  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  /**
   * 遍历所有项
   */
  forEach(callback: (value: T, key: string) => void): void {
    this.cache.forEach(callback);
  }

  /**
   * 更新访问顺序
   */
  private updateAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      // 移除旧位置
      this.accessOrder.splice(index, 1);
    }
    // 添加到末尾（最新访问）
    this.accessOrder.push(key);
  }
}





