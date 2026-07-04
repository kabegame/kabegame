<template>
  <div class="var-checkbox-group-field">
    <div v-if="optionValues.length > 0" class="var-checkbox-group-field__toolbar">
      <div class="var-checkbox-group-field__toolbar-left">
        <el-checkbox
          v-if="normalizedOptions.length > 1"
          class="var-checkbox-group-field__all"
          :indeterminate="isIndeterminate"
          :model-value="allOptionsSelected"
          @change="onToggleAll"
        >
          {{ t("plugins.pluginVarSelectAll") }}
        </el-checkbox>
      </div>
      <span class="var-checkbox-group-field__count">
        {{ selectedInOptionsCount }}/{{ optionValues.length }}
      </span>
    </div>
    <div class="var-checkbox-group-field__scroll">
      <el-checkbox-group
        :model-value="valueForGroup"
        @update:model-value="emit('update:modelValue', $event)"
      >
        <el-checkbox v-for="opt in normalizedOptions" :key="opt.value" :label="opt.value">
          {{ opt.label }}
        </el-checkbox>
      </el-checkbox-group>
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

function onToggleAll(checked: boolean | string | number) {
  const vals = optionValues.value;
  if (vals.length === 0) return;
  emit("update:modelValue", checked ? [...vals] : []);
}
</script>

<style scoped>
.var-checkbox-group-field {
  width: 100%;
}

.var-checkbox-group-field__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.var-checkbox-group-field__toolbar-left {
  min-width: 0;
  flex: 1;
}

.var-checkbox-group-field__all {
  display: flex;
}

.var-checkbox-group-field__count {
  flex-shrink: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.var-checkbox-group-field__scroll {
  max-height: min(40vh, 80px);
  overflow-y: auto;
  padding-right: 4px;
}
</style>
