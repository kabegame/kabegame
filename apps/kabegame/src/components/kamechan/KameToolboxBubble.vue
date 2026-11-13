<template>
  <Transition name="kame-bubble">
    <div
      v-if="visible"
      class="kame-toolbox-bubble"
      :class="[`is-side-${side}`, { 'is-compact': compact }]"
      :style="bubbleStyle"
      @pointerdown.stop
      @click.stop
      @contextmenu.stop
    >
      <div class="flex items-center gap-2.5 pb-2 pl-2.5 pr-1 pt-1.5">
        <span class="text-[15px] font-600 text-kb-fg">{{ t("kamechan.toolboxTitle") }}</span>
        <Button variant="outline" size="sm" class="ml-auto" @click="emit('open-settings')">
          <Settings />
          <span>{{ t("route.settings") }}</span>
        </Button>
      </div>
      <div class="kame-toolbox-bubble__body">
        <GlobalToolsList @close="emit('close')" @open-settings="emit('open-settings')" />
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Settings } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { Button } from "@/components/ui";
import GlobalToolsList from "@/header/comps/GlobalToolsList.vue";

const props = withDefaults(
  defineProps<{
    visible: boolean;
    side?: "left" | "right";
    maxWidth?: string;
    compact?: boolean;
  }>(),
  {
    side: "right",
    maxWidth: "320px",
    compact: false,
  },
);

const emit = defineEmits<{
  "open-settings": [];
  close: [];
}>();

const { t } = useI18n();

// 工具箱内容比消息气泡宽，最小宽度单独兜底，避免贴边时被压扁到不可读
const bubbleStyle = computed(() => ({
  "--kame-bubble-max-width": props.maxWidth,
}));
</script>

<style scoped lang="scss">
.kame-toolbox-bubble {
  --kame-bubble-overlap: 18px;
  --kame-bubble-max-width: 320px;

  position: absolute;
  bottom: 174px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  min-width: 260px;
  max-width: min(344px, max(260px, var(--kame-bubble-max-width)));
  padding: 6px;
  border-radius: var(--kb-radius-lg);
  background: var(--kb-surface-raised);
  color: var(--kb-fg);
  box-shadow: var(--kb-shadow-pop);
  // 与消息气泡不同：工具箱要可点、可滚
  pointer-events: auto;

  &::before {
    content: "";
    position: absolute;
    bottom: 26px;
    width: 12px;
    height: 12px;
    background: var(--kb-surface-raised);
    transform: rotate(45deg);
  }
}

.kame-toolbox-bubble.is-compact {
  bottom: 4px;
}

.kame-toolbox-bubble.is-side-right {
  left: calc(100% - var(--kame-bubble-overlap));

  &::before {
    left: -8px;
    border-left: 1px solid var(--kb-line);
    border-bottom: 1px solid var(--kb-line);
  }
}

.kame-toolbox-bubble.is-side-left {
  right: calc(100% - var(--kame-bubble-overlap));

  &::before {
    right: -8px;
    border-top: 1px solid var(--kb-line);
    border-right: 1px solid var(--kb-line);
  }
}

.kame-toolbox-bubble__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(52vh, 420px);
  overflow-y: auto;
}

.kame-bubble-enter-active,
.kame-bubble-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.kame-bubble-enter-from,
.kame-bubble-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}

@media (max-width: 520px) {
  .kame-toolbox-bubble {
    --kame-bubble-overlap: 14px;

    bottom: 142px;
    min-width: 240px;
    max-width: min(300px, max(240px, var(--kame-bubble-max-width)));
  }
}
</style>
