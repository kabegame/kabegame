<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.task-management.createTitle') }}</h3>
      <p>{{ $t('help.tipsContent.task-management.createPara') }}</p>

      <h4>{{ $t('help.tipsContent.task-management.createMethod1') }}</h4>
      <p>{{ $t('help.tipsContent.task-management.createMethod1Para') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.task-management.createMethod1Item1') }}</li>
        <li>{{ $t('help.tipsContent.task-management.createMethod1Item2') }}</li>
        <li>{{ $t('help.tipsContent.task-management.createMethod1Item3') }}</li>
        <li>{{ $t('help.tipsContent.task-management.createMethod1Item4') }}</li>
        <li>{{ $t('help.tipsContent.task-management.createMethod1Item5') }}</li>
      </ul>
      <p>{{ $t('help.tipsContent.task-management.createMethod1Para2') }}</p>
      <TipImageCarousel v-if="createDialogImages.length > 0" :images="createDialogImages" />

      <h4>{{ $t('help.tipsContent.task-management.createMethod2') }}</h4>
      <p>{{ $t('help.tipsContent.task-management.createMethod2Para') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.task-management.createMethod2Item1') }}</li>
        <li>{{ $t('help.tipsContent.task-management.createMethod2Item2') }}</li>
        <li>{{ $t('help.tipsContent.task-management.createMethod2Item3') }}</li>
        <li>{{ $t('help.tipsContent.task-management.createMethod2Item4') }}</li>
      </ul>
      <TipImageCarousel v-if="dragDropImages.length > 0" :images="dragDropImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.task-management.stopTitle') }}</h3>
      <p>{{ $t('help.tipsContent.task-management.stopPara') }}</p>

      <h4>{{ $t('help.tipsContent.task-management.stopDrawer') }}</h4>
      <p>{{ $t('help.tipsContent.task-management.stopDrawerPara') }}</p>

      <h4>{{ $t('help.tipsContent.task-management.stopDetail') }}</h4>
      <p>{{ $t('help.tipsContent.task-management.stopDetailPara') }}</p>

      <p>{{ $t('help.tipsContent.task-management.stopNote') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.task-management.stopItem1') }}</li>
        <li>{{ $t('help.tipsContent.task-management.stopItem2') }}</li>
        <li>{{ $t('help.tipsContent.task-management.stopItem3') }}</li>
      </ul>
      <TipImageCarousel v-if="stopImages.length > 0" :images="stopImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.task-management.deleteTitle') }}</h3>
      <p>{{ $t('help.tipsContent.task-management.deletePara') }}</p>

      <h4>{{ $t('help.tipsContent.task-management.deleteDrawer') }}</h4>
      <p>{{ $t('help.tipsContent.task-management.deleteDrawerPara') }}</p>

      <h4>{{ $t('help.tipsContent.task-management.deleteDetail') }}</h4>
      <p>{{ $t('help.tipsContent.task-management.deleteDetailPara') }}</p>

      <p>{{ $t('help.tipsContent.task-management.deleteNote') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.task-management.deleteItem1') }}</li>
        <li>{{ $t('help.tipsContent.task-management.deleteItem2') }}</li>
        <li>{{ $t('help.tipsContent.task-management.deleteItem3') }}</li>
        <li>{{ $t('help.tipsContent.task-management.deleteItem4') }}</li>
      </ul>
      <TipImageCarousel v-if="deleteImages.length > 0" :images="deleteImages" />
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.task-management.batchTitle') }}</h3>
      <p>{{ $t('help.tipsContent.task-management.batchPara') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.task-management.batchItem1') }}</li>
        <li>{{ $t('help.tipsContent.task-management.batchItem2') }}</li>
      </ul>
      <el-alert class="note" type="info" show-icon :closable="false">
        {{ $t('help.tipsContent.task-management.batchNote') }}
      </el-alert>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 创建任务对话框示例图片
// 图片路径：/help-images/tasks/management-create-dialog-*.png
const createDialogImages = ref<TipImage[]>([]);

// 拖入文件创建任务示例图片
// 图片路径：/help-images/tasks/management-drag-drop-*.png
const dragDropImages = ref<TipImage[]>([]);

// 终止任务示例图片
// 图片路径：/help-images/tasks/management-stop-*.png
const stopImages = ref<TipImage[]>([]);

// 删除任务示例图片
// 图片路径：/help-images/tasks/management-delete-*.png
const deleteImages = ref<TipImage[]>([]);
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
    margin: 12px 0 6px 0;
    font-size: 13px;
    font-weight: 700;
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

.note {
  margin-top: 6px;
}
</style>
