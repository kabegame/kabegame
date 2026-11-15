/**
 * 材质 pass 的五个状态字段（`blending` / `alphawriting` / `depthtest` / `depthwrite` / `cullmode`）的取值表与规整（P6d1b，
 * `rea-p6d1-matstate.md` 第 1、2 节）。编译期（`features.ts` 的 `normalizeDepthKeys`、`SUPPORTED.blending`）与运行中的脚本写入
 * （`SceneState.writePassState`）共用这一张表，不各写一份。
 *
 * WPE 的规则：每个字段一张 `名 → 值` 的表，按**全等**（区分大小写、空白也算字符）查；查不到取表的**第一项**。
 * 表的顺序就是 WPE 的登记顺序，所以 `depthtest` / `depthwrite` 的第一项是 `disabled`（写错会关深度）。
 */

export const PASS_STATE_TABLES = {
  blending: ["normal", "translucent", "additive", "alphatocoverage"],
  alphawriting: ["default", "disabled", "enabled"],
  depthtest: ["disabled", "enabled"],
  depthwrite: ["disabled", "enabled"],
  cullmode: ["normal", "nocull"],
} as const;

export type PassStateField = keyof typeof PASS_STATE_TABLES;

/** 五个字段，按 `ScenePass` 上的写法排（脚本对象上的顺序另由 `materialKeyOrder.ts` 定）。 */
export const PASS_STATE_FIELDS = Object.keys(PASS_STATE_TABLES) as PassStateField[];

export function isPassStateField(name: string): name is PassStateField {
  return Object.prototype.hasOwnProperty.call(PASS_STATE_TABLES, name);
}

/**
 * 运行中写入一个状态字段（WPE 原生 setter 的规则）：`null` / `undefined` 返回 `undefined`（不写）；其余先转字符串（数字、布尔、
 * 对象照 JS `String()`，转换抛错也不写），在表里全等查，查不到取表的第一项。返回的是规范名。
 */
export function normalizePassState(field: PassStateField, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let text: string;
  try {
    text = typeof raw === "string" ? raw : `${raw as string}`;
  } catch {
    return undefined;
  }
  const table: readonly string[] = PASS_STATE_TABLES[field];
  return table.includes(text) ? text : table[0];
}

/**
 * 加载期（材质 JSON）的规整：值不是字符串时当空串，同样落到第一项（`rea-p6d1-matstate.md` 2.3）。缺键由调用方先处理
 * （`cullmode` normal、`depthtest` / `depthwrite` enabled、`blending` normal、`alphawriting` default 都是「材质构造清零」的缺省）。
 */
export function normalizeJsonPassState(field: PassStateField, raw: unknown): string {
  const table: readonly string[] = PASS_STATE_TABLES[field];
  return typeof raw === "string" && table.includes(raw) ? raw : table[0];
}
