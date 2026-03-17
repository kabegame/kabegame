<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.gallery-browsing.totalTitle') }}</h3>
            <p>{{ $t('help.tipsContent.gallery-browsing.totalPara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.gallery-browsing.totalItem1') }}</li>
                <li>{{ $t('help.tipsContent.gallery-browsing.totalItem2') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.gallery-browsing.totalPara2') }}</p>
            <TipImageCarousel v-if="totalCountImages.length > 0" :images="totalCountImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.gallery-browsing.paginationTitle') }}</h3>
            <p>{{ $t('help.tipsContent.gallery-browsing.paginationPara1') }}</p>
            <p>{{ $t('help.tipsContent.gallery-browsing.paginationPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.gallery-browsing.paginationItem1') }}</li>
                <li>{{ $t('help.tipsContent.gallery-browsing.paginationItem2') }}</li>
                <li>{{ $t('help.tipsContent.gallery-browsing.paginationItem3') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.gallery-browsing.paginationPara3') }}</p>
            <TipImageCarousel v-if="paginationImages.length > 0" :images="paginationImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.gallery-browsing.organizeTitle') }}</h3>
            <p>{{ $t('help.tipsContent.gallery-browsing.organizePara1') }}</p>
            <p>{{ $t('help.tipsContent.gallery-browsing.organizePara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.gallery-browsing.organizeItem1') }}</li>
                <li>{{ $t('help.tipsContent.gallery-browsing.organizeItem2') }}</li>
                <li>{{ $t('help.tipsContent.gallery-browsing.organizeItem3') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.gallery-browsing.organizePara3') }}</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.gallery-browsing.organizeNote') }}
            </el-alert>
            <TipImageCarousel v-if="dedupeImages.length > 0" :images="dedupeImages" />
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 总数提示示例图片
// 图片路径：/help-images/gallery/browsing-total-count-*.png
const totalCountImages = ref<TipImage[]>([]);

// 分页功能示例图片
// 图片路径：/help-images/gallery/browsing-pagination-*.png
const paginationImages = ref<TipImage[]>([]);

// 去重功能示例图片
// 图片路径：/help-images/gallery/browsing-dedupe-*.png
const dedupeImages = ref<TipImage[]>([]);
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
