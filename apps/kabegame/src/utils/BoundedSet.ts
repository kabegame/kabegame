/** 按插入顺序淘汰旧值的定长 Set。 */
export class BoundedSet<T> {
  private readonly values = new Set<T>();

  constructor(private readonly limit: number) {}

  has(value: T): boolean {
    return this.values.has(value);
  }

  add(value: T): void {
    if (this.values.has(value)) return;
    this.values.add(value);
    while (this.values.size > this.limit) {
      const oldest = this.values.values().next().value as T | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }
}
