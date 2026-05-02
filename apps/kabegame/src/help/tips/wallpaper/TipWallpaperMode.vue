<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.wallpaper-mode.compareTitle') }}</h3>
            <p>{{ $t('help.tipsContent.wallpaper-mode.comparePara') }}</p>

            <div class="mode-comparison">
                <div class="mode-card">
                    <h4>{{ $t('help.tipsContent.wallpaper-mode.nativeTitle') }}</h4>
                    <ul>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.nativeItem1') }}</li>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.nativeItem2') }}</li>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.nativeItem3') }}</li>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.nativeItem4') }}</li>
                    </ul>
                </div>

                <div class="mode-card">
                    <h4>{{ $t('help.tipsContent.wallpaper-mode.windowTitle') }}</h4>
                    <ul>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.windowItem1') }}</li>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.windowItem2') }}</li>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.windowItem3') }}</li>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.windowItem4') }}</li>
                    </ul>
                </div>
            </div>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.wallpaper-mode.switchTitle') }}</h3>
            <p>{{ $t('help.tipsContent.wallpaper-mode.switchPara1') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.wallpaper-mode.switchItem1') }}</li>
                <li>{{ $t('help.tipsContent.wallpaper-mode.switchItem2') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.wallpaper-mode.switchPara2') }}</p>
            <TipImageCarousel v-if="modeSettingsImages.length > 0" :images="modeSettingsImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.wallpaper-mode.transitionTitle') }}</h3>
            <ul>
                <li>{{ $t('help.tipsContent.wallpaper-mode.transitionNative1') }}
                    <ul>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.transitionNative2') }}</li>
                    </ul>
                </li>
                <li>{{ $t('help.tipsContent.wallpaper-mode.transitionWindow1') }}
                    <ul>
                        <li>{{ $t('help.tipsContent.wallpaper-mode.transitionWindow2') }}</li>
                    </ul>
                </li>
            </ul>
            <TipImageCarousel v-if="transitionImages.length > 0" :images="transitionImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.wallpaper-mode.suggestTitle') }}</h3>
            <ul>
                <li>{{ $t('help.tipsContent.wallpaper-mode.suggestItem1') }}</li>
                <li>{{ $t('help.tipsContent.wallpaper-mode.suggestItem2') }}</li>
                <li>{{ $t('help.tipsContent.wallpaper-mode.suggestItem3') }}</li>
                <li>{{ $t('help.tipsContent.wallpaper-mode.suggestItem4') }}</li>
            </ul>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 模式设置示例图片
// 图片路径：/help-images/wallpaper/mode-settings-*.png
const modeSettingsImages = ref<TipImage[]>([]);

// 过渡效果示例图片
// 图片路径：/help-images/wallpaper/transition-*.png
const transitionImages = ref<TipImage[]>([]);
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
