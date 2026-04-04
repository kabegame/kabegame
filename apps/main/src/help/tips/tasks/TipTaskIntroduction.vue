<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.task-introduction.whatTitle') }}</h3>
            <p>{{ $t('help.tipsContent.task-introduction.whatPara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-introduction.whatItem1') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.whatItem2') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.whatItem3') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.whatItem4') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.task-introduction.whatPara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.task-introduction.doTitle') }}</h3>

            <h4>{{ $t('help.tipsContent.task-introduction.doStep1') }}</h4>
            <p>{{ $t('help.tipsContent.task-introduction.doStep1Para') }}</p>

            <h4>{{ $t('help.tipsContent.task-introduction.doStep2') }}</h4>
            <p>{{ $t('help.tipsContent.task-introduction.doStep2Para') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-introduction.doStep2Item1') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.doStep2Item2') }}</li>
            </ul>

            <h4>{{ $t('help.tipsContent.task-introduction.doStep3') }}</h4>
            <p>{{ $t('help.tipsContent.task-introduction.doStep3Para') }}</p>

            <h4>{{ $t('help.tipsContent.task-introduction.doStep4') }}</h4>
            <p>{{ $t('help.tipsContent.task-introduction.doStep4Para') }}</p>

            <h4>{{ $t('help.tipsContent.task-introduction.doStep5') }}</h4>
            <p>{{ $t('help.tipsContent.task-introduction.doStep5Para') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.task-introduction.maxTitle') }}</h3>
            <p>{{ $t('help.tipsContent.task-introduction.maxPara1') }}</p>

            <p>{{ $t('help.tipsContent.task-introduction.maxPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-introduction.maxItem1') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.maxItem2') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.maxItem3') }}</li>
            </ul>

            <p>{{ $t('help.tipsContent.task-introduction.maxPara3') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-introduction.maxItem4') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.maxItem5') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.maxItem6') }}</li>
            </ul>

            <el-alert class="note" type="info" show-icon :closable="false">
                <p>{{ $t('help.tipsContent.task-introduction.maxNote') }}</p>
                <ul style="margin: 8px 0 0 0; padding-left: 20px;">
                    <li>{{ $t('help.tipsContent.task-introduction.maxNoteItem1') }}</li>
                    <li>{{ $t('help.tipsContent.task-introduction.maxNoteItem2') }}</li>
                    <li>{{ $t('help.tipsContent.task-introduction.maxNoteItem3') }}</li>
                </ul>
            </el-alert>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.task-introduction.typeTitle') }}</h3>
            <p>{{ $t('help.tipsContent.task-introduction.typePara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-introduction.typeItem1') }}</li>
                <li>{{ $t('help.tipsContent.task-introduction.typeItem2') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.task-introduction.typePara2') }}</p>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 任务说明示例图片（如果需要）
// 图片路径：/help-images/tasks/introduction-*.png
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

    :deep(.el-alert__content) {
        p {
            margin: 0 0 8px 0;
        }

        ul {
            margin: 8px 0 0 0;
            padding-left: 20px;
        }
    }
}
</style>
