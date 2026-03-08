<template>
  <div class="var-list-tags">
    <div v-if="currentList.length > 0" class="var-list-tags__list">
      <el-tag
        v-for="(item, idx) in currentList"
        :key="`${item}-${idx}`"
        closable
        size="default"
        class="var-list-tags__tag"
        @close="removeAt(idx)"
      >
        {{ item }}
      </el-tag>
    </div>
    <div class="var-list-tags__add">
      <el-select
        v-model="addSelectValue"
        filterable
        allow-create
        default-first-option
        :placeholder="placeholder"
        style="width: 100%"
        clearable
        @change="onAddSelect"
      >
        <el-option v-for="opt in normalizedOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
      </el-select>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

type VarOption = string | { name: string; variable: string };

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

const normalizedOptions = computed(() => {
  const opts = props.options || [];
  return opts
    .map((o) => {
      if (typeof o === "string") return { label: o, value: o };
      return { label: o.name, value: o.variable };
    })
    .filter((o) => typeof o.value === "string" && (o.value as string).trim() !== "");
});

const currentList = computed<string[]>(() => {
  return Array.isArray(props.modelValue) ? (props.modelValue as unknown[]).map((x) => `${x}`.trim()).filter(Boolean) : [];
});

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
.var-list-tags {
  width: 100%;
}
.var-list-tags__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.var-list-tags__tag {
  max-width: 100%;
}
.var-list-tags__add {
  width: 100%;
}
</style>
