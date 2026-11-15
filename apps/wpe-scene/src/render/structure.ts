/**
 * 运行时对象表的派生（P6d3）：`SceneState.order` 是 WPE 的对象表（`G+0x158`），顶层绘制顺序、体积光插入点、反射 pass、粒子步进、
 * 相机对象选择、光标命中都读它。这里是不依赖 GPU 的纯函数，渲染器按 `state.structureVersion` 缓存结果。
 */

/**
 * 对象表 → 顶层绘制顺序与位置表。
 * - `top`：按 `order`，只取有渲染运行时、且不由组代画（`layer.group == null`，缺这个字段也当顶层）的；
 * - `position`：对象 → 在 `order` 里的下标。
 */
export function layerStructure<T extends { layer: { group?: number | null } }>(
  order: readonly number[],
  runtimes: ReadonlyMap<number, T>,
): { top: T[]; position: Map<number, number> } {
  const position = new Map<number, number>();
  const top: T[] = [];
  order.forEach((object, index) => {
    position.set(object, index);
    const runtime = runtimes.get(object);
    if (runtime && runtime.layer.group == null) top.push(runtime);
  });
  return { top, position };
}

/** 按对象表位置比较两个对象下标；不在表里的排最后（并列按下标）。 */
export function byPosition(position: ReadonlyMap<number, number>): (a: number, b: number) => number {
  return (a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity) || a - b;
}
