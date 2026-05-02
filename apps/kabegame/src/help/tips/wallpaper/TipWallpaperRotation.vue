<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-rotation.modeTitle') }}</h3>
      <p>{{ $t('help.tipsContent.wallpaper-rotation.modePara') }}</p>
      
      <div class="mode-comparison">
        <div class="mode-card">
          <h4>{{ $t('help.tipsContent.wallpaper-rotation.nonRotationTitle') }}</h4>
          <ul>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.nonRotationItem1') }}</li>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.nonRotationItem2') }}</li>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.nonRotationItem3') }}</li>
          </ul>
        </div>
        
        <div class="mode-card">
          <h4>{{ $t('help.tipsContent.wallpaper-rotation.rotationTitle') }}</h4>
          <ul>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.rotationItem1') }}</li>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.rotationItem2') }}</li>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.rotationItem3') }}</li>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.rotationItem4') }}</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-rotation.toggleTitle') }}</h3>
      <ul>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.toggleItem1') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.toggleItem2') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.toggleItem3') }}</li>
      </ul>
      <TipImageCarousel v-if="rotationSettingsImages.length > 0" :images="rotationSettingsImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-rotation.optionsTitle') }}</h3>
      <ul>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.optionsItem1') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.optionsItem2a') }}
          <ul>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.optionsItem2b') }}</li>
            <li>{{ $t('help.tipsContent.wallpaper-rotation.optionsItem2c') }}</li>
          </ul>
        </li>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.optionsItem3') }}</li>
      </ul>
      <TipImageCarousel v-if="rotationOptionsImages.length > 0" :images="rotationOptionsImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-rotation.noteTitle') }}</h3>
      <ul>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.noteItem1') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.noteItem2') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-rotation.noteItem3') }}</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 轮播设置示例图片
// 图片路径：/help-images/wallpaper/rotation-settings-*.png
const rotationSettingsImages = ref<TipImage[]>([]);

// 轮播选项示例图片
// 图片路径：/help-images/wallpaper/rotation-options-*.png
const rotationOptionsImages = ref<TipImage[]>([]);
</script>

<style scoped lang="scss">
.tip-article {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section {
  padding: 10px 0;
  border-bottom: 1px solid var(--anime-border);

  &:last-child {
    border-bottom: none;
  }

  h3 {
    margin: 0 0 8px 0;
    font-size: 14px;
    font-weight: 800;
    color: var(--anime-text-primary);
  }

  h4 {
    margin: 0 0 6px 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--anime-primary);
  }

  p {
    margin: 0 0 8px 0;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
  }

  ul {
    margin: 8px 0;
    padding-left: 20px;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;

    li {
      margin: 4px 0;

      strong {
        color: var(--anime-primary);
        font-weight: 600;
      }

      ul {
        margin: 4px 0;
        padding-left: 18px;
      }
    }
  }
}

.mode-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 12px 0;
}

.mode-card {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--anime-border);
  background: rgba(255, 255, 255, 0.3);

  h4 {
    margin: 0 0 8px 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--anime-primary);
  }

  ul {
    margin: 0;
    padding-left: 20px;
    font-size: 12px;
    line-height: 1.6;

    li {
      margin: 3px 0;
    }
  }
}

@media (max-width: 720px) {
  .mode-comparison {
    grid-template-columns: 1fr;
  }
}
</style>
