<template>
  <div class="empty-state">
    <img src="/album-empty.png" alt="空状态" class="empty-image" />
    <p class="empty-tip">这里还是空的，可以先运行一次任务把图片“抱”进来。</p>
  </div>
</template>

<script setup lang="ts">
// 统一的空状态组件：避免各处重复实现
</script>

<style scoped lang="scss">
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 32px;
  height: 100%;
  min-height: 260px;

  .empty-image {
    width: 200px;
    max-width: 60%;
    height: auto;
    opacity: 0.85;
    margin-bottom: 20px;
    user-select: none;
    pointer-events: none;
  }

  .empty-tip {
    color: var(--anime-text-muted, gray);
    font-size: 14px;
    text-align: center;
    line-height: 1.6;
  }
}
</style>


