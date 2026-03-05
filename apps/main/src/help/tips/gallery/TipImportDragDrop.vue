<template>
  <div class="tip-article">
    <section class="section">
      <h3>导入方式概览</h3>
      <p>本地导入功能已内置，无需单独安装「本地导入」插件。你可以通过以下方式将本地图片加入画廊：</p>
      <ul>
        <li><strong>桌面</strong>：将图片/文件夹/压缩包<strong>拖入窗口</strong>，或在画廊右上角点击「开始收集」→ 选择「本地」打开导入对话框。</li>
        <li><strong>安卓</strong>：在画廊右上角点击「开始收集」→ 选择「本地」，通过系统媒体选择器勾选要导入的图片。</li>
      </ul>
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>桌面：拖入导入</h3>
      <p>把本地图片文件、包含图片的文件夹，或图片压缩包（zip）直接拖到主窗口中。</p>
      <p><strong>可以同时拖入多种类型</strong>：你可以一次性选择并拖入多个图片文件、多个文件夹、多个压缩包，或它们的任意组合。应用会统一处理并显示在导入确认窗口中。</p>
      <p>应用会弹出导入确认窗口，你可以选择是否<strong>为每个来源创建画册</strong>（推荐：导入大批量素材时更好管理）。</p>
      <TipImageCarousel v-if="usageImages.length > 0" :images="usageImages" />
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>桌面：右上角「开始收集」→ 本地</h3>
      <p>在画廊页面点击右上角「开始收集」按钮，在下拉菜单中选择「本地」，会打开本地导入对话框。你可以通过「添加文件」「添加文件夹」选择要导入的内容，同样支持为每个来源创建画册。</p>
    </section>

    <section class="section" v-if="IS_ANDROID">
      <h3>安卓：右上角「开始收集」→ 本地</h3>
      <p>在画廊页面点击右上角「开始收集」按钮，在弹层中选择「本地」，会打开系统媒体选择器。勾选要导入的图片后确认，应用会创建导入任务并将图片加入画廊。</p>
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>文件夹导入</h3>
      <p>拖入文件夹时，会递归扫描子目录并导入其中的图片。</p>
      <p>如果开启了"为每个来源创建画册"，会为该文件夹创建一个同名画册，并把导入结果放入该画册。</p>
      <TipImageCarousel v-if="folderImages.length > 0" :images="folderImages" />
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>压缩包导入（zip）</h3>
      <p>拖入 zip 时，后端会智能导入其中的图片，无需手动解压。</p>
      <p>导入时如果勾选了"为每个来源创建画册"，会为该 zip 创建一个同名画册，并把导入结果放入该画册。</p>
      <TipImageCarousel v-if="zipImages.length > 0" :images="zipImages" />
    </section>

    <section class="section" v-if="!IS_ANDROID">
      <h3>macOS：若导入「图片」「桌面」等文件夹失败</h3>
      <p>在 macOS 上，「图片」「桌面」「文稿」「下载」等为系统受保护文件夹。<strong>拖拽导入</strong>可能无法访问这些目录（会提示“权限不足”）。</p>
      <p><strong>解决办法：</strong></p>
      <ul>
        <li>优先使用「添加文件夹」按钮，在系统选择器中选中该文件夹，再开始导入。</li>
        <li>若仍无法访问，请打开 <strong>系统设置 → 隐私与安全性 → 文件与文件夹</strong>，为 Kabegame 开启对应目录（如「图片」）的访问权限。</li>
      </ul>
    </section>

    <section class="section">
      <h3>重要说明：本地导入插件建议删除，该功能已内置</h3>
      <p>本地导入能力已内置在应用中，不再依赖单独的「本地导入（local-import）」源插件。若你曾单独安装过该插件，建议在源管理中删除，避免重复或混淆。</p>
      <el-alert class="note" type="info" show-icon :closable="false">
        删除旧插件不影响使用；拖入或右上角「开始收集」→ 本地 的导入方式会继续正常工作。
      </el-alert>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";
import { IS_ANDROID } from "@kabegame/core/env";

// 使用方法示例图片
// 图片路径：/help-images/import/drag-drop-usage-*.png
const usageImages = ref<TipImage[]>([]);

// 文件夹导入示例图片
// 图片路径：/help-images/import/drag-drop-folder-*.png
const folderImages = ref<TipImage[]>([]);

// 压缩包导入示例图片
// 图片路径：/help-images/import/drag-drop-zip-*.png
const zipImages = ref<TipImage[]>([]);
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
    margin: 0 0 8px 0;
    padding-left: 20px;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
  }

  li {
    margin-bottom: 4px;
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
