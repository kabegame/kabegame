<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.albums-introduction.whatTitle') }}</h3>
            <p>{{ $t('help.tipsContent.albums-introduction.whatPara1') }}</p>
            <p>{{ $t('help.tipsContent.albums-introduction.whatPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.albums-introduction.whatItem1') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.whatItem2') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.albums-introduction.whatPara3') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.albums-introduction.createTitle') }}</h3>
            <p>{{ $t('help.tipsContent.albums-introduction.createPara1') }}</p>
            <p>{{ $t('help.tipsContent.albums-introduction.createPara2') }}</p>
            <TipImageCarousel v-if="createImages.length > 0" :images="createImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.albums-introduction.addTitle') }}</h3>
            <p>{{ $t('help.tipsContent.albums-introduction.addPara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.albums-introduction.addItem1') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.addItem2') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.addItem3') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.addItem4') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.albums-introduction.addPara2') }}</p>
            <TipImageCarousel v-if="addImages.length > 0" :images="addImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.albums-introduction.manageTitle') }}</h3>
            <p>{{ $t('help.tipsContent.albums-introduction.managePara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.albums-introduction.manageItem1') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.manageItem2') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.manageItem3') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.manageItem4') }}</li>
            </ul>
            <TipImageCarousel v-if="manageImages.length > 0" :images="manageImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.albums-introduction.removeTitle') }}</h3>
            <p>{{ $t('help.tipsContent.albums-introduction.removePara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.albums-introduction.removeItem1') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.removeItem2') }}</li>
            </ul>
            <el-alert class="note" type="warning" show-icon :closable="false">
                {{ $t('help.tipsContent.albums-introduction.removeNote') }}
            </el-alert>
            <TipImageCarousel v-if="removeImages.length > 0" :images="removeImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.albums-introduction.wallpaperTitle') }}</h3>
            <p>{{ $t('help.tipsContent.albums-introduction.wallpaperPara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.albums-introduction.wallpaperItem1') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.wallpaperItem2') }}</li>
                <li>{{ $t('help.tipsContent.albums-introduction.wallpaperItem3') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.albums-introduction.wallpaperPara2') }}</p>
        </section>

    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 创建画册示例图片
// 图片路径：/help-images/albums/introduction-create-*.png
const createImages = ref<TipImage[]>([]);

// 添加图片示例图片
// 图片路径：/help-images/albums/introduction-add-*.png
const addImages = ref<TipImage[]>([]);

// 画册管理示例图片
// 图片路径：/help-images/albums/introduction-manage-*.png
const manageImages = ref<TipImage[]>([]);

// 移除图片示例图片
// 图片路径：/help-images/albums/introduction-remove-*.png
const removeImages = ref<TipImage[]>([]);
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
