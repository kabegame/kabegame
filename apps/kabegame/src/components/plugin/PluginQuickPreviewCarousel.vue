<template>
  <div class="qp-carousel">
    <!-- 加载态：仅在数据尚未就绪时短暂出现（已安装插件的 assets 本就在内存中，通常不会显示） -->
    <div v-if="loading" class="qp-carousel-box qp-carousel-state">
      <Spinner :size="16" class="text-kb-fg-subtle" />
      <span class="qp-carousel-state-text">{{ t("plugins.quickPreview.loadingSamples") }}</span>
    </div>

    <template v-else-if="images.length">
      <div class="qp-carousel-box" @mouseenter="paused = true" @mouseleave="paused = false">
        <img :src="images[activeIndex].src" alt="" class="qp-carousel-img" />
        <div v-if="images.length > 1" class="qp-carousel-counter">{{ activeIndex + 1 }} / {{ images.length }}</div>
        <button
          v-if="images.length > 1"
          type="button"
          class="qp-carousel-arrow qp-carousel-arrow--prev"
          :aria-label="t('plugins.quickPreview.prevImage')"
          @click.stop="goTo((activeIndex - 1 + images.length) % images.length)"
        >
          <ChevronLeft />
        </button>
        <button
          v-if="images.length > 1"
          type="button"
          class="qp-carousel-arrow qp-carousel-arrow--next"
          :aria-label="t('plugins.quickPreview.nextImage')"
          @click.stop="goTo((activeIndex + 1) % images.length)"
        >
          <ChevronRight />
        </button>
      </div>

      <div v-if="images.length > 1" class="qp-carousel-dots">
        <span
          v-for="(img, i) in images"
          :key="img.key"
          class="qp-carousel-dot"
          :class="{ 'qp-carousel-dot--active': i === activeIndex }"
          @click.stop="goTo(i)"
        />
      </div>

      <div v-if="images.length > 1" class="qp-carousel-thumbs">
        <div
          v-for="(img, i) in images"
          :key="img.key"
          class="qp-carousel-thumb"
          :class="{ 'qp-carousel-thumb--active': i === activeIndex }"
          @click.stop="goTo(i)"
        >
          <img :src="img.src" alt="" />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { Spinner } from "@/components/ui";
import { useI18n } from "@kabegame/i18n";

export interface PluginQuickPreviewImage {
  /** 归一化的文档资源键，用作 :key */
  key: string;
  /** data: URL */
  src: string;
}

const props = withDefaults(
  defineProps<{
    images: PluginQuickPreviewImage[];
    loading?: boolean;
    /** 当前预览目标变化时用它重置索引（通常传插件 id），避免复用同一实例时索引串台 */
    resetToken?: string;
    autoplayMs?: number;
  }>(),
  { loading: false, resetToken: "", autoplayMs: 2600 },
);

const { t } = useI18n();

const activeIndex = ref(0);
const paused = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const goTo = (i: number) => {
  activeIndex.value = i;
};

const clearTimer = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

const startTimer = () => {
  clearTimer();
  if (props.images.length <= 1) return;
  timer = setInterval(() => {
    if (paused.value) return;
    activeIndex.value = (activeIndex.value + 1) % props.images.length;
  }, props.autoplayMs);
};

watch(
  () => props.resetToken,
  () => {
    activeIndex.value = 0;
  },
);

watch(
  () => props.images.length,
  () => {
    if (activeIndex.value >= props.images.length) activeIndex.value = 0;
    startTimer();
  },
  { immediate: true },
);

onBeforeUnmount(clearTimer);
</script>

<style scoped lang="scss">
.qp-carousel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.qp-carousel-box {
  position: relative;
  height: 180px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--kb-fill-light);
}

.qp-carousel-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
}

.qp-carousel-state-text {
  font-size: 12px;
  color: var(--kb-fg-subtle);
  text-align: center;
  white-space: pre-line;
  line-height: 1.5;
  padding: 0 12px;
}

.qp-carousel-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.qp-carousel-counter {
  position: absolute;
  top: 8px;
  right: 8px;
  height: 19px;
  padding: 0 7px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font:
    600 10.5px/19px ui-monospace,
    Menlo,
    monospace;
}

.qp-carousel-arrow {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.86);
  color: var(--kb-fg);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  transition: background 0.15s;
}

.qp-carousel-arrow svg {
  width: 15px;
  height: 15px;
}

.qp-carousel-arrow:hover {
  background: #fff;
}

.qp-carousel-arrow--prev {
  left: 6px;
}

.qp-carousel-arrow--next {
  right: 6px;
}

.qp-carousel-dots {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.qp-carousel-dot {
  height: 6px;
  width: 6px;
  border-radius: 3px;
  background: var(--kb-fill-dark);
  cursor: pointer;
  transition:
    width 0.15s,
    background 0.15s;
}

.qp-carousel-dot--active {
  width: 16px;
  background: var(--kb-fg);
}

.qp-carousel-thumbs {
  display: flex;
  gap: 6px;
}

.qp-carousel-thumb {
  flex: 1;
  height: 32px;
  border-radius: 7px;
  overflow: hidden;
  cursor: pointer;
  background: var(--kb-fill-light);
  box-shadow: 0 0 0 1.5px transparent;
  opacity: 0.45;
  transition:
    opacity 0.15s,
    box-shadow 0.15s;
}

.qp-carousel-thumb--active {
  opacity: 1;
  box-shadow: 0 0 0 1.5px var(--kb-fg);
}

.qp-carousel-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
