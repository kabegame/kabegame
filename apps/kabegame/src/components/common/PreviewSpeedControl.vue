<template>
  <div class="speed-wrap" @mouseenter="enter" @mouseleave="leave">
    <!-- 播放速度：按钮显示当前倍数，悬停出一列档位；点按钮回到 1×（同缩放按钮回到 100%）。注释放在根里面：放在外面根就成了片段 -->
    <button
      class="control-btn speed-btn"
      type="button"
      :aria-label="t('gallery.playbackSpeed')"
      :title="t('gallery.playbackSpeed')"
      data-testid="preview-speed-button"
      @click="choose(1)"
    >
      <span class="speed-btn-text">{{ formatRate(modelValue) }}</span>
    </button>
    <div
      class="speed-panel"
      :class="{ visible: active }"
      role="listbox"
      :aria-label="t('gallery.playbackSpeed')"
      data-testid="preview-speed-panel"
      @mouseenter="enter"
      @mouseleave="leave"
      @click.stop
    >
      <button
        v-for="rate in PREVIEW_SPEED_PRESETS"
        :key="rate"
        type="button"
        role="option"
        class="speed-option"
        :class="{ selected: rate === modelValue }"
        :aria-selected="rate === modelValue"
        :data-rate="rate"
        @click="choose(rate)"
      >
        {{ formatRate(rate) }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";

/**
 * 预览控制条的播放速度（视频、场景壁纸）：只是这次观看的临时值（用户定：默认 1、不保存），由调用方持有；档位在 0.25–4 之间。
 * 面板打开期间 emit `active`，调用方据此让控制条保持显示。
 */
defineProps<{ modelValue: number }>();
const emit = defineEmits<{
  "update:modelValue": [rate: number];
  active: [active: boolean];
}>();

const { t } = useI18n();

const active = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function clear() {
  if (timer) clearTimeout(timer);
  timer = null;
}
function enter() {
  clear();
  active.value = true;
}
function leave() {
  clear();
  timer = setTimeout(() => {
    active.value = false;
    timer = null;
  }, 180);
}
function choose(rate: number) {
  emit("update:modelValue", rate);
}

watch(active, (value) => emit("active", value));
onBeforeUnmount(clear);
</script>

<script lang="ts">
/** 档位（用户定范围 0.25–4，和壁纸设置的倍速同一范围） */
export const PREVIEW_SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

/** 「1.25×」：去掉多余的 0 */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}
</script>

<style scoped lang="scss">
.speed-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 显示倍数，宽度随内容（最长「1.25×」） */
.control-btn.speed-btn {
  width: auto;
  min-width: 30px;
  padding: 0 6px;
}

.speed-btn-text {
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.speed-panel {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  padding: 4px;
  border-radius: 10px;
  background: rgba(15, 16, 20, 0.82);
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column-reverse;
  gap: 2px;
  opacity: 0;
  transform: translate(-50%, 6px);
  pointer-events: none;
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;

  &.visible {
    opacity: 1;
    transform: translate(-50%, 0);
    pointer-events: auto;
  }
}

.speed-option {
  min-width: 52px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;

  &:hover {
    background: rgba(255, 255, 255, 0.14);
  }

  &.selected {
    color: var(--kb-primary);
    font-weight: 600;
  }
}
</style>
