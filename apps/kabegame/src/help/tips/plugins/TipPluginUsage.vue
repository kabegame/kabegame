<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-usage.openTitle') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-usage.openPara1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-usage.openPara2') }}</p>
            <TipImageCarousel v-if="openDialogImages.length > 0" :images="openDialogImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-usage.selectTitle') }}</h3>
            <p v-html="$t('help.tipsContent.plugin-usage.selectPara1')"></p>
            <p>{{ $t('help.tipsContent.plugin-usage.selectPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.plugin-usage.selectItem1') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.selectItem2') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.selectItem3') }}</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.plugin-usage.selectNote') }}
            </el-alert>
            <TipImageCarousel v-if="selectPluginImages.length > 0" :images="selectPluginImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-usage.configTitle') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-usage.configPara1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-usage.configPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.plugin-usage.configItem1') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.configItem2') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.configItem3') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.configItem4') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.configItem5') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.configItem6') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.plugin-usage.configPara3') }}</p>
            <TipImageCarousel v-if="configVarsImages.length > 0" :images="configVarsImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-usage.outputTitle') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-usage.outputPara1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-usage.outputPara2') }}</p>
            <p>{{ $t('help.tipsContent.plugin-usage.outputPara3') }}</p>
            <TipImageCarousel v-if="outputSettingsImages.length > 0" :images="outputSettingsImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-usage.saveTitle') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-usage.savePara1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-usage.savePara2') }}</p>
            <p>{{ $t('help.tipsContent.plugin-usage.savePara3') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.plugin-usage.saveItem1') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.saveItem2') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.saveItem3') }}</li>
            </ul>
            <el-alert class="note" type="warning" show-icon :closable="false">
                {{ $t('help.tipsContent.plugin-usage.saveNote') }}
            </el-alert>
            <TipImageCarousel v-if="saveConfigImages.length > 0" :images="saveConfigImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-usage.startTitle') }}</h3>
            <p>{{ $t('help.tipsContent.plugin-usage.startPara1') }}</p>
            <p>{{ $t('help.tipsContent.plugin-usage.startPara2') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.plugin-usage.startItem1') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.startItem2') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.startItem3') }}</li>
                <li>{{ $t('help.tipsContent.plugin-usage.startItem4') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.plugin-usage.startPara3') }}</p>
            <TipImageCarousel v-if="taskProgressImages.length > 0" :images="taskProgressImages" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.plugin-usage.faqTitle') }}</h3>
            <p><strong>{{ $t('help.tipsContent.plugin-usage.faqQ1') }}</strong></p>
            <p>{{ $t('help.tipsContent.plugin-usage.faqA1') }}</p>

            <p><strong>{{ $t('help.tipsContent.plugin-usage.faqQ2') }}</strong></p>
            <p>{{ $t('help.tipsContent.plugin-usage.faqA2') }}</p>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 打开对话框的示例图片
// 图片路径：/help-images/plugins/usage-open-dialog-*.png
const openDialogImages = ref<TipImage[]>([]);

// 选择插件的示例图片
// 图片路径：/help-images/plugins/usage-select-plugin-*.png
const selectPluginImages = ref<TipImage[]>([]);

// 配置变量的示例图片
// 图片路径：/help-images/plugins/usage-config-vars-*.png
const configVarsImages = ref<TipImage[]>([]);

// 输出设置的示例图片
// 图片路径：/help-images/plugins/usage-output-settings-*.png
const outputSettingsImages = ref<TipImage[]>([]);

// 保存配置的示例图片
// 图片路径：/help-images/plugins/usage-save-config-*.png
const saveConfigImages = ref<TipImage[]>([]);

// 任务进度的示例图片
// 图片路径：/help-images/plugins/usage-task-progress-*.png
const taskProgressImages = ref<TipImage[]>([]);
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
