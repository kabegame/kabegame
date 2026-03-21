/**
 * Whether a plugin config var should be shown for the current `vars`,
 * matching CrawlerDialog `visiblePluginVars` / plugin config.json `when`.
 */
export function matchesPluginVarWhen(
  when: Record<string, string[]> | undefined | null,
  vars: Record<string, any>
): boolean {
  if (!when) return true;
  return Object.entries(when).every(([depKey, acceptedValues]) =>
    acceptedValues.includes(String(vars[depKey] ?? ""))
  );
}
