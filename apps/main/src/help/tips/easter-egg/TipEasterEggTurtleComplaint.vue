<template>
  <div class="tip-article">
    <section class="section">
      <h3>是什么</h3>
      <p>当你在图片列表里滑得太快时，应用会弹出一条俏皮提示，比如：</p>
      <ul>
        <li>“你这手速开挂了吧？龟龟跟不上啦 (╥﹏╥)”</li>
        <li>“别飙车！龟龟晕滚动条了~ (＠_＠;)”</li>
      </ul>
    </section>

    <section class="section">
      <h3>怎么触发</h3>
      <ul>
        <li><strong>画廊</strong>：用鼠标滚轮快速连续滚动（速度太快时会随机弹一句）。</li>
        <li><strong>画册详情</strong>：拖拽滚动时如果“速度很快且仍在加速”，会弹一句更短的提示。</li>
      </ul>
    </section>

    <section class="section">
      <h3>说明</h3>
      <p>这是一个纯彩蛋，不影响实际加载与功能。“每张图片都值得慢慢欣赏”。</p>
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
