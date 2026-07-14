<template>
  <ImageContent
    :image="image"
    prefer="original"
    :video-playing="videoPlaying"
    video-loop
    @ready="handleReady"
    @error="handleError"
    @video-play-fail="handleVideoPlayFail"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import type { ImageInfo } from "../../types/image";
import ImageContent from "../image/ImageContent.vue";
import { isVideoMediaType } from "../../utils/mediaMime";

/**
 * PhotoSwipe 每张幻灯片的内容封装：复用 ImageContent（缩略图→原图流式覆盖）。
 * 视频：随 PhotoSwipe 控件显隐同步播放/暂停；若浏览器拒绝带声音 autoplay，
 * 用户点击视频本体会直接以用户手势触发播放。
 */
const props = defineProps<{
  image: ImageInfo;
  /** 是否为当前激活（居中）幻灯片 */
  active?: boolean;
  /** PhotoSwipe 控件栏是否可见 */
  uiVisible?: boolean;
}>();

const emit = defineEmits<{
  ready: [];
  error: [];
  videoPlayFail: [];
}>();

const isVideo = computed(() => isVideoMediaType(props.image.type));
// 激活且控件隐藏时播放；控件显示或非激活时暂停（暂停态即控件可见态）。
const videoPlaying = computed(() => isVideo.value && !!props.active && !props.uiVisible);

const handleVideoPlayFail = () => {
  if (!props.active) return;
  emit("videoPlayFail");
};
</script>
