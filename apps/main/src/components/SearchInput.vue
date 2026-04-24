<template>
  <el-input
    v-model="local"
    size="small"
    clearable
    :prefix-icon="Search"
    :placeholder="placeholder"
    class="search-input"
    @keyup.enter="commit"
    @blur="commit"
    @clear="commitImmediate('')"
  />
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { Search } from "@element-plus/icons-vue";
import { IS_WEB } from "@kabegame/core/env";

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const local = ref(props.modelValue ?? "");

watch(
  () => props.modelValue,
  (v) => {
    if ((v ?? "") !== local.value) local.value = v ?? "";
  }
);

let debounceTimer: number | null = null;

function clearDebounce() {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function commitImmediate(value: string) {
  clearDebounce();
  if ((props.modelValue ?? "") !== value) {
    emit("update:modelValue", value);
  }
}

function commit() {
  commitImmediate(local.value);
}

// 桌面端：输入 300ms 防抖后提交；web 端只在回车/失焦/清空时提交。
if (!IS_WEB) {
  watch(local, (v) => {
    clearDebounce();
    // 清空立即触发，避免等 300ms 才撤销过滤
    if (!v) {
      commitImmediate("");
      return;
    }
    debounceTimer = window.setTimeout(() => {
      commitImmediate(v);
    }, 300);
  });
}

onBeforeUnmount(clearDebounce);
</script>

<style scoped lang="scss">
.search-input {
  width: 220px;
}
</style>
