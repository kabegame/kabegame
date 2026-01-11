<template>
    <div class="empty-state">
        <img src="/album-empty.png" alt="空状態" class="empty-image" />
        <p class="empty-tip">まだ空っぽだけど、これから色々お友達を作っていくのだ！</p>
        <p class="empty-tip">提示：把图片文件夹拖进来有惊喜</p>
    </div>
</template>

<script setup lang="ts">
// 统一的空状态组件：显示空状态图片和日文文本
</script>

<style scoped lang="scss">
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 32px;
    height: 100%;
    min-height: 300px;

    .empty-image {
        width: 200px;
        max-width: 60%;
        height: auto;
        opacity: 0.85;
        margin-bottom: 24px;
        user-select: none;
        pointer-events: none;
    }

    .empty-tip {
        color: gray;
        font-size: 14px;
        text-align: center;
        line-height: 1.6;
        text-shadow: 0 1px 3px rgba(255, 255, 255, 0.3);
    }
}
</style>