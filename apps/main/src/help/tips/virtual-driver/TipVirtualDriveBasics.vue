<template>
    <div class="tip-article">
        <el-alert class="note" type="warning" show-icon :closable="false" style="margin-bottom: 10px;">
            {{ $t('help.tipsContent.virtual-driver-basics.lightModeNote') }}
        </el-alert>
        <section class="section">
            <h3>{{ $t('help.tipsContent.virtual-driver-basics.whatTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-basics.whatPara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-basics.whatPara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.virtual-driver-basics.enableTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-basics.enablePara1') }}</p>
            <p>{{ $t('help.tipsContent.virtual-driver-basics.enablePara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.virtual-driver-basics.openTitle') }}</h3>
            <ul>
                <li>{{ $t('help.tipsContent.virtual-driver-basics.openItem1') }}</li>
                <li>{{ $t('help.tipsContent.virtual-driver-basics.openItem2') }}</li>
                <li>{{ $t('help.tipsContent.virtual-driver-basics.openItem3') }}</li>
            </ul>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.virtual-driver-basics.noteTitle') }}</h3>
            <p>{{ $t('help.tipsContent.virtual-driver-basics.notePara1') }}</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.virtual-driver-basics.notePara2') }}
            </el-alert>
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
