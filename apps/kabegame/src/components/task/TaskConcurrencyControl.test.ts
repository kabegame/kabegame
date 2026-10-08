import { describe, expect, it } from "vitest";
import { decreasedTaskConcurrency, effectiveTaskConcurrency, increasedTaskConcurrency } from "./taskConcurrency";

describe("TaskConcurrencyControl 并发计算", () => {
  it("跟随全局且到顶时禁用增加所需的 null 语义", () => {
    expect(effectiveTaskConcurrency(null, 5)).toBe(5);
    expect(increasedTaskConcurrency(4, 5)).toBeNull();
  });

  it("减到 1 后不再继续降低", () => {
    expect(decreasedTaskConcurrency(2)).toBe(1);
    expect(decreasedTaskConcurrency(1)).toBe(1);
  });

  it("显式上限不会超过全局生效值", () => {
    expect(effectiveTaskConcurrency(9, 5)).toBe(5);
    expect(increasedTaskConcurrency(2, 5)).toBe(3);
  });
});
