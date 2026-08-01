<template>
  <div class="var-checkbox-group-field">
    <div v-if="optionValues.length > 0" class="var-checkbox-group-field__count">
      {{ selectedInOptionsCount }}/{{ optionValues.length }}
    </div>
    <div class="var-checkbox-group-field__box">
      <button
        v-if="normalizedOptions.length > 1"
        type="button"
        class="var-checkbox-group-field__tag is-all"
        :class="{ 'is-indeterminate': isIndeterminate }"
        @click="onToggleAll(!allOptionsSelected)"
      >
        <span class="var-checkbox-group-field__dash"></span>
        {{ t("plugins.pluginVarSelectAll") }}
      </button>
      <button
        v-for="opt in normalizedOptions"
        :key="opt.value"
        type="button"
        class="var-checkbox-group-field__tag"
        :class="{ 'is-on': valueForGroup.includes(opt.value) }"
        @click="toggleOne(opt.value)"
      >
        <span v-if="valueForGroup.includes(opt.value)">✓ </span>{{ opt.label }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";

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

const { t } = useI18n();

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

const optionValues = computed(() => normalizedOptions.value.map((o) => o.value));

const allOptionsSelected = computed(() => {
  const vals = optionValues.value;
  const sel = valueForGroup.value;
  return vals.length > 0 && vals.every((v) => sel.includes(v));
});

const isIndeterminate = computed(() => {
  const vals = optionValues.value;
  const sel = valueForGroup.value;
  const n = vals.filter((v) => sel.includes(v)).length;
  return n > 0 && n < vals.length;
});

const selectedInOptionsCount = computed(() => {
  const vals = optionValues.value;
  const sel = valueForGroup.value;
  return vals.filter((v) => sel.includes(v)).length;
});

function onToggleAll(checked: boolean) {
  const vals = optionValues.value;
  if (vals.length === 0) return;
  emit("update:modelValue", checked ? [...vals] : []);
}

function toggleOne(value: string) {
  const sel = valueForGroup.value;
  const next = sel.includes(value) ? sel.filter((v) => v !== value) : [...sel, value];
  emit("update:modelValue", next);
}
</script>

<style scoped>
.var-checkbox-group-field {
  width: 100%;
}

.var-checkbox-group-field__count {
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.var-checkbox-group-field__box {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  max-height: min(40vh, 120px);
  overflow-y: auto;
  padding: 2px;
}

.var-checkbox-group-field__tag {
  appearance: none;
  height: 26px;
  padding: 0 11px;
  border: none;
  border-radius: 9px;
  margin: 0;
  background: color-mix(in srgb, var(--anime-primary) 6%, transparent);
  color: var(--anime-text-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  white-space: nowrap;
}
.var-checkbox-group-field__tag:hover {
  background: color-mix(in srgb, var(--anime-primary) 14%, transparent);
}
.var-checkbox-group-field__tag.is-on {
  background: linear-gradient(90deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  color: #fff;
  font-weight: 600;
}
.var-checkbox-group-field__tag.is-on:hover {
  background: linear-gradient(90deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
}
.var-checkbox-group-field__tag.is-all {
  background: #fff;
  border: 1px dashed var(--anime-secondary);
  color: var(--anime-text-secondary);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.var-checkbox-group-field__tag.is-all.is-indeterminate {
  border-style: solid;
}
.var-checkbox-group-field__dash {
  width: 9px;
  height: 2px;
  background: var(--anime-text-secondary);
  border-radius: 1px;
}
</style>
