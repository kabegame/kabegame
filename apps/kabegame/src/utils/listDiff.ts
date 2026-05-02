export type IdLike = { id: string };

export type DiffByIdResult = {
  addedIds: string[];
  removedIds: string[];
};

/**
 * 基于 id 的差分：用于“事件驱动 + 手动刷新”架构下，刷新后计算新增/删除项并做局部修正。
 *
 * 约定：
 * - id 视为稳定主键（字符串）
 * - 只比较 id，不比较内容
 */
export function diffById<T extends IdLike>(prev: T[], next: T[]): DiffByIdResult {
  const prevIds = new Set(prev.map((x) => x.id));
  const nextIds = new Set(next.map((x) => x.id));

  const removedIds: string[] = [];
  prevIds.forEach((id) => {
    if (!nextIds.has(id)) removedIds.push(id);
  });

  const addedIds: string[] = [];
  nextIds.forEach((id) => {
    if (!prevIds.has(id)) addedIds.push(id);
  });

  return { addedIds, removedIds };
}

