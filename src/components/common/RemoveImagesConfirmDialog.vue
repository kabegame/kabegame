<template>
  <el-dialog v-model="visible" :title="title" :width="width" destroy-on-close>
    <div style="margin-bottom: 16px;">
      <p style="margin-bottom: 8px;">{{ message }}</p>
      <el-checkbox v-model="deleteFiles" :label="checkboxLabel" />
      <p class="var-description" :style="{ color: deleteFiles ? 'var(--el-color-danger)' : '' }">
        {{ deleteFiles ? dangerText : safeText }}
      </p>
    </div>
    <template #footer>
      <el-button @click="visible = false">{{ cancelText }}</el-button>
      <el-button type="primary" :loading="confirmLoading" @click="emitConfirm">{{ confirmText }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, watch } from "vue";

interface Props {
  modelValue: boolean;
  deleteFiles: boolean;
  message: string;
  title?: string;
  checkboxLabel?: string;
  dangerText?: string;
  safeText?: string;
  confirmText?: string;
  cancelText?: string;
  confirmLoading?: boolean;
  width?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: "确认删除",
  checkboxLabel: "同时从电脑删除源文件（慎用）",
  dangerText: "警告：该操作将永久删除电脑文件，不可恢复！",
  safeText: "不勾选仅从列表移除记录，保留电脑文件。",
  confirmText: "确定",
  cancelText: "取消",
  confirmLoading: false,
  width: "420px",
});

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "update:deleteFiles", v: boolean): void;
  (e: "confirm"): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

const deleteFiles = computed({
  get: () => props.deleteFiles,
  set: (v) => emit("update:deleteFiles", v),
});

const emitConfirm = () => {
  emit("confirm");
};

let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const removeKeyHandler = () => {
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
};

watch(visible, (isOpen) => {
  if (!isOpen) {
    removeKeyHandler();
    return;
  }

  keyHandler = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    // 如果焦点在复选框 input 上，不触发确认（允许空格切换）
    const activeElement = document.activeElement;
    if (activeElement?.tagName === "INPUT" && (activeElement as HTMLInputElement).type === "checkbox") return;
    e.preventDefault();
    emitConfirm();
  };

  nextTick(() => {
    document.addEventListener("keydown", keyHandler!);
  });
});

onBeforeUnmount(() => {
  removeKeyHandler();
});
</script>

<style scoped lang="scss"></style>


