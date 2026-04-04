<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-store-basics.entryTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-store-basics.entryPara') }}</p>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-store-basics.tabsTitle') }}</h3>
      <ul>
        <li>{{ $t('help.tipsContent.plugin-store-basics.tabsItem1') }}</li>
        <li>{{ $t('help.tipsContent.plugin-store-basics.tabsItem2') }}</li>
      </ul>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-store-basics.addTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-store-basics.addPara1') }}</p>
      <p>{{ $t('help.tipsContent.plugin-store-basics.addPara2') }}</p>
      <el-alert class="note" type="info" show-icon :closable="false">
        {{ $t('help.tipsContent.plugin-store-basics.addNote') }}
      </el-alert>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-store-basics.installTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-store-basics.installPara1') }}</p>
      <p>{{ $t('help.tipsContent.plugin-store-basics.installPara2') }}</p>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.plugin-store-basics.editorTitle') }}</h3>
      <p>{{ $t('help.tipsContent.plugin-store-basics.editorPara') }}</p>
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
