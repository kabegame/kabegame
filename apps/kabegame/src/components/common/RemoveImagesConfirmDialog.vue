<template>
  <Dialog
    :open="open"
    :title="title ?? t('albums.confirmDelete')"
    :width="width"
    @update:open="
      (v: boolean) => {
        if (!v) emit('close');
      }
    "
  >
    <p class="m-0 text-[13px] leading-[1.65] text-kb-fg">{{ message }}</p>
    <template #footer>
      <Button @click="emit('close')">{{ cancelText ?? t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="confirmLoading" @click="emitConfirm">
        <Spinner v-if="confirmLoading" :size="14" />
        {{ confirmText ?? t("common.ok") }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { Button, Dialog, Spinner } from "@/components/ui";

interface Props {
  open: boolean;
  message: string;
  /** 以下文案缺省时取当前语言的通用文案 */
  title?: string;
  confirmText?: string;
  cancelText?: string;
  confirmLoading?: boolean;
  /** 最大宽度：数字是 px，也可以给 CSS 长度 */
  width?: number | string;
}

const props = withDefaults(defineProps<Props>(), {
  confirmLoading: false,
  width: 420,
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
