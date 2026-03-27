<template>
  <div class="headers-editor">
    <div v-for="(row, idx) in rows" :key="idx" class="header-row">
      <el-input v-model="row.key" :placeholder="$t('plugins.headerNamePlaceholder')" @input="emitValue" />
      <el-input v-model="row.value" :placeholder="$t('plugins.headerValuePlaceholder')" @input="emitValue" />
      <el-button type="danger" link @click="removeRow(idx)">{{ $t("plugins.delete") }}</el-button>
    </div>
    <div class="header-actions">
      <el-button size="small" @click="addRow">{{ $t("plugins.addHeader") }}</el-button>
    </div>
    <div v-if="showHint" class="config-hint">
      {{ $t("plugins.httpHeadersHint") }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

type HeaderRow = { key: string; value: string };

const props = withDefaults(
  defineProps<{
    modelValue?: Record<string, string>;
    showHint?: boolean;
  }>(),
  { showHint: true },
);

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, string>];
}>();

const rows = ref<HeaderRow[]>([]);

const fromMap = (value?: Record<string, string>): HeaderRow[] =>
  Object.entries(value ?? {}).map(([key, v]) => ({ key, value: v ?? "" }));

const toMap = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const row of rows.value) {
    const k = row.key.trim();
    if (!k) continue;
    out[k] = row.value ?? "";
  }
  return out;
};

const emitValue = () => {
  emit("update:modelValue", toMap());
};

const addRow = () => {
  rows.value.push({ key: "", value: "" });
};

const removeRow = (idx: number) => {
  rows.value.splice(idx, 1);
  emitValue();
};

watch(
  () => props.modelValue,
  (value) => {
    rows.value = fromMap(value);
  },
  { immediate: true, deep: true },
);
</script>

<style scoped lang="scss">
.headers-editor {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.header-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.config-hint {
  font-size: 12px;
  color: var(--anime-text-secondary);
  margin-top: 4px;
}
</style>
