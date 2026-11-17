/**
 * 片段缓存（活的场景图 L5，`.claude/plans/wpe-import/3-scene/live/phase-l5-create-layer.md` 点 2）：运行中 `createLayer` 先查它，命中时把片段改键
 * （`rekeyFragment`）当场装上，当帧画出；没命中的由编译会话异步编，到达后放进来，之后同一配置再建就命中。
 *
 * - **键**是规整配置（`normalizeConfig`：去顶层 `id`、键按字典序、非整数 8 位有效数字），和 `getInitialLayerConfig` 读到的、`bundle.configs` 里的是同一种文本。
 * - **值**是模板坐标的片段（`objects/<模板>/…`），用的时候改键；缓存里的不改。
 * - **按会话归属**：片段里的程序、纹理下标是会话（这份 bundle）的坐标，换场景 / 整场重载时整个丢掉（宿主换新的实例），不跨会话用。
 * - **预置**（`seed`）：整场 bundle 里能取片段（`fragmentBlocker` 为 null）且原文经规整无损（会话的 `exactConfigs`）的对象，用 `fragmentOf` 取。
 *   有损的不预置：脚本拿到的规整配置和原文在少数常量末几位不同，按它编出的片段和整场 bundle 里的不同（L1），第一次照样异步真编、之后命中真编的。
 * - 文本层的排版不进缓存：装入时现排（`SceneTexts.layoutInCurrent`）。
 */
import type { SceneBundle } from "./compile/bundle";
import { normalizeConfig } from "./compile/config";
import { fragmentBlocker, fragmentOf, type ObjectFragment } from "./compile/fragment";

/**
 * 配置原文（`createLayer` 交给宿主的 JSON 文本，带 `id`）→ 缓存键；不是合法 JSON、不是对象时 null。数组配置（分组节点）不进缓存：
 * 分组节点的 `id` 按编译规则发（不在配置里），改键给不出和编译相同的 id，一律走会话。
 */
export function fragmentKey(config: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return normalizeConfig(parsed);
}

export class FragmentCache {
  private readonly entries = new Map<string, ObjectFragment>();

  get size(): number {
    return this.entries.size;
  }

  /**
   * 从整场 bundle 预置：`exact` 里的每个对象（升序），`fragmentBlocker` 为 null、配置是对象（不是数组）时 `fragmentOf` 进缓存；同键先到先得。
   * 返回进了缓存的个数。
   */
  seed(bundle: SceneBundle, exact: Iterable<number>): number {
    let count = 0;
    for (const object of [...exact].sort((a, b) => a - b)) {
      const key = bundle.configs?.[object];
      if (typeof key !== "string" || key.startsWith("[") || this.entries.has(key)) continue;
      if (fragmentBlocker(bundle, object) !== null) continue;
      const fragment = fragmentOf(bundle, object);
      if (!fragment) continue;
      this.entries.set(key, fragment);
      count++;
    }
    return count;
  }

  /** 放进一个片段（键是规整配置）；同键已有时保留旧的（先到先得，同 `seed`）。 */
  put(key: string, fragment: ObjectFragment): void {
    if (!this.entries.has(key)) this.entries.set(key, fragment);
  }

  get(key: string): ObjectFragment | undefined {
    return this.entries.get(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * 属性变了：带「按这些属性整场重编译」绑定（`recompile` 目标，`size`、`colorBlendMode` 等）的片段作废。这些目标的值是编片段那一刻按属性定的，
   * 绑定还在登记表里时宿主会整场重载（缓存随之丢掉）；对象已删、只剩缓存里的片段时宿主看不到它，靠这里摘掉。返回摘掉的个数。
   */
  dropBoundTo(properties: Iterable<string>): number {
    const keys = new Set(properties);
    if (keys.size === 0) return 0;
    let count = 0;
    for (const [key, fragment] of this.entries)
      if (fragment.bindings.some((binding) => binding.target.kind === "recompile" && keys.has(binding.property))) {
        this.entries.delete(key);
        count++;
      }
    return count;
  }

  clear(): void {
    this.entries.clear();
  }
}
