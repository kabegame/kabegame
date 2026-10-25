<template>
  <el-dialog
    :model-value="open"
    :z-index="zIndex"
    :title="title ?? t('albums.confirmDelete')"
    :width="width"
    destroy-on-close
    @update:model-value="
      (v: boolean) => {
        if (!v) emit('close');
      }
    "
  >
    <div style="margin-bottom: 16px">
      <p style="margin-bottom: 8px">{{ message }}</p>
    </div>
    <template #footer>
      <el-button @click="emit('close')">{{ cancelText ?? t("common.cancel") }}</el-button>
      <el-button type="primary" :loading="confirmLoading" @click="emitConfirm">
        {{ confirmText ?? t("common.ok") }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";

interface Props {
  open: boolean;
  zIndex: number;
  message: string;
  /** 以下文案缺省时取当前语言的通用文案 */
  title?: string;
  confirmText?: string;
  cancelText?: string;
  confirmLoading?: boolean;
  width?: string;
}

const props = withDefaults(defineProps<Props>(), {
  confirmLoading: false,
  width: "420px",
});

const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm"): void;
}>();

const { t } = useI18n();

const emitConfirm = async () => {
  if (await guardDesktopOnly("deleteImages", { needSuper: true })) return;
  emit("confirm");
};

let keyHandler: ((e: KeyboardEvent) => void) | null = null;

const removeKeyHandler = () => {
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler);
    keyHandler = null;
  }
};

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      removeKeyHandler();
      return;
    }

    keyHandler = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      emitConfirm();
    };

    nextTick(() => {
      document.addEventListener("keydown", keyHandler!);
    });
  },
);

onBeforeUnmount(() => {
  removeKeyHandler();
});
</script>

<style scoped lang="scss"></style>
