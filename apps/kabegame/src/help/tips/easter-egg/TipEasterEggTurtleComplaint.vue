<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.easter-egg-turtle-complaint.whatTitle') }}</h3>
      <p>{{ $t('help.tipsContent.easter-egg-turtle-complaint.whatPara') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.easter-egg-turtle-complaint.whatItem1') }}</li>
        <li>{{ $t('help.tipsContent.easter-egg-turtle-complaint.whatItem2') }}</li>
      </ul>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.easter-egg-turtle-complaint.triggerTitle') }}</h3>
      <ul>
        <li>{{ $t('help.tipsContent.easter-egg-turtle-complaint.triggerItem1') }}</li>
        <li>{{ $t('help.tipsContent.easter-egg-turtle-complaint.triggerItem2') }}</li>
      </ul>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.easter-egg-turtle-complaint.descTitle') }}</h3>
      <p>{{ $t('help.tipsContent.easter-egg-turtle-complaint.descPara') }}</p>
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
}
</style>
