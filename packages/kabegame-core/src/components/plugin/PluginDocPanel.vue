<template>
  <div ref="scrollEl" class="h-full overflow-y-auto [scrollbar-width:none] py-4 px-5.5 pb-10 text-14.5px leading-[1.7]">
    <PluginQuickPreviewCarousel
      v-if="showCarousel"
      class="mb-4.5"
      :images="images"
      :empty-reason="images.length ? null : 'no-assets'"
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
import { guessAssetMime, humanizeAssetLabel } from "../../utils/assetPath";

/** 滚动容器：供外层目录点击跳转 / scrollspy 使用 */
const scrollEl = ref<HTMLElement | null>(null);
defineExpose({ scrollEl });

const props = withDefaults(
  defineProps<{
    markdown?: string | null;
    assets?: Record<string, string> | null;
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

// 走马灯素材：直接复用 assets 表，与 PluginBrowser.vue 的 hover 快捷预览构造方式一致
const images = computed(() => {
  const assets = props.assets ?? {};
  return Object.keys(assets)
    .sort()
    .map((key) => ({
      key,
      src: `data:${guessAssetMime(key)};base64,${assets[key]}`,
      label: humanizeAssetLabel(key),
    }));
});
</script>
