<template>
  <div class="tip-article">
    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-window-video.videoTitle') }}</h3>
      <p>{{ $t('help.tipsContent.wallpaper-window-video.videoPara1') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.wallpaper-window-video.videoItem1') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-window-video.videoItem2') }}</li>
      </ul>
      <p>{{ $t('help.tipsContent.wallpaper-window-video.videoPara2') }}</p>
    </section>

    <section class="section">
      <h3>{{ $t('help.tipsContent.wallpaper-window-video.closeTitle') }}</h3>
      <p>{{ $t('help.tipsContent.wallpaper-window-video.closePara1') }}</p>
      <ul>
        <li>{{ $t('help.tipsContent.wallpaper-window-video.closeItem1') }}</li>
        <li>{{ $t('help.tipsContent.wallpaper-window-video.closeItem2') }}</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
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
}
</style>
