<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-introduction.whatTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-introduction.whatPara1') }}</p>
      <p>{{ $t('help.tipsContent.plugin-introduction.whatPara2') }}</p>
      <p>{{ $t('help.tipsContent.plugin-introduction.whatPara3') }}</p>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-introduction.formatTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-introduction.formatPara1') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.plugin-introduction.formatItem1') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.formatItem2') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.formatItem3') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.formatItem4') }}</li>
      </ul>
      <p>{{ $t('help.tipsContent.plugin-introduction.formatPara2') }}</p>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-introduction.typeTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-introduction.typePara') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.plugin-introduction.typeItem1') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.typeItem2') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.typeItem3') }}</li>
      </ul>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-introduction.roleTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-introduction.rolePara1') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.plugin-introduction.roleItem1') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.roleItem2') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.roleItem3') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.roleItem4') }}</li>
      </ul>
      <p>{{ $t('help.tipsContent.plugin-introduction.rolePara2') }}</p>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-introduction.getTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-introduction.getPara') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.plugin-introduction.getItem1') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.getItem2') }}</li>
        <li>{{ $t('help.tipsContent.plugin-introduction.getItem3') }}</li>
      </ul>
      <el-alert class="note" type="info" show-icon :closable="false">
        {{ $t('help.tipsContent.plugin-introduction.getNote') }}
      </el-alert>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 插件说明的示例图片（如果有的话）
// 图片路径：/help-images/plugins/introduction-*.png
const introductionImages = ref<TipImage[]>([]);
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
    margin: 0 0 8px 18px;
    padding: 0;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
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
