<template>
  <Transition name="kame-bubble">
    <div
      v-if="visible"
      class="kame-bubble"
      :class="[`is-${type}`, `is-side-${side}`, { 'is-compact': compact }]"
      :style="bubbleStyle"
    >
      <component :is="iconComponent" class="kame-bubble__icon" />
      <div class="kame-bubble__content">
        <div class="kame-bubble__text">{{ text }}</div>
        <div v-if="moreText" class="kame-bubble__more">{{ moreText }}</div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { CircleCheck, CircleX, Info, TriangleAlert } from "@lucide/vue";
import type { KameMessageType } from "@/stores/kameMessage";

const props = withDefaults(
  defineProps<{
    text: string;
    type: KameMessageType;
    visible: boolean;
    moreText?: string;
    side?: "left" | "right";
    maxWidth?: string;
    compact?: boolean;
  }>(),
  {
    moreText: "",
    side: "right",
    maxWidth: "320px",
    compact: false,
  },
);

const iconComponent = computed(() => {
  switch (props.type) {
    case "success":
      return CircleCheck;
    case "warning":
      return TriangleAlert;
    case "error":
      return CircleX;
    default:
      return Info;
  }
});

const bubbleStyle = computed(() => ({
  "--kame-bubble-max-width": props.maxWidth,
}));
</script>

<style scoped lang="scss">
.kame-bubble {
  --kame-bubble-overlap: 18px;
  --kame-bubble-max-width: 320px;

  position: absolute;
  bottom: 174px;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: max-content;
  max-width: min(320px, var(--kame-bubble-max-width));
  padding: 10px 12px;
  border-radius: var(--kb-radius-lg);
  background: var(--kb-surface-raised);
  color: var(--kb-fg);
  box-shadow: var(--kb-shadow-pop);
  pointer-events: none;

  &::before {
    content: "";
    position: absolute;
    bottom: 24px;
    width: 12px;
    height: 12px;
    background: var(--kb-surface-raised);
    transform: rotate(45deg);
  }
}

.kame-bubble.is-compact {
  bottom: 4px;
}

.kame-bubble.is-side-right {
  left: calc(100% - var(--kame-bubble-overlap));

  &::before {
    left: -8px;
    border-left: 1px solid var(--kb-line);
    border-bottom: 1px solid var(--kb-line);
  }
}

.kame-bubble.is-side-left {
  right: calc(100% - var(--kame-bubble-overlap));

  &::before {
    right: -8px;
    border-top: 1px solid var(--kb-line);
    border-right: 1px solid var(--kb-line);
  }
}

.kame-bubble__icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 1.5px;
}

.kame-bubble__content {
  min-width: 0;
}

.kame-bubble__text {
  font-size: 13px;
  line-height: 1.45;
  word-break: break-word;
  white-space: pre-wrap;
}

.kame-bubble__more {
  margin-top: 4px;
  color: var(--kb-fg-muted);
  font-size: 11px;
}

.kame-bubble.is-success .kame-bubble__icon {
  color: var(--kb-success);
}

.kame-bubble.is-info .kame-bubble__icon {
  color: var(--kb-accent);
}

.kame-bubble.is-warning .kame-bubble__icon {
  color: var(--kb-warning);
}

.kame-bubble.is-error .kame-bubble__icon {
  color: var(--kb-danger);
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
  .kame-bubble {
    --kame-bubble-overlap: 14px;

    bottom: 142px;
  }
}
</style>
