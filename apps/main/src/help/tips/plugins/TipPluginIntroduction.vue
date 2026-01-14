<template>
  <div class="tip-article">
    <section class="section">
      <h3>什么是插件？</h3>
      <p>
        <strong>插件</strong>（也叫"源"）是 Kabegame 的核心功能，用于从各种网站收集图片资源。
      </p>
      <p>
        每个插件定义了如何从特定网站爬取图片，包括：目标 URL 的解析、图片链接的提取、元数据的获取等。
      </p>
      <p>
        通过安装不同的插件，你可以从多个来源收集图片，统一管理在你的画廊和画册中。
      </p>
    </section>

    <section class="section">
      <h3>插件文件格式</h3>
      <p>
        插件以 <code>.kgpg</code> 文件格式提供，本质上是一个 ZIP 压缩包，包含以下文件：
      </p>
      <ul>
        <li><code>manifest.json</code>：插件元数据（名称、版本、描述、配置变量等）</li>
        <li><code>crawl.rhai</code>：爬取逻辑脚本（使用 Rhai 脚本语言编写）</li>
        <li><code>icon.png</code>（可选）：插件图标</li>
        <li><code>README.md</code>（可选）：插件使用说明</li>
      </ul>
      <p>
        你可以通过<strong>插件编辑器</strong>查看和编辑插件的源代码，也可以自己编写插件。
      </p>
    </section>

    <section class="section">
      <h3>插件的类型</h3>
      <p>根据功能，插件可以分为以下几类：</p>
      <ul>
        <li>
          <strong>网络爬取插件</strong>：从在线网站爬取图片（如 Konachan、Anihonet 等）
        </li>
        <li>
          <strong>本地导入插件</strong>：从本地文件系统导入图片（如内置的 <code>local-import</code> 插件）
        </li>
        <li>
          <strong>自定义插件</strong>：用户自己编写的插件，可以爬取任何支持的目标网站
        </li>
      </ul>
    </section>

    <section class="section">
      <h3>插件的作用</h3>
      <p>插件让你能够：</p>
      <ul>
        <li>从多个不同的网站收集图片，统一管理</li>
        <li>自定义爬取参数（如搜索关键词、页码、数量限制等）</li>
        <li>自动保存图片到指定目录，并添加到画廊或画册</li>
        <li>通过任务系统跟踪爬取进度和状态</li>
      </ul>
      <p>
        没有插件，应用就无法收集图片。所以<strong>安装插件是使用 Kabegame 的第一步</strong>。
      </p>
    </section>

    <section class="section">
      <h3>如何获取插件？</h3>
      <p>你可以通过以下方式获取插件：</p>
      <ul>
        <li>
          <strong>从商店安装</strong>：在"源管理"页面浏览商店源，找到喜欢的插件直接安装
        </li>
        <li>
          <strong>手动导入</strong>：如果你有 <code>.kgpg</code> 文件，可以通过拖入窗口、双击文件、或在源管理页面导入
        </li>
        <li>
          <strong>自己编写</strong>：使用插件编辑器编写自己的插件（需要了解 Rhai 脚本语言）
        </li>
      </ul>
      <el-alert class="note" type="info" show-icon :closable="false">
        提示：内置的 <code>local-import</code> 插件已经预装，用于本地文件导入功能。如果你删除了它，拖入导入功能将无法使用。
      </el-alert>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 插件说明的示例图片（如果有的话）
// 图片路径：/help-images/plugins/introduction-*.png
const introductionImages = ref<TipImage[]>([]);
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
