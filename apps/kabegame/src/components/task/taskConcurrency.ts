export function effectiveTaskConcurrency(limit: number | null, globalMax: number): number {
  const global = Math.max(1, Math.trunc(globalMax || 1));
  return Math.min(limit == null ? global : Math.max(1, Math.trunc(limit)), global);
}

export function decreasedTaskConcurrency(effective: number): number {
  return Math.max(1, Math.trunc(effective) - 1);
}

export function increasedTaskConcurrency(effective: number, globalMax: number): number | null {
  const global = Math.max(1, Math.trunc(globalMax || 1));
  const next = Math.trunc(effective) + 1;
  return next >= global ? null : next;
}
