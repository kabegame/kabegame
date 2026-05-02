// Why: web.ts / settings.ts 都需要在任意调用处读取当前 super 状态，但它们位于
// packages/core 里，无法 import apps/kabegame 的 useApp。通过这个极小的注入点，
// apps/kabegame 启动时一次性注册 `() => useApp().isSuper`，消费方以函数形式读取，
// 既避开循环依赖又保留 Vue watch 对底层响应式的订阅能力。
let superGetter: () => boolean = () => false;

export function setSuperGetter(fn: () => boolean): void {
  superGetter = fn;
}

export function getIsSuper(): boolean {
  return superGetter();
}
