/**
 * Field 与控件之间的约定：Field 提供 id / 是否出错 / 说明文字的 id，控件（Input、Select……）
 * 注入后自动设到自己的可聚焦元素上，调用方不用手动对 id。没有包在 Field 里时控件照常工作。
 */
import { computed, inject, type ComputedRef, type InjectionKey } from "vue";

export interface FieldContext {
  id: string;
  invalid: ComputedRef<boolean>;
  describedBy: ComputedRef<string | undefined>;
}

export const FIELD_KEY: InjectionKey<FieldContext> = Symbol("kbField");

/** 控件用：拿 Field 的 id 与出错状态；props.id / props.invalid 优先 */
export function useFieldControl(props: { id?: string; invalid?: boolean }) {
  const field = inject(FIELD_KEY, null);
  return {
    id: computed(() => props.id ?? field?.id),
    invalid: computed(() => props.invalid || field?.invalid.value || false),
    describedBy: computed(() => field?.describedBy.value),
  };
}
