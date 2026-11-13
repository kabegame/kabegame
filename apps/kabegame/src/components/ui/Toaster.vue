<template>
  <ToastProvider swipe-direction="up" :duration="3000">
    <ToastRoot
      v-for="entry in toastEntries"
      :key="entry.id"
      :open="entry.open"
      :duration="entry.duration"
      :type="entry.type === 'error' ? 'foreground' : 'background'"
      data-kb-toast
      data-kb-motion
      class="pointer-events-auto box-border flex min-h-10 max-w-[min(480px,calc(100vw-32px))] items-center gap-2.5 rounded-kb-lg bg-kb-surface-raised py-2 pl-3 pr-1.5 text-[13px] leading-[1.5] text-kb-fg shadow-kb-pop data-[state=open]:animate-[kb-toast-in_180ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-toast-out_140ms_ease-in] data-[swipe=move]:translate-y-[var(--reka-toast-swipe-move-y)] data-[swipe=cancel]:translate-y-0 data-[swipe=cancel]:transition-transform data-[swipe=end]:animate-[kb-toast-out_120ms_ease-in]"
      @update:open="(open) => !open && closeToast(entry.id)"
    >
      <component :is="ICONS[entry.type]" class="size-4 shrink-0" :class="TONES[entry.type]" />
      <ToastDescription class="min-w-0 flex-1 break-words">{{ entry.text }}</ToastDescription>
      <ToastClose as-child>
        <Button variant="ghost" size="icon-xs" :aria-label="t('common.close')">
          <X />
        </Button>
      </ToastClose>
    </ToastRoot>
    <ToastViewport
      data-kb-toast
      class="fixed left-1/2 top-[calc(12px+env(safe-area-inset-top))] m-0 box-border flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 list-none flex-col items-center gap-2 p-0 outline-none"
      :style="{ zIndex: toastZIndex }"
    />
  </ToastProvider>
</template>

<script setup lang="ts">
/**
 * 提示消息的渲染处：App.vue 挂一份。推消息用 toast.ts 的 `toast`。
 * 顶部居中、从上方落下；可上滑关闭；错误提示读屏时立即播报（foreground）。
 */
import { ToastClose, ToastDescription, ToastProvider, ToastRoot, ToastViewport } from "reka-ui";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import Button from "./Button.vue";
import { closeToast, toastEntries, toastZIndex, type ToastType } from "./toast";

const { t } = useI18n();

const ICONS = { success: CircleCheck, info: Info, warning: TriangleAlert, error: CircleX } as const;
const TONES: Record<ToastType, string> = {
  success: "text-kb-success",
  info: "text-kb-fg-muted",
  warning: "text-kb-warning",
  error: "text-kb-danger",
};
</script>
