<template>
  <div class="tip-article">
    <section class="section">
      <h3>怎么用</h3>
      <p>把本地图片文件、包含图片的文件夹，或图片压缩包（zip）直接拖到主窗口中。</p>
      <p><strong>可以同时拖入多种类型</strong>：你可以一次性选择并拖入多个图片文件、多个文件夹、多个压缩包，或它们的任意组合。应用会统一处理并显示在导入确认窗口中。</p>
      <p>应用会弹出导入确认窗口，你可以选择是否<strong>为每个来源创建画册</strong>（推荐：导入大批量素材时更好管理）。</p>
      <TipImageCarousel v-if="usageImages.length > 0" :images="usageImages" />
    </section>

    <section class="section">
      <h3>文件夹导入</h3>
      <p>拖入文件夹时，会递归扫描子目录并导入其中的图片。</p>
      <p>如果开启了"为每个来源创建画册"，会为该文件夹创建一个同名画册，并把导入结果放入该画册。</p>
      <TipImageCarousel v-if="folderImages.length > 0" :images="folderImages" />
    </section>

    <section class="section">
      <h3>压缩包导入（zip）</h3>
      <p>拖入 zip 时，后端会智能导入其中的图片，无需手动解压。</p>
      <p>导入时如果勾选了"为每个来源创建画册"，会为该 zip 创建一个同名画册，并把导入结果放入该画册。</p>
      <TipImageCarousel v-if="zipImages.length > 0" :images="zipImages" />
    </section>

    <section class="section">
      <h3>重要说明：本地导入插件必须存在</h3>
      <p>拖入导入依赖内置的本地导入源插件：<code>本地导入（local-import）</code>。</p>
      <p>如果你的已安装源中缺少 <code>本地导入</code>插件，导入会失败（因为无法创建对应任务）。</p>
      <el-alert class="note" type="warning" show-icon :closable="false">
        如果你打算精简/定制插件包，记得保留 <code>local-import</code>。
      </el-alert>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

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
