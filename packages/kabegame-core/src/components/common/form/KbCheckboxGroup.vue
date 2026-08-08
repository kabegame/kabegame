<template>
  <!-- 全选与已选计数渲染在 el-form-item 的 label 行（见 PluginVarsForm），这里只负责选项本体 -->
  <div class="var-checkbox-group-field">
    <button
      v-for="opt in normalizedOptions"
      :key="opt.value"
      type="button"
      class="var-checkbox-group-field__tag"
      :class="{ 'is-on': valueForGroup.includes(opt.value) }"
      @click="toggleOne(opt.value)"
    >
      <span class="var-checkbox-group-field__check">
        <template v-if="valueForGroup.includes(opt.value)">✓</template>
      </span>
      {{ opt.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

type VarOption = string | { name: string | Record<string, string>; variable: string };

const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    options?: VarOption[];
    allowUnset?: boolean;
  }>(),
  { allowUnset: false }
);

const emit = defineEmits<{
  "update:modelValue": [value: string[]];
}>();

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
    .filter((o) => typeof o.value === "string" && o.value.trim() !== "");
});

const valueForGroup = computed<string[]>(() => {
  return Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map((x) => `${x}`) : [];
});

function toggleOne(value: string) {
  const sel = valueForGroup.value;
  const next = sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value];
  emit("update:modelValue", next);
}
</script>

<style scoped>
/* 容器风格对齐 KbSegmentedControl（同底色/圆角/内距），同一行里两种控件才像一家人；
   区别是多选可换行，选项多时限高滚动 */
.var-checkbox-group-field {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--anime-primary) 9%, transparent);
  width: fit-content;
  max-width: 100%;
  max-height: min(40vh, 120px);
  overflow-y: auto;
}

.var-checkbox-group-field__tag {
  appearance: none;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 13px;
  border: none;
  border-radius: 9px;
  margin: 0;
  background: transparent;
  color: var(--anime-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  transition: color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
}
.var-checkbox-group-field__tag:not(.is-on):hover {
  color: var(--anime-primary);
}
.var-checkbox-group-field__tag.is-on {
  background: linear-gradient(135deg, var(--anime-primary), var(--anime-secondary));
  color: #fff;
  font-weight: 600;
  box-shadow: 0 3px 10px rgba(255, 107, 157, 0.3);
}
/* 固定宽度勾选槽：选中/未选中切换时按钮不跳宽 */
.var-checkbox-group-field__check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  margin-right: 4px;
}

</style>
