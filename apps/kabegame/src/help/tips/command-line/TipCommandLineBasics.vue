<template>
    <div class="tip-article">
        <el-alert class="note" type="warning" show-icon :closable="false" style="margin-bottom: 10px;">
            {{ $t('help.tipsContent.command-line-basics.lightModeNote') }}
        </el-alert>
        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-basics.whatTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-basics.whatPara1') }}</p>
            <p>{{ $t('help.tipsContent.command-line-basics.whatPara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-basics.startTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-basics.startPara1') }}</p>
            <p>{{ $t('help.tipsContent.command-line-basics.startPara2') }}</p>
            <CodeBlock code="kabegame-cli --help" />
            <p>{{ $t('help.tipsContent.command-line-basics.startPara3') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-basics.mainTitle') }}</h3>

            <h4>{{ $t('help.tipsContent.command-line-basics.runTitle') }}</h4>
            <p>{{ $t('help.tipsContent.command-line-basics.runPara') }}</p>
            <CodeBlock code="kabegame-cli plugin run --plugin <插件ID或路径> [选项] -- <插件参数>" />
            <p>{{ $t('help.tipsContent.command-line-basics.runParamTitle') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.command-line-basics.runParam1') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.runParam2') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.runParam3') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.runParam4') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.runParam5') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.command-line-basics.runExampleTitle') }}</p>
            <CodeBlock code='kabegame-cli plugin run --plugin konachan --output-dir ./downloads -- --tags="yuri rating:safe"' />

            <h4>{{ $t('help.tipsContent.command-line-basics.packTitle') }}</h4>
            <p>{{ $t('help.tipsContent.command-line-basics.packPara') }}</p>
            <CodeBlock code="kabegame-cli plugin pack --plugin-dir <插件目录> --output <输出.kgpg路径>" />
            <ul>
                <li>{{ $t('help.tipsContent.command-line-basics.packParam1') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.packParam2') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.command-line-basics.packExampleTitle') }}</p>
            <CodeBlock code="kabegame-cli plugin pack --plugin-dir ./my-plugin --output ./my-plugin.kgpg" />

            <h4>{{ $t('help.tipsContent.command-line-basics.importTitle') }}</h4>
            <p>{{ $t('help.tipsContent.command-line-basics.importPara') }}</p>
            <CodeBlock code="kabegame-cli plugin import <.kgpg文件路径> [--no-ui]" />
            <ul>
                <li>{{ $t('help.tipsContent.command-line-basics.importParam1') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.importParam2') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.command-line-basics.importExampleTitle') }}</p>
            <CodeBlock code="kabegame-cli plugin import ./my-plugin.kgpg" />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-basics.sceneTitle') }}</h3>
            <ul>
                <li>{{ $t('help.tipsContent.command-line-basics.sceneItem1') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.sceneItem2') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.sceneItem3') }}</li>
                <li>{{ $t('help.tipsContent.command-line-basics.sceneItem4') }}</li>
            </ul>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-basics.noteTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-basics.notePara1') }}</p>
            <p>{{ $t('help.tipsContent.command-line-basics.notePara2') }}</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.command-line-basics.notePara3') }}
            </el-alert>
        </section>
    </div>
</template>

<script setup lang="ts">
import CodeBlock from "@/components/help/CodeBlock.vue";
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
        margin: 0 0 8px 18px;
        padding: 0;
        color: var(--anime-text-primary);
        font-size: 13px;
        line-height: 1.7;

        li {
            margin-bottom: 4px;
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
