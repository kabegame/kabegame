<template>
  <el-date-picker
    :key="pickerKey"
    class="var-date-field"
    :model-value="modelValueForPicker"
    type="date"
    :placeholder="placeholder"
    :clearable="allowUnset"
    :value-format="PLUGIN_DATE_PICKER_FORMAT"
    :disabled-date="disabledDate"
    style="width: 100%"
    @update:model-value="onUpdate"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useNow } from "@vueuse/core";
import dayjs from "dayjs";
import {
  PLUGIN_DATE_PICKER_FORMAT,
  parsePluginDateBound,
  parsePluginDateStored,
} from "../../../utils/pluginDateVar";

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    placeholder?: string;
    allowUnset?: boolean;
    /**
     * 提交给后端/脚本的日期格式（dayjs 格式串，如 YYYYMMDD）。
     * 未设置时与选择器一致，为 YYYY-MM-DD。
     */
    dateStorageFormat?: string;
    /** 可选：最早可选日：`YYYY-MM-DD` 或 `today` / `yesterday` */
    dateMin?: string;
    /** 可选：最晚可选日：`YYYY-MM-DD` 或 `today` / `yesterday` */
    dateMax?: string;
  }>(),
  { allowUnset: false, dateStorageFormat: PLUGIN_DATE_PICKER_FORMAT }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

/** 含 today/yesterday 时需随自然日刷新禁用日与面板 */
const usesRelativeBounds = computed(() => {
  const rel = (s?: string) => {
    const x = (s ?? "").trim().toLowerCase();
    return x === "today" || x === "yesterday";
  };
  return rel(props.dateMin) || rel(props.dateMax);
});

/** 每分钟推进一次，跨日最多约 1 分钟内与「今天」对齐 */
const clock = useNow({ interval: 60_000 });

const pickerKey = computed(() =>
  usesRelativeBounds.value
    ? `rel-${dayjs(clock.value).format("YYYY-MM-DD")}`
    : "fixed"
);

const modelValueForPicker = computed(() => {
  const v = props.modelValue;
  if (typeof v !== "string") return undefined;
  const d = parsePluginDateStored(v, props.dateStorageFormat);
  if (!d) return undefined;
  return d.format(PLUGIN_DATE_PICKER_FORMAT);
});

function disabledDate(d: Date) {
  const day = dayjs(d).startOf("day");
  const refNow = usesRelativeBounds.value ? clock.value : undefined;
  if (props.dateMin && props.dateMin.trim() !== "") {
    const min =
      refNow !== undefined
        ? parsePluginDateBound(props.dateMin, refNow)
        : parsePluginDateBound(props.dateMin);
    if (min && day.isBefore(min, "day")) return true;
  }
  if (props.dateMax && props.dateMax.trim() !== "") {
    const max =
      refNow !== undefined
        ? parsePluginDateBound(props.dateMax, refNow)
        : parsePluginDateBound(props.dateMax);
    if (max && day.isAfter(max, "day")) return true;
  }
  return false;
}

function onUpdate(val: string | null | undefined) {
  if (val == null || val === "") {
    emit("update:modelValue", "");
    return;
  }
  const picked = dayjs(val, PLUGIN_DATE_PICKER_FORMAT, true);
  if (!picked.isValid()) {
    emit("update:modelValue", "");
    return;
  }
  emit("update:modelValue", picked.format(props.dateStorageFormat));
}
</script>
