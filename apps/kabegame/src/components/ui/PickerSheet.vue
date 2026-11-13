<template>
  <Sheet v-model:open="open" side="bottom" :title="title" hide-close body-class="px-3 pb-3">
    <template #actions>
      <Button variant="primary" size="sm" @click="confirm">{{ confirmText ?? t("common.confirm") }}</Button>
    </template>
    <div class="flex gap-1">
      <WheelColumn
        v-for="(column, index) in resolvedColumns"
        :key="index"
        :ref="(el) => setColumnRef(index, el)"
        :options="column"
        :aria-label="title"
        :model-value="model[index]"
        @update:model-value="(value) => onColumnChange(index, value as V)"
      />
    </div>
  </Sheet>
</template>

<script setup lang="ts" generic="V extends string | number">
/**
 * 底部滚轮选择：Sheet（底部）里放一到多列滚轮（WheelColumn）。标题在 Sheet 顶部，右侧是「确定」；
 * 取消就是关闭（点遮罩、Esc、Android 返回键）。v-model:open 控制开合，v-model 是各列选中的值（滚动停稳即更新），
 * 确定时发 confirm 并关闭。
 *
 * columns 的三种写法（同原来的 van-picker）：
 * - 单列：选项数组 `[{ text, value }, …]`；
 * - 多列：列数组 `[[…], […]]`；
 * - 级联：带 children 的选项数组，后一列的选项取前一列选中项的 children。
 * 界面重构 P9 起取代 van-picker（滚轮没有无头对应物，Vant 只剩这一处，自己写了以便删掉 Vant）。
 */
import { computed, type ComponentPublicInstance } from "vue";
import { useI18n } from "@kabegame/i18n";
import Button from "./Button.vue";
import Sheet from "./Sheet.vue";
import WheelColumn, { type WheelOption } from "./WheelColumn.vue";

export interface PickerOption<T = string | number> extends WheelOption<T> {
  children?: PickerOption<T>[];
}

export interface PickerConfirmParams<T = string | number> {
  selectedValues: T[];
  selectedOptions: PickerOption<T>[];
  selectedIndexes: number[];
}

const props = defineProps<{
  title?: string;
  columns: (PickerOption<V> | PickerOption<V>[])[];
  confirmText?: string;
}>();

const emit = defineEmits<{ confirm: [params: PickerConfirmParams<V>] }>();
const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });
const model = defineModel<V[]>({ default: () => [] });

const columnRefs: ({ settle: () => V | undefined } | null)[] = [];
function setColumnRef(index: number, el: Element | ComponentPublicInstance | null) {
  columnRefs[index] = el as unknown as { settle: () => V | undefined } | null;
}

/** 按给定的值解出各列（级联时后一列取决于前一列的选中项）；值不在列里时按第一项算 */
function resolve(values: V[]): { columns: PickerOption<V>[][]; selected: PickerOption<V>[]; indexes: number[] } {
  const first = props.columns[0];
  const columns: PickerOption<V>[][] = [];
  const selected: PickerOption<V>[] = [];
  const indexes: number[] = [];
  const pick = (column: PickerOption<V>[], i: number) => {
    const index = Math.max(
      0,
      column.findIndex((o) => o.value === values[i]),
    );
    columns.push(column);
    indexes.push(index);
    if (column[index]) selected.push(column[index]);
    return column[index];
  };
  if (Array.isArray(first)) {
    (props.columns as PickerOption<V>[][]).forEach((column, i) => pick(column, i));
  } else if (isCascade.value) {
    let column: PickerOption<V>[] | undefined = props.columns as PickerOption<V>[];
    for (let i = 0; column && column.length > 0; i++) column = pick(column, i)?.children;
  } else {
    pick(props.columns as PickerOption<V>[], 0);
  }
  return { columns, selected, indexes };
}

const resolvedColumns = computed(() => resolve(model.value).columns);
const isCascade = computed(() => {
  const first = props.columns[0];
  return !Array.isArray(first) && !!first?.children;
});

function onColumnChange(index: number, value: V) {
  const next = [...model.value];
  next[index] = value;
  // 级联：前面一列换了，后面各列落到仍然存在的值或第一项
  model.value = resolve(next).selected.map((o) => o.value);
}

// 惯性还没停时点确定：先按各列此刻的位置取值（级联时前一列变了，后面的列已按规则重排，不再取）
function confirm() {
  for (let i = 0; i < resolvedColumns.value.length; i++) {
    const before = model.value[i];
    const value = columnRefs[i]?.settle();
    if (isCascade.value && value !== undefined && value !== before) break;
  }
  const { selected, indexes } = resolve(model.value);
  const selectedValues = selected.map((o) => o.value);
  model.value = selectedValues;
  open.value = false;
  emit("confirm", { selectedValues, selectedOptions: selected, selectedIndexes: indexes });
}
</script>
