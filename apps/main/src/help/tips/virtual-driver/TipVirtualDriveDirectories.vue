<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.virtual-driver-directories.rootTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.rootPara') }}</p>
        </section>

        <section class="section">
            <h3>📁 {{ $t('help.tipsContent.virtual-driver-directories.allTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.allPara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.allPara2') }}</p>
        </section>

        <section class="section">
            <h3>📁 {{ $t('help.tipsContent.virtual-driver-directories.pluginTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.pluginPara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.pluginPara2') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.pluginPara3') }}</p>
        </section>

        <section class="section">
            <h3>📁 {{ $t('help.tipsContent.virtual-driver-directories.timeTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.timePara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.timePara2') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.timePara3') }}</p>
        </section>

        <section class="section">
            <h3>📁 {{ $t('help.tipsContent.virtual-driver-directories.taskTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.taskPara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.taskPara2') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.taskPara3') }}</p>
        </section>

        <section class="section">
            <h3>📁 {{ $t('help.tipsContent.virtual-driver-directories.albumTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.albumPara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.albumPara2') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.albumPara3') }}</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.virtual-driver-directories.albumNote') }}
            </el-alert>
        </section>

        <section class="section">
            <h3>📄 {{ $t('help.tipsContent.virtual-driver-directories.readmeTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.readmePara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.readmePara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.virtual-driver-directories.suggestTitle') }}</h3>
            <ul>
                <li>{{ $t('help.tipsContent.virtual-driver-directories.suggestItem1') }}</li>
                <li>{{ $t('help.tipsContent.virtual-driver-directories.suggestItem2') }}</li>
                <li>{{ $t('help.tipsContent.virtual-driver-directories.suggestItem3') }}</li>
                <li>{{ $t('help.tipsContent.virtual-driver-directories.suggestItem4') }}</li>
                <li>{{ $t('help.tipsContent.virtual-driver-directories.suggestItem5') }}</li>
            </ul>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.virtual-driver-directories.noteTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.notePara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-directories.notePara2') }}</p>
        </section>
    </div>
</template>

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
