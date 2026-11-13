<template>
  <PopoverRoot v-model:open="open" :modal="false">
    <PopoverTrigger ref="triggerRef" as-child>
      <slot />
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        :side="side"
        :align="align"
        :side-offset="6"
        :collision-padding="8"
        :reference="reference"
        class="box-border w-max max-w-[min(280px,calc(100vw-32px))] rounded-kb-lg bg-kb-surface-raised p-3 text-kb-fg shadow-kb-pop outline-none origin-[var(--reka-popover-content-transform-origin)] data-[state=open]:animate-[kb-pop-in_140ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_100ms_ease-in]"
        :style="{ zIndex }"
        @focus-outside="keepOpenOnToast"
        @interact-outside="keepOpenOnToast"
      >
        <p class="m-0 text-[13px] leading-[1.6]">
          <slot name="title">{{ title }}</slot>
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <Button size="sm" :disabled="busy" @click="open = false">{{ cancelText ?? t("common.cancel") }}</Button>
          <Button size="sm" :variant="tone === 'danger' ? 'danger' : 'primary'" :disabled="busy" @click="onConfirm">
            <Spinner v-if="busy" :size="12" />
            {{ confirmText ?? t("common.confirm") }}
          </Button>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts">
/**
 * 气泡确认：默认插槽是触发按钮（as-child），点它在旁边弹出一句话 + 取消 / 确定，取代 el-popconfirm。
 * 用于就地的小操作（删一个色桶、移除一条收藏视图）；会打断流程的确认用 AlertDialog / messageBox.confirm。
 * action 返回 Promise 时确定按钮转圈、完成后关闭；没有 action 时发 confirm 并关闭。
 * 它是 Reka 层：放在别的 Reka 弹层（如过滤 chip 的面板）里时，点它不会让外层弹层关闭。
 */
import { computed, ref } from "vue";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import Button from "./Button.vue";
import Spinner from "./Spinner.vue";
import { useLayerZIndex, keepOpenOnToast } from "./layer";

const props = withDefaults(
  defineProps<{
    title?: string;
    confirmText?: string;
    cancelText?: string;
    tone?: "default" | "danger";
    side?: "top" | "right" | "bottom" | "left";
    align?: "start" | "center" | "end";
    action?: () => unknown;
  }>(),
  { tone: "danger", side: "bottom", align: "center" },
);

const emit = defineEmits<{ confirm: [] }>();
const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });
useModalBack(open);
const zIndex = useLayerZIndex(open);
const busy = ref(false);

// 显式按触发器定位：触发器外面常套一层 Tooltip（见 PopoverContent.vue 的说明）
const triggerRef = ref<{ $el?: Element } | null>(null);
const reference = computed(() => {
  const el = triggerRef.value?.$el;
  return el instanceof HTMLElement ? el : undefined;
});

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
    // 留着让调用方提示错误
  } finally {
    busy.value = false;
  }
}
</script>
