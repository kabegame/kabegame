<template>
  <div class="var-multi">
    <span
      v-for="(item, idx) in currentList"
      :key="`${item}-${idx}`"
      class="var-multi__pill"
      :class="{ 'is-custom': !knownValues.has(item) }"
    >
      {{ item }}
      <span class="var-multi__pill-x" @click="removeAt(idx)">×</span>
    </span>
    <el-select
      v-model="addSelectValue"
      class="var-multi__add"
      filterable
      allow-create
      default-first-option
      :placeholder="currentList.length ? '' : placeholder"
      clearable
      @change="onAddSelect"
    >
      <el-option v-for="opt in normalizedOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
    </el-select>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

type VarOption = string | { name: string | Record<string, string>; variable: string };

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options?: VarOption[];
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false }
);

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

const addSelectValue = ref<string | null>(null);

function optionLabel(o: VarOption): string {
  if (typeof o === "string") return o;
  if (typeof o.name === "string") return o.name;
  if (o.name && typeof o.name === "object") return (o.name as Record<string, string>).default ?? "";
  return "";
}

const normalizedOptions = computed(() => {
  const opts = props.options || [];
  return opts
    .map((o) => {
      if (typeof o === "string") return { label: o, value: o };
      return { label: optionLabel(o), value: o.variable };
    })
    .filter((o) => typeof o.value === "string" && (o.value as string).trim() !== "");
});

const currentList = computed<string[]>(() => {
  return Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map((x) => `${x}`.trim()).filter(Boolean) : [];
});

/** 区分「插件预设选项」与「用户手打新增」，后者用虚线 pill 标出 */
const knownValues = computed(() => new Set(normalizedOptions.value.map((o) => o.value)));

function removeAt(index: number) {
  const next = currentList.value.slice();
  next.splice(index, 1);
  emit("update:modelValue", next);
}

function onAddSelect(value: string | null) {
  if (value == null || String(value).trim() === "") return;
  const trimmed = String(value).trim();
  const next = [...currentList.value];
  if (!next.includes(trimmed)) {
    next.push(trimmed);
    emit("update:modelValue", next);
  }
  addSelectValue.value = null;
}
</script>

<style scoped>
.var-multi {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  background: #fff;
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}
.var-multi:focus-within {
  border-color: var(--anime-primary);
  box-shadow: 0 0 0 2px rgba(255, 107, 157, 0.2);
}

/* 与下拉面板里 el-select 的多选 tag 同源：同一组 --el-select-option-* 配色，
   只是这里的 pill 渲染在触发器外面 */
.var-multi__pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 5px 0 9px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--anime-primary) 10%, transparent);
  color: var(--anime-primary-dark);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  max-width: 100%;
}
.var-multi__pill.is-custom {
  border: 1px dashed var(--anime-secondary);
  background: rgba(167, 139, 250, 0.14);
  color: var(--anime-text-secondary);
}
.var-multi__pill-x {
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  color: inherit;
  opacity: 0.75;
}
.var-multi__pill-x:hover {
  opacity: 1;
}

.var-multi__add {
  flex: 1;
  min-width: 80px;
}
.var-multi__add :deep(.el-select__wrapper) {
  box-shadow: none !important;
  padding: 0 4px;
  min-height: 24px;
  background: transparent;
}
</style>
