<template>
  <div class="flex w-full flex-col gap-2">
    <div v-for="(row, idx) in rows" :key="idx" class="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
      <Input v-model="row.key" :placeholder="$t('plugins.headerNamePlaceholder')" @input="emitValue" />
      <Input v-model="row.value" :placeholder="$t('plugins.headerValuePlaceholder')" @input="emitValue" />
      <Tooltip :content="$t('plugins.delete')">
        <Button variant="ghost-danger" size="icon" :aria-label="$t('plugins.delete')" @click="removeRow(idx)">
          <Trash2 />
        </Button>
      </Tooltip>
    </div>
    <div>
      <Button variant="outline" size="sm" @click="addRow">
        <Plus />
        {{ $t("plugins.addHeader") }}
      </Button>
    </div>
    <p v-if="showHint" class="m-0 text-[12px] leading-[1.55] text-kb-fg-muted">
      {{ $t("plugins.httpHeadersHint") }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { Plus, Trash2 } from "@lucide/vue";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import Tooltip from "@/components/ui/Tooltip.vue";

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
