<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.gallery-preview.featureTitle') }}</h3>
      <p>{{ $t('help.tipsContent.gallery-preview.featurePara1') }}</p>
      <p>{{ $t('help.tipsContent.gallery-preview.featurePara2') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.gallery-preview.featureItem1') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.featureItem2') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.featureItem3') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.featureItem4') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.featureItem5') }}</li>
      </ul>
      <TipImageCarousel v-if="previewImages.length > 0" :images="previewImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.gallery-preview.enableTitle') }}</h3>
      <p>{{ $t('help.tipsContent.gallery-preview.enablePara1') }}</p>
      <ol>
        <li>{{ $t('help.tipsContent.gallery-preview.enableStep1') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.enableStep2') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.enableStep3') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.enableStep4') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.enableStep5') }}</li>
      </ol>
      <el-alert class="note" type="info" show-icon :closable="false">
        {{ $t('help.tipsContent.gallery-preview.enableNote') }}
      </el-alert>
      <TipImageCarousel v-if="settingsImages.length > 0" :images="settingsImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.gallery-preview.usageTitle') }}</h3>
      <p>{{ $t('help.tipsContent.gallery-preview.usagePara1') }}</p>
      <p>{{ $t('help.tipsContent.gallery-preview.usagePara2') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.gallery-preview.usageClose') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.usageSwitch') }}
          <ul>
            <li>{{ $t('help.tipsContent.gallery-preview.usageSwitchItem1') }}</li>
            <li>{{ $t('help.tipsContent.gallery-preview.usageSwitchItem2') }}</li>
            <li>{{ $t('help.tipsContent.gallery-preview.usageSwitchItem3') }}</li>
          </ul>
        </li>
        <li>{{ $t('help.tipsContent.gallery-preview.usageZoom') }}
          <ul>
            <li>{{ $t('help.tipsContent.gallery-preview.usageZoomItem1') }}</li>
            <li>{{ $t('help.tipsContent.gallery-preview.usageZoomItem2') }}</li>
          </ul>
        </li>
        <li>{{ $t('help.tipsContent.gallery-preview.usageDrag') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.usageDelete') }}</li>
      </ul>
      <TipImageCarousel v-if="usageImages.length > 0" :images="usageImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.gallery-preview.scenariosTitle') }}</h3>
      <p>{{ $t('help.tipsContent.gallery-preview.scenariosPara') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.gallery-preview.scenariosItem1') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.scenariosItem2') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.scenariosItem3') }}</li>
        <li>{{ $t('help.tipsContent.gallery-preview.scenariosItem4') }}</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 预览功能示例图片
// 图片路径：/help-images/gallery/preview-feature-*.png
const previewImages = ref<TipImage[]>([]);

// 设置页面示例图片
// 图片路径：/help-images/gallery/preview-settings-*.png
const settingsImages = ref<TipImage[]>([]);

// 使用方法示例图片
// 图片路径：/help-images/gallery/preview-usage-*.png
const usageImages = ref<TipImage[]>([]);
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

  ul,
  ol {
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
        padding-left: 20px;
      }
    }
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
