<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-import.method1Title') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-import.method1Para1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-import.method1Para2') }}</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.plugin-import.method1Note') }}
            </el-alert>
            <TipImageCarousel v-if="method1Images.length > 0" :images="method1Images" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-import.method2Title') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-import.method2Para1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-import.method2Para2') }}</p>
            <TipImageCarousel v-if="method2Images.length > 0" :images="method2Images" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-import.method3Title') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-import.method3Para1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-import.method3Para2') }}</p>
            <TipImageCarousel v-if="method3Images.length > 0" :images="method3Images" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-import.method4Title') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-import.method4Para1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-import.method4Para2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.plugin-import.method4Item1') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.method4Item2') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.method4Item3') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.method4Item4') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.method4Item5') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.method4Item6') }}</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.plugin-import.method4Note') }}
            </el-alert>
            <TipImageCarousel v-if="method4Images.length > 0" :images="method4Images" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-import.afterTitle') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-import.afterPara') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.plugin-import.afterItem1') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.afterItem2') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.afterItem3') }}</li>
            </ul>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-import.formatTitle') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-import.formatPara') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.plugin-import.formatItem1') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.formatItem2') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.formatItem3') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.formatItem4') }}</li>
                <li>{{ $t('help.tipsContent.plugin-import.formatItem5') }}</li>
            </ul>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 方法一：双击导入的示例图片
// 图片路径：/help-images/plugins/import-method1-*.png
const method1Images = ref<TipImage[]>([]);

// 方法二：拖入主窗口的示例图片
// 图片路径：/help-images/plugins/import-method2-*.png
const method2Images = ref<TipImage[]>([]);

// 方法三：从源管理页面导入的示例图片
// 图片路径：/help-images/plugins/import-method3-*.png
const method3Images = ref<TipImage[]>([]);

// 方法四：插件编辑器的示例图片
// 图片路径：/help-images/plugins/import-method4-*.png
const method4Images = ref<TipImage[]>([]);
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
