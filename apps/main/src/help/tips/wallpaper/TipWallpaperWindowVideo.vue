<template>
  <div class="tip-article">
    <section class="section">
      <h3>窗口模式下可设置视频/动图壁纸</h3>
      <p>
        在<strong>窗口模式</strong>下，除了静态图片外，还可以将<strong>视频</strong>或<strong>GIF 动图</strong>设为桌面壁纸，
        壁纸会以动态方式在桌面下层全屏播放。
      </p>
      <ul>
        <li><strong>Windows</strong>：窗口模式支持将 <strong>MP4 视频</strong>设为壁纸；GIF 等可走原生模式。</li>
        <li><strong>macOS</strong>：窗口模式支持<strong>视频</strong>和<strong>GIF</strong>，均通过桌面下层窗口播放。</li>
      </ul>
      <p>
        若当前为原生模式且你选择的媒体需要窗口模式（如视频），应用会提示先切换到「窗口模式」再设置壁纸；
        也可在<strong>设置 → 壁纸轮播</strong>中先改为窗口模式，再设置该媒体为壁纸。
      </p>
    </section>

    <section class="section">
      <h3>应用关闭后壁纸会消失</h3>
      <p>
        无论是原生模式还是窗口模式，<strong>壁纸都是由 Kabegame 应用提供或渲染的</strong>。
        当你<strong>完全退出应用</strong>（包括从托盘退出、关闭主窗口并退出等）后，桌面壁纸会恢复为系统原本的壁纸或空白，这是正常现象。
      </p>
      <ul>
        <li><strong>原因</strong>：窗口模式下壁纸由应用内的透明窗口渲染；原生模式下虽调用了系统 API，但部分系统在应用退出后也会恢复默认。</li>
        <li><strong>若想保持壁纸</strong>：请保持 Kabegame 在后台运行（如最小化到托盘、不选择「退出」），壁纸会持续显示。</li>
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
