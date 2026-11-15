/**
 * 对象加载时的配置原文（P6d3，`getInitialLayerConfig`）：WPE 的 dll 把 `scene.json` 的对象用 jsoncpp writer 写回文本（步骤 0 实测，
 * `p6d3-struct`）。规则：
 * - 去掉顶层 `id`；
 * - 所有层级的对象键按字典序（jsoncpp 的 `std::map` 键序，按 UTF-16 码元比较）；
 * - 非整数的数按 8 位有效数字（`0.123456789123` → `0.12345679`）；整数原样（`123456789012`，`1e21` 经 JSON.parse 后是 `1e+21`）；
 * - 字符串、布尔、null、数组原样（数组元素同样规整）；没写的键不补。
 */

function normalize(value: unknown): unknown {
  if (typeof value === "number")
    return Number.isInteger(value) || !Number.isFinite(value) ? value : Number(value.toPrecision(8));
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = normalize(record[key]);
    return out;
  }
  return value;
}

/** 一个对象的加载原文（JSON 文本）。 */
export function normalizeConfig(object: object): string {
  const { id: _id, ...rest } = object as Record<string, unknown>;
  return JSON.stringify(normalize(rest));
}
