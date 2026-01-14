<template>
  <div class="tip-article">
    <section class="section">
      <h3>轮播模式 vs 非轮播模式</h3>
      <p>Kabegame 支持两种壁纸模式：<strong>轮播模式</strong>和<strong>非轮播模式</strong>（单张壁纸）。</p>
      
      <div class="mode-comparison">
        <div class="mode-card">
          <h4>非轮播模式（单张壁纸）</h4>
          <ul>
            <li>显示一张固定的壁纸</li>
            <li>需要手动更换壁纸（右键图片选择"抱到桌面上"）</li>
            <li>适合：想要固定某张图片作为壁纸的场景</li>
          </ul>
        </div>
        
        <div class="mode-card">
          <h4>轮播模式</h4>
          <ul>
            <li>从指定画册中<strong>自动轮播</strong>更换壁纸</li>
            <li>可以设置轮播间隔（分钟）和轮播模式（随机/顺序）</li>
            <li>支持过渡效果（淡入淡出、滑动等）</li>
            <li>适合：想要桌面壁纸自动更换的场景</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="section">
      <h3>如何开启/关闭轮播</h3>
      <ul>
        <li><strong>开启轮播</strong>：进入"设置" → "壁纸轮播"标签，开启"启用壁纸轮播"，然后选择要轮播的画册</li>
        <li><strong>关闭轮播</strong>：在设置页关闭"启用壁纸轮播"，或右键图片设置单张壁纸（会自动关闭轮播）</li>
        <li><strong>在画册详情页开启</strong>：打开画册详情页，点击"设为轮播壁纸"按钮，会自动开启轮播并选择该画册</li>
      </ul>
      <TipImageCarousel v-if="rotationSettingsImages.length > 0" :images="rotationSettingsImages" />
    </section>

    <section class="section">
      <h3>轮播设置选项</h3>
      <ul>
        <li><strong>轮播间隔</strong>：设置壁纸更换的间隔时间（1-1440 分钟）</li>
        <li><strong>轮播模式</strong>：
          <ul>
            <li><strong>随机模式</strong>：每次从画册中随机选择一张图片</li>
            <li><strong>顺序模式</strong>：按画册中的顺序依次更换</li>
          </ul>
        </li>
        <li><strong>过渡效果</strong>：轮播切换时的动画效果（仅轮播模式支持）</li>
      </ul>
      <TipImageCarousel v-if="rotationOptionsImages.length > 0" :images="rotationOptionsImages" />
    </section>

    <section class="section">
      <h3>注意事项</h3>
      <ul>
        <li>轮播模式需要选择一个画册作为图片源，画册为空时无法轮播</li>
        <li>如果删除的画册正在被轮播引用，轮播会自动关闭，切回单张壁纸模式</li>
        <li>设置单张壁纸（右键图片）会自动关闭轮播，切换到非轮播模式</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 轮播设置示例图片
// 图片路径：/help-images/wallpaper/rotation-settings-*.png
const rotationSettingsImages = ref<TipImage[]>([]);

// 轮播选项示例图片
// 图片路径：/help-images/wallpaper/rotation-options-*.png
const rotationOptionsImages = ref<TipImage[]>([]);
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

  h4 {
    margin: 0 0 6px 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--anime-primary);
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

      ul {
        margin: 4px 0;
        padding-left: 18px;
      }
    }
  }
}

.mode-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin: 12px 0;
}

.mode-card {
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--anime-border);
  background: rgba(255, 255, 255, 0.3);

  h4 {
    margin: 0 0 8px 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--anime-primary);
  }

  ul {
    margin: 0;
    padding-left: 20px;
    font-size: 12px;
    line-height: 1.6;

    li {
      margin: 3px 0;
    }
  }
}

@media (max-width: 720px) {
  .mode-comparison {
    grid-template-columns: 1fr;
  }
}
</style>
