import type { EffectJson } from "./model";

/**
 * effect.json 的 `conditions`（fbo、pass、bind 三处共用一个求值函数），照 WPE 2.8.42 `FUN_1401e63b0`（rea-p7d-fluid 第 1 节，
 * 静态确认）。WPE 只在加载 effect 时求一次，被去掉的 fbo / pass / bind 不进 effect 对象，运行期不再看条件。
 *
 * - `conditions` 不是数组 → 真（缺省、写成对象 `{"X": 1}`、数字、字符串都恒真，不要「好心」当单元素数组）；
 * - 数组元素不是对象（jsoncpp 类型 7）→ 跳过，不影响结果；
 * - 数组之间、一个对象里的各键之间都是「与」，没有「或」；
 * - 左值取 `combos[名字]`（`combos` 是 effect 实例**顶层**的 `combos`，实例 pass 覆盖里的 COMBO 不参与，p7-REPORT「流体 effect 的条件」
 *   实测）：整数原样、小数截断取整，缺失、bool、字符串、对象（含绑用户属性的写法）一律当 0；`combos` 本身不是对象时全当 0。
 *   不取着色器注解的缺省值。名字区分大小写（jsoncpp `find` 按长度 + `memcmp`）；
 * - 右值是数 → 截断取整后比相等；是对象 `{value, op}` → `value` 是数才取（截断），否则 0；`op` 是长度恰为 2 的字符串
 *   `ge` / `gt` / `le` / `lt` 才认，其它（`eq`、`ne`、大写、缺 `op`）一律按相等；右值是别的类型（字符串、bool、null、数组）→
 *   这个键不参与（视为满足）。
 */
export function conditionsHold(conditions: unknown, combos: unknown): boolean {
  if (!Array.isArray(conditions)) return true;
  for (const element of conditions) {
    if (!isObject(element)) continue;
    let holds = true;
    for (const [name, right] of Object.entries(element)) {
      const combo = comboValue(combos, name);
      if (typeof right === "number") {
        if (Math.trunc(right) !== combo) holds = false;
      } else if (isObject(right)) {
        const value = typeof right.value === "number" ? Math.trunc(right.value) : 0;
        if (!compare(combo, value, typeof right.op === "string" ? right.op : "")) holds = false;
      }
      // 其它类型：WPE 不改累计值，这个键不参与
    }
    // 一个对象处理完累计值为假就立刻返回假（数组之间是「与」）
    if (!holds) return false;
  }
  return true;
}

/**
 * 被条件去掉的 fbo 名（`holds` 是按实例顶层 `combos` 求值的 `conditionsHold`）。同名还有留下的不算：WPE 按名字在过滤后的
 * fbo 表里线性查找，查得到就用留下的那张。查不到时 pass 的 `target` / `source` 与 bind 的下标都是 −1，
 * 即 `target` 等于没写（画回合成链）、bind 等于 `previous`（当前合成 RT）（rea-p7d-fluid 第 1 节第 8 条）。
 */
export function removedFbos(effect: EffectJson, holds: (conditions: unknown) => boolean): Set<string> {
  const kept = new Set<string>();
  const dropped = new Set<string>();
  for (const fbo of effect.fbos ?? []) {
    if (typeof fbo?.name !== "string") continue;
    (holds(fbo.conditions) ? kept : dropped).add(fbo.name);
  }
  return new Set([...dropped].filter((name) => !kept.has(name)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 左值：只有 `combos` 是对象时才查；数截断取整，其它类型（含缺失）当 0。 */
function comboValue(combos: unknown, name: string): number {
  if (!isObject(combos) || !Object.hasOwn(combos, name)) return 0;
  const value = combos[name];
  return typeof value === "number" ? Math.trunc(value) : 0;
}

/**
 * `op` 只在长度恰为 2 时识别（WPE 先比长度再 `memcmp`）。四个名字本身都是 2 个字符，所以逐个比字符串与 WPE 等价；
 * 认不出的一律按相等。
 */
function compare(combo: number, value: number, op: string): boolean {
  switch (op) {
    case "ge":
      return combo >= value;
    case "gt":
      return combo > value;
    case "le":
      return combo <= value;
    case "lt":
      return combo < value;
    default:
      return combo === value;
  }
}
