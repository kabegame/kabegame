<template>
  <Transition name="kame-bubble">
    <div
      v-if="visible"
      class="kame-bubble"
      :class="[`is-${type}`, `is-side-${side}`]"
      :style="bubbleStyle"
    >
      <el-icon class="kame-bubble__icon">
        <component :is="iconComponent" />
      </el-icon>
      <div class="kame-bubble__content">
        <div class="kame-bubble__text">{{ text }}</div>
        <div v-if="moreText" class="kame-bubble__more">{{ moreText }}</div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { CircleCheck, InfoFilled, WarningFilled, CircleCloseFilled } from "@element-plus/icons-vue";
import type { KameMessageType } from "@kabegame/core/stores/kameMessage";

const props = withDefaults(defineProps<{
  text: string;
  type: KameMessageType;
  visible: boolean;
  moreText?: string;
  side?: "left" | "right";
  maxWidth?: string;
}>(), {
  moreText: "",
  side: "right",
  maxWidth: "320px",
});

const iconComponent = computed(() => {
  switch (props.type) {
    case "success":
      return CircleCheck;
    case "warning":
      return WarningFilled;
    case "error":
      return CircleCloseFilled;
    default:
      return InfoFilled;
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
  border: 1px solid rgba(255, 255, 255, 0.75);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  color: var(--anime-text-primary);
  box-shadow: 0 10px 28px rgba(24, 24, 40, 0.18);
  backdrop-filter: blur(10px);
  pointer-events: none;

  &::before {
    content: "";
    position: absolute;
    bottom: 24px;
    width: 14px;
    height: 14px;
    background: rgba(255, 255, 255, 0.94);
    transform: rotate(45deg);
  }
}

.kame-bubble.is-side-right {
  left: calc(100% - var(--kame-bubble-overlap));

  &::before {
    left: -8px;
    border-left: 1px solid rgba(255, 255, 255, 0.75);
    border-bottom: 1px solid rgba(255, 255, 255, 0.75);
  }
}

.kame-bubble.is-side-left {
  right: calc(100% - var(--kame-bubble-overlap));

  &::before {
    right: -8px;
    border-top: 1px solid rgba(255, 255, 255, 0.75);
    border-right: 1px solid rgba(255, 255, 255, 0.75);
  }
}

.kame-bubble__icon {
  flex: 0 0 auto;
  margin-top: 2px;
  font-size: 18px;
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
  color: var(--anime-text-secondary);
  font-size: 11px;
}

.kame-bubble.is-success .kame-bubble__icon {
  color: var(--el-color-success);
}

.kame-bubble.is-info .kame-bubble__icon {
  color: var(--el-color-primary);
}

.kame-bubble.is-warning .kame-bubble__icon {
  color: var(--el-color-warning);
}

.kame-bubble.is-error .kame-bubble__icon {
  color: var(--el-color-danger);
}

.kame-bubble-enter-active,
.kame-bubble-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
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
