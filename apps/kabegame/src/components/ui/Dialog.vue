<template>
  <DialogRoot v-model:open="open">
    <slot name="trigger" />
    <DialogPortal :to="portalTo">
      <DialogOverlay
        data-kb-motion
        class="fixed inset-0 bg-[var(--kb-overlay)] data-[state=open]:animate-[kb-fade-in_160ms_ease-out] data-[state=closed]:animate-[kb-fade-out_120ms_ease-in]"
        :style="{ zIndex }"
      />
      <DialogContent
        data-kb-trap
        data-kb-motion
        v-bind="description ? {} : NO_DESCRIPTION"
        class="fixed inset-0 m-auto box-border flex h-fit max-h-[min(85vh,calc(100vh-32px))] w-[calc(100vw-32px)] flex-col rounded-kb-lg bg-kb-surface-raised text-kb-fg shadow-kb-lg outline-none data-[state=open]:animate-[kb-pop-in_180ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_120ms_ease-in]"
        :style="{ zIndex, maxWidth: typeof width === 'number' ? `${width}px` : width }"
        @pointer-down-outside="onPointerDownOutside"
        @focus-outside="keepOpenOnForeign"
        @interact-outside="keepOpenOnForeign"
        @escape-key-down="(e: KeyboardEvent) => !closeOnEsc && e.preventDefault()"
        @open-auto-focus="(e: Event) => emit('openAutoFocus', e)"
        @close-auto-focus="onCloseAutoFocus"
      >
        <header
          v-if="title || $slots.title"
          class="flex shrink-0 items-start gap-3 px-5 pb-1 pt-4"
          :class="hideClose ? '' : 'pr-12'"
        >
          <div class="min-w-0 flex-1">
            <DialogTitle class="m-0 text-[15px] font-600 leading-6 text-kb-fg">
              <slot name="title">{{ title }}</slot>
            </DialogTitle>
            <DialogDescription v-if="description" class="m-0 mt-0.5 text-[12.5px] leading-[1.6] text-kb-fg-muted">
              {{ description }}
            </DialogDescription>
          </div>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3" :class="bodyClass">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex shrink-0 items-center justify-end gap-2 px-5 pb-4 pt-2">
          <slot name="footer" />
        </footer>
        <!-- 关闭按钮放在最后：打开时自动聚焦的是第一个可聚焦元素，应落在正文而不是 × 上 -->
        <DialogClose v-if="!hideClose" as-child>
          <Button variant="ghost" size="icon-sm" class="!absolute right-3 top-3.5" :aria-label="t('common.close')">
            <X />
          </Button>
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
/**
 * 对话框：标题 + 正文（滚动）+ 底部操作（#footer）。用 v-model:open 控制；
 * Esc、点遮罩、右上角 × 关闭；Android 返回键也关（useModalBack，调用方不要再套 useModal）。
 *
 *   <Dialog v-model:open="show" :title="t('x')" :width="520">
 *     …
 *     <template #footer><Button @click="show = false">取消</Button><Button variant="primary">确定</Button></template>
 *   </Dialog>
 *
 * 需要一个触发器时放进 #trigger：<template #trigger><DialogTrigger as-child><Button/></DialogTrigger></template>。
 */
import { ref, watch } from "vue";
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
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "./compat";

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    /** 最大宽度：数字是 px，也可以给 CSS 长度；窄屏时两侧各留 16px */
    width?: number | string;
    hideClose?: boolean;
    /** 点遮罩关闭 */
    closeOnOverlay?: boolean;
    closeOnEsc?: boolean;
    /** 正文区额外的类（如去掉内边距） */
    bodyClass?: string;
  }>(),
  { width: 480, closeOnOverlay: true, closeOnEsc: true },
);

// 没有说明文字时显式声明 aria-describedby 为空（Reka 否则会在控制台警告缺少 Description）
const NO_DESCRIPTION = { "aria-describedby": undefined };

const emit = defineEmits<{ openAutoFocus: [Event]; closeAutoFocus: [Event] }>();
const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
const zIndex = useLayerZIndex(open);
usePauseForeignTraps(open); // TODO:[REF_UI] P9 删

// TODO:[REF_UI] P9 删：从 EP 对话框里打开时挂进那个对话框，免得 EP 的焦点陷阱把焦点抢回去。
const portalTo = ref<HTMLElement | undefined>();
watch(
  open,
  (value) => {
    if (value) portalTo.value = foreignPortalTarget(document.activeElement);
  },
  { immediate: true },
);

function onPointerDownOutside(e: Event) {
  if (!props.closeOnOverlay) e.preventDefault();
  else keepOpenOnForeign(e);
}

function onCloseAutoFocus(e: Event) {
  emit("closeAutoFocus", e);
}
</script>
