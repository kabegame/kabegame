<template>
  <div class="tip-article">
    <section class="section">
      <h3>右键图片设置壁纸</h3>
      <p>在画廊、画册或任务详情中，<strong>右键点击任意图片</strong>，选择 <strong>"抱到桌面上"</strong>，即可将该图片设置为桌面壁纸。</p>
      <p>这是设置单张壁纸最快捷的方式，无需进入设置页面。</p>
      <TipImageCarousel v-if="contextMenuImages.length > 0" :images="contextMenuImages" />
    </section>

    <section class="section">
      <h3>设置壁纸的其他方式</h3>
      <ul>
        <li><strong>在设置页选择</strong>：进入"设置" → "壁纸轮播"标签，在"选择壁纸"中选择单张图片（轮播关闭时）</li>
        <li><strong>在画册详情页设置</strong>：打开画册详情页，点击右上角的"设为轮播壁纸"按钮（会开启轮播模式）</li>
      </ul>
      <TipImageCarousel v-if="settingsImages.length > 0" :images="settingsImages" />
    </section>

    <section class="section">
      <h3>注意事项</h3>
      <ul>
        <li>设置壁纸后，图片会立即应用到桌面</li>
        <li>如果当前启用了壁纸轮播，设置单张壁纸会<strong>自动关闭轮播</strong>，切换到单张壁纸模式</li>
        <li>壁纸设置会立即生效，无需重启应用</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 右键菜单示例图片
// 图片路径：/help-images/wallpaper/basic-context-menu-*.png
const contextMenuImages = ref<TipImage[]>([]);

// 设置页示例图片
// 图片路径：/help-images/wallpaper/basic-settings-*.png
const settingsImages = ref<TipImage[]>([]);
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
