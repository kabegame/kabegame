<template>
  <div ref="scrollEl" class="h-full overflow-y-auto [scrollbar-width:none] py-4 px-5.5 pb-10 text-14.5px leading-[1.7]">
    <!-- 无 banner 图时整块不渲染：文档顶上顶一个「没有示例图」的空框只是噪音 -->
    <PluginQuickPreviewCarousel
      v-if="showCarousel && images.length"
      class="mb-4.5"
      :images="images"
      :reset-token="resetToken"
    />
    <PluginDocRenderer
      :markdown="markdown"
      :assets="assets"
      :anchor-prefix="anchorPrefix"
      :empty-description="emptyDescription"
      @headings="emit('headings', $event)"
      @image-preview-open="emit('image-preview-open', $event)"
      @image-preview-close="emit('image-preview-close', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import PluginDocRenderer, { type DocHeading } from "./PluginDocRenderer.vue";
import PluginQuickPreviewCarousel from "./PluginQuickPreviewCarousel.vue";
import { bannerPreviewImages, type PluginAsset } from "../../utils/assetPath";

/** 滚动容器：供外层目录点击跳转 / scrollspy 使用 */
const scrollEl = ref<HTMLElement | null>(null);
defineExpose({ scrollEl });

const props = withDefaults(
  defineProps<{
    markdown?: string | null;
    assets?: PluginAsset[] | null;
    anchorPrefix?: string;
    showCarousel?: boolean;
    emptyDescription?: string;
    /** 走马灯索引重置标记（应传插件 id）：避免同一个面板实例在切换插件时索引串台 */
    resetToken?: string;
  }>(),
  {
    anchorPrefix: "kbdoc",
    showCarousel: false,
    resetToken: "",
  }
);

const emit = defineEmits<{
  (e: "headings", headings: DocHeading[]): void;
  (e: "image-preview-open", payload: { index: number; count: number; src: string; alt: string }): void;
  (e: "image-preview-close", payload: { index: number; count: number; src: string; alt: string }): void;
}>();

// 走马灯素材：按 kbAssets 声明顺序复用 banner 图，与快捷预览构造方式一致。
const images = computed(() => bannerPreviewImages(props.assets));
</script>
