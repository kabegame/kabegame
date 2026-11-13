<template>
  <DialogRoot v-model:open="open">
    <slot name="trigger" />
    <DialogPortal>
      <DialogOverlay
        data-kb-motion
        class="fixed inset-0 bg-[var(--kb-overlay)] data-[state=open]:animate-[kb-fade-in_200ms_ease-out] data-[state=closed]:animate-[kb-fade-out_160ms_ease-in]"
        :style="{ zIndex }"
      />
      <DialogContent
        data-kb-trap
        data-kb-motion
        v-bind="description ? {} : NO_DESCRIPTION"
        :class="[
          'fixed box-border flex flex-col bg-kb-surface-raised text-kb-fg shadow-kb-lg outline-none',
          'data-[state=open]:animate-[kb-slide-in_260ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-slide-out_180ms_ease-in]',
          SIDES[side],
        ]"
        :style="sizeStyle"
        @pointer-down-outside="keepOpenOnToast"
        @focus-outside="keepOpenOnToast"
        @interact-outside="keepOpenOnToast"
      >
        <div v-if="side === 'bottom'" class="mx-auto mb-1 mt-2 h-1 w-9 shrink-0 rounded-full bg-kb-fill-dark" />
        <header
          v-if="title || $slots.title || $slots.actions || !hideClose"
          class="flex shrink-0 items-center gap-2 px-4"
          :class="side === 'bottom' ? 'pb-1 pt-1.5' : 'h-14 border-0 border-b border-solid border-kb-line'"
        >
          <div class="min-w-0 flex-1">
            <DialogTitle class="m-0 truncate text-[15px] font-600 leading-6">
              <slot name="title">{{ title }}</slot>
            </DialogTitle>
            <DialogDescription v-if="description" class="m-0 text-[12.5px] text-kb-fg-muted">
              {{ description }}
            </DialogDescription>
          </div>
          <slot name="actions" />
          <!-- 给末尾的 × 留位 -->
          <span v-if="!hideClose" class="w-6 shrink-0" />
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto" :class="bodyClass ?? 'p-4'">
          <slot />
        </div>
        <footer
          v-if="$slots.footer"
          class="flex shrink-0 items-center justify-end gap-2 border-0 border-t border-solid border-kb-line px-4 py-3"
        >
          <slot name="footer" />
        </footer>
        <!-- 关闭按钮放在最后：打开时自动聚焦落在正文而不是 × 上 -->
        <DialogClose v-if="!hideClose" as-child>
          <Button
            variant="ghost"
            size="icon-sm"
            class="!absolute right-2.5"
            :class="
              side === 'bottom' ? 'top-3' : side === 'top' ? 'top-[calc(env(safe-area-inset-top)+12px)]' : 'top-3.5'
            "
            :aria-label="t('common.close')"
          >
            <X />
          </Button>
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
/**
 * 侧边面板：从右（默认）/ 左 / 上 / 下滑入。底部面板就是 Android 的底部弹层（顶部带把手、
 * 底部让出安全区），取代 van-popup 与 el-drawer。size 是面板在滑入方向上的尺寸：
 * 左右面板是宽度（默认 min(420px, 100vw)），上下面板是最大高度（默认 85vh）。
 * Esc、点遮罩、Android 返回键关闭。
 */
import { computed } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import Button from "./Button.vue";
import { useLayerZIndex, keepOpenOnToast } from "./layer";

type Side = "right" | "left" | "top" | "bottom";

const props = withDefaults(
  defineProps<{
    side?: Side;
    title?: string;
    description?: string;
    /** 数字是 px，也可以给 CSS 长度 */
    size?: number | string;
    hideClose?: boolean;
    /** 正文区的类；默认 p-4 */
    bodyClass?: string;
  }>(),
  { side: "right" },
);

const NO_DESCRIPTION = { "aria-describedby": undefined };

// 滑入方向写成元素上的 --kb-slide-x / --kb-slide-y，关键帧 kb-slide-in / -out 共用（tokens.css）
const SIDES: Record<Side, string> = {
  right: "inset-y-0 right-0 h-full [--kb-slide-x:100%]",
  left: "inset-y-0 left-0 h-full [--kb-slide-x:-100%]",
  top: "inset-x-0 top-0 rounded-b-kb-lg pt-[env(safe-area-inset-top)] [--kb-slide-y:-100%]",
  bottom: "inset-x-0 bottom-0 rounded-t-kb-lg pb-[env(safe-area-inset-bottom)] [--kb-slide-y:100%]",
};

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
const zIndex = useLayerZIndex(open);

const sizeStyle = computed(() => {
  const size = typeof props.size === "number" ? `${props.size}px` : props.size;
  const horizontal = props.side === "left" || props.side === "right";
  return horizontal
    ? { zIndex: zIndex.value, width: size ?? "min(420px, 100vw)", maxWidth: "100vw" }
    : { zIndex: zIndex.value, maxHeight: size ?? "85vh" };
});
</script>
