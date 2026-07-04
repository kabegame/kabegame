<template>
  <div class="image-not-found">
    <img v-if="showImage" src="/lost.png" alt="图片走丢了" class="lost-image" />
    <p class="lost-text">这张图走丢了捏</p>
  </div>
</template>

<script setup lang="ts">
interface Props {
  showImage?: boolean; // 是否显示图片，默认为 true
}

withDefaults(defineProps<Props>(), {
  showImage: true,
});
</script>

<style scoped lang="scss">
.image-not-found {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px;
  width: 100%;
  height: 100%;
  box-sizing: border-box;

  .lost-image {
    width: 160px;
    max-width: 50%;
    height: auto;
    opacity: 0.75;
    margin-bottom: 20px;
    user-select: none;
    pointer-events: none;
  }

  .lost-text {
    color: rgba(255, 255, 255, 0.78);
    font-size: 15px;
    text-align: center;
    line-height: 1.6;
    margin: 0;
    white-space: nowrap;
  }
}
</style>