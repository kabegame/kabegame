/**
 * Whether a plugin config var should be shown for the current `vars`,
 * matching CrawlerDialog `visiblePluginVars` / plugin config.json `when`.
 */
export function matchesPluginVarWhen(
  when: Record<string, (string | boolean)[]> | undefined | null,
  vars: Record<string, any>,
): boolean {
  console.log("when", when, vars);
  if (!when) return true;
  return Object.entries(when).every(([depKey, acceptedValues]) =>
    acceptedValues.map(String).includes(String(vars[depKey] ?? "")),
  );
}

/**
 * 按选项自身的 `when`（与字段级 when 语义相同）过滤 options/checkbox 等待选项列表。
 * 无 `when` 的选项始终显示；字符串选项无 when，始终保留。
 */
export function filterVarOptionsByWhen<
  T extends string | { when?: Record<string, (string | boolean)[]> },
>(options: T[] | undefined, vars: Record<string, any>): T[] {
  if (!options) return [];
  return options.filter((opt) => {
    if (typeof opt === "string") return true;
    return matchesPluginVarWhen(
      (opt as { when?: Record<string, (string | boolean)[]> }).when,
      vars,
    );
  });
}

/** 当依赖项变化导致当前 options 值不在可见选项中时，回退到 default（若 default 仍合法）或第一个可见项。 */
export function coerceOptionsVarsToVisibleChoices(
  defs: Array<{
    key: string;
    type?: string;
    default?: unknown;
    options?: (
      | string
      | { variable?: string; when?: Record<string, string[]> }
    )[];
    when?: Record<string, (string | boolean)[]>;
  }>,
  vars: Record<string, any>,
): void {
  for (const def of defs) {
    if (def.type !== "options" || !def.options || !Array.isArray(def.options))
      continue;
    if (!matchesPluginVarWhen(def.when, vars)) continue;
    const filtered = filterVarOptionsByWhen(def.options, vars);
    const allowed = filtered
      .map((o) => (typeof o === "string" ? o : (o.variable ?? "")))
      .filter((s) => s !== "");
    if (allowed.length === 0) continue;
    const cur = vars[def.key];
    if (typeof cur !== "string") continue;
    if (!allowed.includes(cur)) {
      const d = def.default;
      vars[def.key] =
        typeof d === "string" && allowed.includes(d) ? d : allowed[0];
    }
  }
}
