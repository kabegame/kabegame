<template>
  <div class="tip-image-carousel">
    <el-carousel
      :height="height"
      :arrow="images.length > 1 ? 'hover' : 'never'"
      :indicator-position="images.length > 1 ? 'outside' : 'none'"
    >
      <el-carousel-item v-for="(img, index) in images" :key="index">
        <div class="carousel-item">
          <el-image
            :src="img.src"
            :alt="img.alt || `示例图片 ${index + 1}`"
            fit="contain"
            :preview-src-list="previewList"
            :initial-index="index"
            loading="lazy"
          >
            <template #error>
              <div class="image-error">
                <el-icon><Picture /></el-icon>
                <span>图片加载失败</span>
              </div>
            </template>
          </el-image>
          <div v-if="img.caption" class="image-caption">{{ img.caption }}</div>
        </div>
      </el-carousel-item>
    </el-carousel>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Picture } from "@element-plus/icons-vue";

export interface TipImage {
  src: string;
  alt?: string;
  caption?: string;
}

const props = withDefaults(
  defineProps<{
    images: TipImage[];
    height?: string;
  }>(),
  {
    height: "400px",
  }
);

const previewList = computed(() => props.images.map((img) => img.src));
</script>

<style scoped lang="scss">
.tip-image-carousel {
  margin: 12px 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--anime-border);
  background: var(--anime-bg-card);

  :deep(.el-carousel) {
    .el-carousel__container {
      background: var(--anime-bg-secondary);
    }

    .el-carousel__item {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .el-carousel__arrow {
      background-color: rgba(255, 255, 255, 0.8);
      border: 1px solid var(--anime-border);
      color: var(--anime-text-primary);

      &:hover {
        background-color: rgba(255, 255, 255, 0.95);
      }
    }

    .el-carousel__indicators {
      .el-carousel__button {
        background-color: var(--anime-text-muted);
        opacity: 0.5;

        &.is-active {
          opacity: 1;
          background-color: var(--anime-primary);
        }
      }
    }
  }
}

.carousel-item {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px;

  .el-image {
    width: 100%;
    height: 100%;
    max-height: calc(100% - 30px);
    border-radius: 4px;
  }

  .image-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    height: 100%;
    color: var(--anime-text-muted);
    font-size: 12px;

    .el-icon {
      font-size: 32px;
    }
  }

  .image-caption {
    margin-top: 8px;
    font-size: 12px;
    color: var(--anime-text-secondary);
    text-align: center;
    line-height: 1.5;
  }
}
</style>
