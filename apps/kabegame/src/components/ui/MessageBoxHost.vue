<template>
  <AlertDialogRoot :open="open" @update:open="(value: boolean) => (open = value)">
    <AlertDialogPortal>
      <AlertDialogOverlay
        data-kb-motion
        class="fixed inset-0 bg-[var(--kb-overlay)] data-[state=open]:animate-[kb-fade-in_160ms_ease-out] data-[state=closed]:animate-[kb-fade-out_120ms_ease-in]"
        :style="{ zIndex }"
      />
      <AlertDialogContent
        v-if="current"
        data-kb-trap
        data-kb-motion
        class="fixed inset-0 m-auto box-border flex h-fit w-[calc(100vw-32px)] max-w-[420px] flex-col gap-1 rounded-kb-lg bg-kb-surface-raised px-5 pb-4 pt-4.5 text-kb-fg shadow-kb-lg outline-none data-[state=open]:animate-[kb-pop-in_180ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_120ms_ease-in]"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnToast"
        @interact-outside="keepOpenOnToast"
        @open-auto-focus="onOpenAutoFocus"
      >
        <AlertDialogTitle class="m-0 text-[15px] font-600 leading-6" :class="{ 'sr-only': !current.title }">
          {{ current.title || t("common.confirm") }}
        </AlertDialogTitle>
        <AlertDialogDescription
          v-if="current.options.dangerouslyUseHTMLString"
          class="m-0 text-[13px] leading-[1.65] text-kb-fg-muted [&_b]:font-600 [&_b]:text-kb-fg [&_strong]:font-600 [&_strong]:text-kb-fg"
          v-html="html"
        />
        <AlertDialogDescription v-else class="m-0 whitespace-pre-line text-[13px] leading-[1.65] text-kb-fg-muted">
          {{ current.message }}
        </AlertDialogDescription>

        <div v-if="current.kind === 'prompt'" class="mt-3 flex flex-col gap-1">
          <Input
            ref="inputRef"
            v-model="inputValue"
            :placeholder="current.options.inputPlaceholder"
            :invalid="!!inputError"
            @update:model-value="inputError = ''"
            @keydown.enter.prevent="onConfirm"
          />
          <p v-if="inputError" class="m-0 text-[12px] leading-[1.5] text-kb-danger">{{ inputError }}</p>
        </div>

        <div class="mt-4 flex items-center justify-end gap-2">
          <Button v-if="showCancel" ref="cancelRef" @click="current.settle('cancel')">
            {{ current.options.cancelButtonText ?? t("common.cancel") }}
          </Button>
          <Button ref="confirmRef" :variant="current.options.danger ? 'danger' : 'primary'" @click="onConfirm">
            {{ current.options.confirmButtonText ?? t("common.ok") }}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<script setup lang="ts">
/**
 * messageBox 门面的渲染端（App.vue 挂一份）：同时显示一个请求，关闭动画播完再接下一个。
 * 焦点：确认 / 提醒落在主按钮上，输入框类落在输入框（选中原文）；只能点按钮、Esc、返回键关闭，点遮罩不关。
 */
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import DOMPurify from "dompurify";
import {
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
import Input from "./Input.vue";
import { keepOpenOnToast, useLayerZIndex } from "./layer";
import { messageBoxQueue, type MessageBoxRequest } from "./messageBox";

/** 与 AlertDialogContent 的关闭动画一致，播完再换下一个请求的内容 */
const CLOSE_ANIMATION_MS = 140;

const { t } = useI18n();

const current = shallowRef<MessageBoxRequest | null>(null);
const open = ref(false);
const inputValue = ref("");
const inputError = ref("");
const inputRef = ref<InstanceType<typeof Input> | null>(null);
const confirmRef = ref<{ $el?: HTMLElement } | null>(null);
let switching = false;

useModalBack(open);
const zIndex = useLayerZIndex(open);

const showCancel = computed(() => current.value?.kind !== "alert" && current.value?.options.showCancelButton !== false);
const html = computed(() => DOMPurify.sanitize(current.value?.message ?? ""));

/** 队首变了：正在显示的那个已经结束就关掉，动画播完再显示下一个 */
function sync() {
  const head = messageBoxQueue[0] ?? null;
  if (current.value && head === current.value) return;
  if (current.value && open.value) {
    open.value = false;
    return;
  }
  if (switching) return;
  if (current.value) {
    switching = true;
    window.setTimeout(() => {
      switching = false;
      current.value = null;
      sync();
    }, CLOSE_ANIMATION_MS);
    return;
  }
  if (!head) return;
  current.value = head;
  inputValue.value = head.options.inputValue ?? "";
  inputError.value = "";
  open.value = true;
}

watch(() => messageBoxQueue[0], sync);

// Esc、返回键（useModalBack 直接改 open）都走这里；按钮结束的请求已不在队里，settle 是空操作
watch(open, (value) => {
  if (value) return;
  current.value?.settle("close");
  sync();
});

function onOpenAutoFocus(e: Event) {
  e.preventDefault();
  void nextTick(() => {
    if (current.value?.kind === "prompt") {
      inputRef.value?.focus();
      inputRef.value?.select();
    } else {
      confirmRef.value?.$el?.focus();
    }
  });
}

function onConfirm() {
  const request = current.value;
  if (!request || messageBoxQueue[0] !== request) return;
  if (request.kind === "prompt") {
    const validator = request.options.inputValidator;
    const result = validator ? validator(inputValue.value) : true;
    if (result !== true) {
      inputError.value = typeof result === "string" ? result : (request.options.inputErrorMessage ?? "");
      inputRef.value?.focus();
      return;
    }
  }
  request.settle("confirm", inputValue.value);
}
</script>
