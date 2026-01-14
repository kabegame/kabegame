<template>
  <div class="tip-article">
    <section class="section">
      <h3>功能说明</h3>
      <p>
        <strong>双击应用内预览</strong>是画廊和画册中的一个便捷功能，让你可以在应用内快速查看图片大图，无需打开系统默认的图片查看器。
      </p>
      <p>启用后，双击任意图片即可打开预览对话框，支持以下功能：</p>
      <ul>
        <li><strong>查看大图</strong>：以原始尺寸或适配窗口的方式查看图片</li>
        <li><strong>缩放</strong>：使用鼠标滚轮或触摸板手势进行缩放</li>
        <li><strong>拖拽</strong>：放大后可以拖拽查看图片的不同区域</li>
        <li><strong>切换图片</strong>：使用左右箭头键或点击左右按钮切换上一张/下一张</li>
        <li><strong>快速操作</strong>：在预览中可以直接删除图片、添加到画册等</li>
      </ul>
      <TipImageCarousel v-if="previewImages.length > 0" :images="previewImages" />
    </section>

    <section class="section">
      <h3>开启方法</h3>
      <p>要启用双击应用内预览功能，需要前往<strong>设置</strong>页面进行配置：</p>
      <ol>
        <li>点击左侧菜单栏的<strong>"设置"</strong>按钮，进入设置页面</li>
        <li>在设置页面中，切换到<strong>"应用设置"</strong>标签页</li>
        <li>找到<strong>"图片点击行为"</strong>设置项</li>
        <li>选择<strong>"应用内预览"</strong>选项</li>
        <li>设置会立即生效，无需重启应用</li>
      </ol>
      <el-alert class="note" type="info" show-icon :closable="false">
        如果你选择<strong>"系统默认打开"</strong>，双击图片会用系统默认的图片查看器打开，而不是应用内预览。
      </el-alert>
      <TipImageCarousel v-if="settingsImages.length > 0" :images="settingsImages" />
    </section>

    <section class="section">
      <h3>使用方法</h3>
      <p>启用后，在画廊或画册中<strong>双击任意图片</strong>即可打开应用内预览对话框。</p>
      <p>预览对话框支持以下操作：</p>
      <ul>
        <li><strong>关闭预览</strong>：点击对话框外的遮罩区域，或按 <code>Esc</code> 键</li>
        <li><strong>切换图片</strong>：
          <ul>
            <li>使用键盘<strong>左右箭头键</strong>（← →）</li>
            <li>点击预览对话框左右两侧的导航按钮</li>
            <li>在图片左右边缘悬停，会出现半透明的导航按钮</li>
          </ul>
        </li>
        <li><strong>缩放图片</strong>：
          <ul>
            <li>使用<strong>鼠标滚轮</strong>向上/向下滚动</li>
            <li>使用<strong>触摸板手势</strong>（双指捏合）</li>
          </ul>
        </li>
        <li><strong>拖拽图片</strong>：放大后，按住鼠标左键并拖拽可以移动图片查看不同区域</li>
        <li><strong>删除图片</strong>：在预览中按 <code>Delete</code> 或 <code>Backspace</code> 键可以快速删除当前图片</li>
      </ul>
      <TipImageCarousel v-if="usageImages.length > 0" :images="usageImages" />
    </section>

    <section class="section">
      <h3>适用场景</h3>
      <p>应用内预览特别适合以下场景：</p>
      <ul>
        <li><strong>快速浏览</strong>：在画廊中快速查看多张图片，无需频繁打开和关闭系统图片查看器</li>
        <li><strong>批量查看</strong>：使用键盘快捷键连续切换图片，提高浏览效率</li>
        <li><strong>细节查看</strong>：放大图片查看细节，支持平滑缩放和拖拽</li>
        <li><strong>快速操作</strong>：在预览中直接执行删除、添加到画册等操作，无需返回列表</li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 预览功能示例图片
// 图片路径：/help-images/gallery/preview-feature-*.png
const previewImages = ref<TipImage[]>([]);

// 设置页面示例图片
// 图片路径：/help-images/gallery/preview-settings-*.png
const settingsImages = ref<TipImage[]>([]);

// 使用方法示例图片
// 图片路径：/help-images/gallery/preview-usage-*.png
const usageImages = ref<TipImage[]>([]);
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

  ul,
  ol {
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
        padding-left: 20px;
      }
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
