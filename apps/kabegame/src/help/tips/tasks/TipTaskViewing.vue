<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.task-viewing.drawerTitle') }}</h3>
            <p>{{ $t('help.tipsContent.task-viewing.drawerPara1') }}</p>
            <p>{{ $t('help.tipsContent.task-viewing.drawerPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-viewing.drawerItem1') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.drawerItem2') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.drawerItem3') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.drawerItem4') }}</li>
            </ul>
            <TipImageCarousel v-if="drawerImages.length > 0" :images="drawerImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.task-viewing.detailTitle') }}</h3>
            <p>{{ $t('help.tipsContent.task-viewing.detailPara1') }}</p>
            <p>{{ $t('help.tipsContent.task-viewing.detailPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-viewing.detailItem1') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.detailItem2') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.detailItem3') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.detailItem4') }}</li>
            </ul>
            <TipImageCarousel v-if="detailImages.length > 0" :images="detailImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.task-viewing.statusTitle') }}</h3>
            <p>{{ $t('help.tipsContent.task-viewing.statusPara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-viewing.statusItem1') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.statusItem2') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.statusItem3') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.statusItem4') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.statusItem5') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.task-viewing.statusPara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.task-viewing.imagesTitle') }}</h3>
            <p>{{ $t('help.tipsContent.task-viewing.imagesPara') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.task-viewing.imagesItem1') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.imagesItem2') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.imagesItem3') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.imagesItem4') }}</li>
                <li>{{ $t('help.tipsContent.task-viewing.imagesItem5') }}</li>
            </ul>
            <TipImageCarousel v-if="imagesViewImages.length > 0" :images="imagesViewImages" />
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 任务抽屉示例图片
// 图片路径：/help-images/tasks/viewing-drawer-*.png
const drawerImages = ref<TipImage[]>([]);

// 任务详情页示例图片
// 图片路径：/help-images/tasks/viewing-detail-*.png
const detailImages = ref<TipImage[]>([]);

// 任务图片查看示例图片
// 图片路径：/help-images/tasks/viewing-images-*.png
const imagesViewImages = ref<TipImage[]>([]);
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
