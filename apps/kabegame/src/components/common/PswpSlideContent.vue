<template>
  <ImageContent
    :image="image"
    prefer="original"
    fit="contain"
    :video-playing="videoPlaying"
    video-loop
    @ready="handleReady"
    @error="handleError"
    @video-play-fail="handleVideoPlayFail"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { ImageInfo } from "../../types/image";
import ImageContent from "../image/ImageContent.vue";
import { isVideoMediaType } from "../../utils/mediaMime";

/**
 * PhotoSwipe 每张幻灯片的内容封装：复用 ImageContent（缩略图→原图流式覆盖）。
 * 视频：激活时自动播放，双击切换播放/暂停（宿主经 paused 传入），与控件显隐无关。
 */
const props = defineProps<{
  image: ImageInfo;
  /** 是否为当前激活（居中）幻灯片 */
  active?: boolean;
  /** 视频是否处于用户暂停态（双击切换） */
  paused?: boolean;
}>();

const emit = defineEmits<{
  ready: [];
  error: [];
  videoPlayFail: [];
}>();

const isVideo = computed(() => isVideoMediaType(props.image.type));
// 激活且未被用户暂停时播放；非激活或双击暂停时暂停，与控件显隐无关。
const videoPlaying = computed(() => isVideo.value && !!props.active && !props.paused);

const handleReady = () => emit("ready");
const handleError = () => emit("error");
const a = 10;

const handleVideoPlayFail = () => {
  if (!props.active) return;
  console.log(a);
  emit("videoPlayFail");
};
</script>
