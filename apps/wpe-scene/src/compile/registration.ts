/**
 * 脚本与关键帧动画的登记顺序（P10b 决定 3，`collectScripts` 与 `collectAnimations` 共用）。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase10/p10-REPORT.md`「P10b 补测」的登记顺序（Q3 与 `p10b-order`）：WPE 的脚本 `init` /
 * `update` 与动画登记都是「`general` 的字段 → 按 `objects` 数组顺序，每个对象先自己的字段、再它的 `effects`（每个 effect 先 `visible`、
 * 再按 pass 顺序的常量）」，同一层按键名排序。本机语料的对象键全部按字母序书写（WPE 写文件时排好的），所以和按书写顺序遍历的实际差别
 * 只在 effect 的位置：书写顺序里 `effects` 在 `origin`、`scale`、`visible` 等字段之前，WPE 却登记在它们之后。
 *
 * 没实测的推断：`instanceoverride` 在对象字段里的位置按字母序处理（报告里没有单独测它），`constantshadervalues` 内部也按键名序
 * （报告实测了 `kfa` 在 `kfv` 前）。
 */

/** 码点序比较：jsoncpp 的对象键按 UTF-8 字节比较（`memcmp` 后比长度），UTF-8 的字节序就是码点序。 */
export function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n;) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/**
 * 一个字典节点的子项遍历顺序（数组照下标，不经这里）：
 * - `objects/<i>`（一个对象）：除 `effects` 以外的键按 `compareKeys`，`effects` 放最后；
 * - `objects/<i>/effects/<e>`（一个 effect）：`visible` 放最前，其余按 `compareKeys`；
 * - 其它字典（`general`、pass、`constantshadervalues`、`instanceoverride` 等）：全部按 `compareKeys`。
 */
export function registrationKeys(path: string, keys: readonly string[]): string[] {
  const sorted = [...keys].sort(compareKeys);
  if (/^objects\/\d+$/.test(path)) {
    const rest = sorted.filter((key) => key !== "effects");
    return rest.length === sorted.length ? rest : [...rest, "effects"];
  }
  if (/^objects\/\d+\/effects\/\d+$/.test(path)) {
    const rest = sorted.filter((key) => key !== "visible");
    return rest.length === sorted.length ? rest : ["visible", ...rest];
  }
  return sorted;
}
