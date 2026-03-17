<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.import-drag-drop.overviewTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.overviewPara') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.import-drag-drop.overviewItem1') }}</li>
        <li>{{ $t('help.tipsContent.import-drag-drop.overviewItem2') }}</li>
      </ul>
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>{{ $t('help.tipsContent.import-drag-drop.desktopDragTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.desktopDragPara1') }}</p>
      <p>{{ $t('help.tipsContent.import-drag-drop.desktopDragPara2') }}</p>
      <p>{{ $t('help.tipsContent.import-drag-drop.desktopDragPara3') }}</p>
      <TipImageCarousel v-if="usageImages.length > 0" :images="usageImages" />
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>{{ $t('help.tipsContent.import-drag-drop.desktopStartCollectTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.desktopStartCollectPara') }}</p>
    </section>

    <section class="section" v-if="IS_ANDROID">
      <h3>{{ $t('help.tipsContent.import-drag-drop.androidStartCollectTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.androidStartCollectPara') }}</p>
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>{{ $t('help.tipsContent.import-drag-drop.folderTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.folderPara1') }}</p>
      <p>{{ $t('help.tipsContent.import-drag-drop.folderPara2') }}</p>
      <TipImageCarousel v-if="folderImages.length > 0" :images="folderImages" />
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>{{ $t('help.tipsContent.import-drag-drop.zipTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.zipPara1') }}</p>
      <p>{{ $t('help.tipsContent.import-drag-drop.zipPara2') }}</p>
      <TipImageCarousel v-if="zipImages.length > 0" :images="zipImages" />
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>{{ $t('help.tipsContent.import-drag-drop.macosTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.macosPara1') }}</p>
      <p>{{ $t('help.tipsContent.import-drag-drop.macosPara2') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.import-drag-drop.macosItem1') }}</li>
        <li>{{ $t('help.tipsContent.import-drag-drop.macosItem2') }}</li>
      </ul>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.import-drag-drop.builtinTitle') }}</h3>
      <p>{{ $t('help.tipsContent.import-drag-drop.builtinPara') }}</p>
      <el-alert class="note" type="info" show-icon :closable="false">
        {{ $t('help.tipsContent.import-drag-drop.builtinNote') }}
      </el-alert>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";
import { IS_ANDROID } from "@kabegame/core/env";

// 使用方法示例图片
// 图片路径：/help-images/import/drag-drop-usage-*.png
const usageImages = ref<TipImage[]>([]);

// 文件夹导入示例图片
// 图片路径：/help-images/import/drag-drop-folder-*.png
const folderImages = ref<TipImage[]>([]);

// 压缩包导入示例图片
// 图片路径：/help-images/import/drag-drop-zip-*.png
const zipImages = ref<TipImage[]>([]);
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
    margin: 0 0 8px 0;
    padding-left: 20px;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
  }

  li {
    margin-bottom: 4px;
  }

  code {
    padding: 1px 6px;
    border-radius: 6px;
    border: 1px solid var(--anime-border);
    background: rgba(255, 255, 255, 0.5);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
  }
}

.note {
  margin-top: 6px;
}
</style>
