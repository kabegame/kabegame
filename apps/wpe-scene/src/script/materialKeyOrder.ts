// 材质对象（`effect.getMaterial(i)` / 材质常量脚本的 `thisObject`）的键顺序，照 WPE。
// 依据：`.claude/plans/wpe-import/3-scene/phase6/rea-p6d1-keyorder.md`（第 4、6 节）；对拍参考 `ignore/p6/rea/layers/keyorder/`；
// 实测 `ignore/p6/d0/out/p6d1-round2.log`（tint / transform / chromaticaberration / fire / pulse / lightshafts 全部逐项相同）。
//
// WPE 的材质常量表是 MSVC `std::unordered_map<string, …>`，JS 对象的键就是它的迭代顺序（链表顺序）再整串倒序：
// 1. 材质键按 UTF-8 字节序（无符号，前缀相同则短的在前）排序，作为插入顺序（合并表是有序 map 的中序）；
// 2. 模拟 MSVC 插入：FNV-1a 64 位散列（桶号只要低位，低 32 位用 `Math.imul` 即可）、初始 8 桶，
//    `(size+1)/桶数 > 1` 时先扩容（8 → 64 → 512 → 之后按需取 2 的幂）、再放入；空桶追加到链表尾，非空桶插在该桶首节点之前；
//    扩容时按旧链表从头到尾逐个重新放置；
// 3. 前面拼上类静态表（五个状态字段）的链表顺序，整串倒序、同名去重（倒序后先出现的保留），末尾加 `getAnimation`。

/** 类静态表的链表顺序（rea-p6d1-keyorder 6.1，写死）。 */
const STATIC_LIST = ["blending", "alphawriting", "cullmode", "depthtest", "depthwrite"];

/** 五个 pass 状态字段，按 JS 里的顺序（静态表链表倒序）。 */
export const MATERIAL_STATE_KEYS = [...STATIC_LIST].reverse();

const encoder = new TextEncoder();

function bucketHash(key: string): number {
  let h = 0x84222325;
  for (const b of encoder.encode(key)) h = Math.imul(h ^ b, 0x1b3) >>> 0;
  return h;
}

/** UTF-8 字节序比较（不是 UTF-16 码元序：代理对与 BMP 高位字符的先后不同）。 */
function utf8Compare(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/** 按给定插入顺序模拟 MSVC `unordered_map` 插入，返回迭代（链表）顺序。 */
function msvcListOrder(insertOrder: readonly string[]): string[] {
  let buckets = 8;
  const list: string[] = [];
  const firstOfBucket = new Map<number, string>(); // 桶 -> 该桶当前在链表里最靠前的节点
  const hashes = new Map<string, number>();
  const place = (key: string): void => {
    const bucket = hashes.get(key)! & (buckets - 1);
    const first = firstOfBucket.get(bucket);
    if (first === undefined) list.push(key);
    else list.splice(list.indexOf(first), 0, key);
    firstOfBucket.set(bucket, key);
  };
  for (const key of insertOrder) {
    if (hashes.has(key)) continue;
    hashes.set(key, bucketHash(key));
    if ((list.length + 1) / buckets > 1) {
      const need = Math.max(8, list.length + 1);
      const target = buckets < need ? (buckets < 512 && buckets * 8 >= need ? buckets * 8 : need) : buckets;
      buckets = 1;
      while (buckets < target) buckets <<= 1;
      const old = list.splice(0);
      firstOfBucket.clear();
      for (const k of old) place(k);
    }
    place(key);
  }
  return list;
}

/** 材质常量键（顺序无关）在 WPE 里的迭代顺序，不含状态字段与 `getAnimation`。 */
export function materialConstantOrder(constants: Iterable<string>): string[] {
  return msvcListOrder([...new Set(constants)].sort(utf8Compare));
}

/**
 * 材质对象的完整键顺序：常量、五个状态字段、`getAnimation`。
 * 同名（材质键恰好是 `blending` 等状态名）：只留一个，位置在常量那一段（rea-p6d1-keyorder 4.3，推断、语料里没见过）。
 * 数组下标样的键（`"0"`、`"12"`）由 JS 引擎自己排到所有字符串键之前，这里不处理。
 */
export function materialObjectKeys(constants: Iterable<string>): string[] {
  const merged = [...STATIC_LIST, ...materialConstantOrder(constants)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = merged.length - 1; i >= 0; i--)
    if (!seen.has(merged[i])) {
      seen.add(merged[i]);
      out.push(merged[i]);
    }
  return [...out, "getAnimation"];
}
