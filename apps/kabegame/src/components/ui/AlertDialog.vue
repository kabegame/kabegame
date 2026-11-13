<template>
  <AlertDialogRoot v-model:open="open">
    <slot name="trigger" />
    <AlertDialogPortal :to="portalTo">
      <AlertDialogOverlay
        data-kb-motion
        class="fixed inset-0 bg-[var(--kb-overlay)] data-[state=open]:animate-[kb-fade-in_160ms_ease-out] data-[state=closed]:animate-[kb-fade-out_120ms_ease-in]"
        :style="{ zIndex }"
      />
      <AlertDialogContent
        data-kb-trap
        data-kb-motion
        class="fixed inset-0 m-auto box-border flex h-fit w-[calc(100vw-32px)] max-w-[420px] flex-col gap-1 rounded-kb-lg bg-kb-surface-raised px-5 pb-4 pt-4.5 text-kb-fg shadow-kb-lg outline-none data-[state=open]:animate-[kb-pop-in_180ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_120ms_ease-in]"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnForeign"
        @interact-outside="keepOpenOnForeign"
        @escape-key-down="(e: KeyboardEvent) => busy && e.preventDefault()"
      >
        <AlertDialogTitle class="m-0 text-[15px] font-600 leading-6">
          <slot name="title">{{ title }}</slot>
        </AlertDialogTitle>
        <AlertDialogDescription class="m-0 whitespace-pre-line text-[13px] leading-[1.65] text-kb-fg-muted">
          <slot>{{ description }}</slot>
        </AlertDialogDescription>
        <div class="mt-4 flex items-center justify-end gap-2">
          <AlertDialogCancel v-if="!hideCancel" as-child>
            <Button :disabled="busy" @click="emit('cancel')">{{ cancelText ?? t("common.cancel") }}</Button>
          </AlertDialogCancel>
          <Button :variant="tone === 'danger' ? 'danger' : 'primary'" :disabled="busy" @click="onConfirm">
            <Spinner v-if="busy" :size="14" />
            {{ confirmText ?? t("common.ok") }}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<script setup lang="ts">
/**
 * 确认框：只能点按钮或按 Esc 关闭（点遮罩不关），焦点默认在「取消」上。
 * action 返回 Promise 时按钮转圈、等它完成再关；抛错不关（调用方自己提示）。
 * 没有 action 时点确定发 confirm 并关闭。
 * 命令式的确认（await 一个结果）用 messageBox.confirm，不用这个组件。
 */
import { ref, watch } from "vue";
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import Button from "./Button.vue";
import Spinner from "./Spinner.vue";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "./compat";

const props = defineProps<{
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  hideCancel?: boolean;
  /** danger：确定按钮用危险色（删除、清空） */
  tone?: "default" | "danger";
  action?: () => unknown;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
const zIndex = useLayerZIndex(open);
usePauseForeignTraps(open); // TODO:[REF_UI] P9 删
const busy = ref(false);

// TODO:[REF_UI] P9 删：从 EP 对话框里打开时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(
  open,
  (value) => {
    if (value) portalTo.value = foreignPortalTarget(document.activeElement);
  },
  { immediate: true },
);

async function onConfirm() {
  if (!props.action) {
    emit("confirm");
    open.value = false;
    return;
  }
  busy.value = true;
  try {
    await props.action();
    open.value = false;
  } catch {
    // 留在对话框里，由 action 自己提示错误
  } finally {
    busy.value = false;
  }
}
</script>
