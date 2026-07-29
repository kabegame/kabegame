<template>
  <div class="qp-carousel">
    <!-- 加载态：仅在数据尚未就绪时短暂出现（已安装插件的 docResources 本就在内存中，通常不会显示） -->
    <div v-if="loading" class="qp-carousel-box qp-carousel-state">
      <el-icon class="qp-spin"><Loading /></el-icon>
      <span class="qp-carousel-state-text">{{ t("plugins.quickPreview.loadingSamples") }}</span>
    </div>

    <!-- 空态：区分“确实没有示例图”与“未安装故未读取” -->
    <div v-else-if="emptyReason" class="qp-carousel-box qp-carousel-empty">
      <el-icon class="qp-carousel-empty-icon"><Picture /></el-icon>
      <span class="qp-carousel-empty-text">{{
        emptyReason === "not-installed"
          ? t("plugins.quickPreview.installToPreview")
          : t("plugins.quickPreview.noSampleImages")
      }}</span>
    </div>

    <template v-else-if="images.length">
      <div class="qp-carousel-box" @mouseenter="paused = true" @mouseleave="paused = false">
        <img :src="images[activeIndex].src" alt="" class="qp-carousel-img" />
        <div class="qp-carousel-caption">{{ images[activeIndex].label }}</div>
        <div v-if="images.length > 1" class="qp-carousel-counter">
          {{ activeIndex + 1 }} / {{ images.length }}
        </div>
        <button
          v-if="images.length > 1"
          type="button"
          class="qp-carousel-arrow qp-carousel-arrow--prev"
          :aria-label="t('plugins.quickPreview.prevImage')"
          @click.stop="goTo((activeIndex - 1 + images.length) % images.length)"
        >
          <el-icon><ArrowLeft /></el-icon>
        </button>
        <button
          v-if="images.length > 1"
          type="button"
          class="qp-carousel-arrow qp-carousel-arrow--next"
          :aria-label="t('plugins.quickPreview.nextImage')"
          @click.stop="goTo((activeIndex + 1) % images.length)"
        >
          <el-icon><ArrowRight /></el-icon>
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
import { ElIcon } from "element-plus";
import { ArrowLeft, ArrowRight, Loading, Picture } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";

export interface PluginQuickPreviewImage {
  /** 归一化的文档资源键，用作 :key */
  key: string;
  /** data: URL */
  src: string;
  /** 由文件名推导的说明文字（无法获知插件作者的原始配图说明，退而求其次） */
  label: string;
}

const props = withDefaults(
  defineProps<{
    images: PluginQuickPreviewImage[];
    loading?: boolean;
    /** 非空时不展示走马灯：'no-assets' = 插件确实没有示例图；'not-installed' = 未安装故未读取 */
    emptyReason?: "no-assets" | "not-installed" | null;
    /** 当前预览目标变化时用它重置索引（通常传插件 id），避免复用同一实例时索引串台 */
    resetToken?: string;
    autoplayMs?: number;
  }>(),
  { loading: false, emptyReason: null, resetToken: "", autoplayMs: 2600 }
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
  }
);

watch(
  () => props.images.length,
  () => {
    if (activeIndex.value >= props.images.length) activeIndex.value = 0;
    startTimer();
  },
  { immediate: true }
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
  background: var(--kb-qp-carousel-bg, #f4eff7);
}

.qp-carousel-state,
.qp-carousel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
}

.qp-carousel-empty {
  background: transparent;
  border: 1.5px dashed var(--el-border-color);
}

.qp-spin {
  font-size: 16px;
  color: var(--el-color-primary-light-5);
  animation: qp-spin 1.1s linear infinite;
}

@keyframes qp-spin {
  to {
    transform: rotate(360deg);
  }
}

.qp-carousel-state-text,
.qp-carousel-empty-text {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  text-align: center;
  white-space: pre-line;
  line-height: 1.5;
  padding: 0 12px;
}

.qp-carousel-empty-icon {
  font-size: 22px;
  color: var(--el-text-color-placeholder);
}

.qp-carousel-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.qp-carousel-caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 20px 10px 8px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.6) 100%);
  font: 500 11px/1.3 var(--kb-font-sans, sans-serif);
  color: #fff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  font: 600 10.5px/19px ui-monospace, Menlo, monospace;
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
  color: #4a3f52;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  transition: background 0.15s;
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
  background: var(--el-border-color-darker);
  cursor: pointer;
  transition: width 0.15s, background 0.15s;
}

.qp-carousel-dot--active {
  width: 16px;
  background: var(--el-color-primary);
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
  background: var(--kb-qp-carousel-bg, #f4eff7);
  box-shadow: 0 0 0 1.5px transparent;
  opacity: 0.45;
  transition: opacity 0.15s, box-shadow 0.15s;
}

.qp-carousel-thumb--active {
  opacity: 1;
  box-shadow: 0 0 0 1.5px var(--el-color-primary);
}

.qp-carousel-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
