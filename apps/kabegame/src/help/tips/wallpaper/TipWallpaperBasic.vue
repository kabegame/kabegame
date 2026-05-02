<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-basic.contextTitle') }}</h3>
      <p>{{ $t('help.tipsContent.wallpaper-basic.contextPara1') }}</p>
      <p>{{ $t('help.tipsContent.wallpaper-basic.contextPara2') }}</p>
      <TipImageCarousel v-if="contextMenuImages.length > 0" :images="contextMenuImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-basic.otherTitle') }}</h3>
      <ul>
        <li>{{ $t('help.tipsContent.wallpaper-basic.otherItem1') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-basic.otherItem2') }}</li>
      </ul>
      <TipImageCarousel v-if="settingsImages.length > 0" :images="settingsImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-basic.noteTitle') }}</h3>
      <ul>
        <li>{{ $t('help.tipsContent.wallpaper-basic.noteItem1') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-basic.noteItem2') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-basic.noteItem3') }}</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 右键菜单示例图片
// 图片路径：/help-images/wallpaper/basic-context-menu-*.png
const contextMenuImages = ref<TipImage[]>([]);

// 设置页示例图片
// 图片路径：/help-images/wallpaper/basic-settings-*.png
const settingsImages = ref<TipImage[]>([]);
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
    }
  }
}
</style>
