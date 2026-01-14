<template>
  <div class="tip-article">
    <section class="section">
      <h3>创建任务</h3>
      <p>创建收集任务有以下几种方式：</p>
      
      <h4>方式一：通过收集对话框创建</h4>
      <p>在画廊页面点击右上角的<strong>"收集"</strong>按钮，打开收集对话框：</p>
      <ul>
        <li><strong>选择源</strong>：从下拉列表中选择要使用的插件</li>
        <li><strong>配置参数</strong>：根据插件要求填写必要的参数（如搜索关键词、页码等）</li>
        <li><strong>输出目录</strong>：选择图片保存的位置（留空使用默认下载目录）</li>
        <li><strong>输出画册</strong>：可选，选择将图片添加到哪个画册（也可以新建画册）</li>
        <li><strong>运行配置</strong>：可选，选择之前保存的运行配置快速复用参数</li>
      </ul>
      <p>配置完成后，点击<strong>"开始收集"</strong>按钮即可创建任务。</p>
      <TipImageCarousel v-if="createDialogImages.length > 0" :images="createDialogImages" />

      <h4>方式二：拖入文件自动创建导入任务</h4>
      <p>将本地图片文件、文件夹或压缩包（zip）直接拖入应用窗口，会自动创建本地导入任务：</p>
      <ul>
        <li><strong>拖入图片文件</strong>：自动创建导入任务，将图片添加到画廊</li>
        <li><strong>拖入文件夹</strong>：递归扫描文件夹中的所有图片并导入</li>
        <li><strong>拖入压缩包</strong>：自动解压并导入其中的图片</li>
        <li><strong>可选创建画册</strong>：在导入确认窗口中可以选择"为每个来源创建画册"</li>
      </ul>
      <TipImageCarousel v-if="dragDropImages.length > 0" :images="dragDropImages" />
    </section>

    <section class="section">
      <h3>终止任务</h3>
      <p>如果任务正在运行，你可以随时终止它：</p>
      
      <h4>在任务抽屉中终止</h4>
      <p>打开任务抽屉，找到要终止的任务，<strong>右键点击</strong>选择<strong>"停止"</strong>，确认后任务将被终止。</p>
      
      <h4>在任务详情页终止</h4>
      <p>进入任务详情页，如果任务状态为"运行中"，右上角会显示<strong>"停止任务"</strong>按钮，点击即可终止任务。</p>
      
      <p><strong>注意事项</strong>：</p>
      <ul>
        <li>终止任务后，已下载的图片会保留，但未开始的任务将被取消</li>
        <li>任务终止后状态会变为"已取消"</li>
        <li>终止操作不可恢复，请谨慎操作</li>
      </ul>
      <TipImageCarousel v-if="stopImages.length > 0" :images="stopImages" />
    </section>

    <section class="section">
      <h3>删除任务</h3>
      <p>删除任务有以下几种方式：</p>
      
      <h4>在任务抽屉中删除</h4>
      <p>打开任务抽屉，找到要删除的任务，<strong>右键点击</strong>选择<strong>"删除"</strong>，确认后任务将被删除。</p>
      
      <h4>在任务详情页删除</h4>
      <p>进入任务详情页，点击右上角的<strong>"删除任务"</strong>按钮，确认后任务将被删除。</p>
      
      <p><strong>重要说明</strong>：</p>
      <ul>
        <li>如果任务正在运行，删除前会<strong>自动先终止任务</strong>，然后再删除</li>
        <li>删除任务只会删除任务记录，<strong>不会删除已下载的图片文件</strong></li>
        <li>删除操作不可恢复，请谨慎操作</li>
        <li>已完成的任务可以安全删除，不会影响已收集的图片</li>
      </ul>
      <TipImageCarousel v-if="deleteImages.length > 0" :images="deleteImages" />
    </section>

    <section class="section">
      <h3>批量操作</h3>
      <p>在任务抽屉中，你可以进行批量操作：</p>
      <ul>
        <li><strong>清除已完成任务</strong>：点击抽屉底部的"清除所有已完成/失败/已取消的任务"按钮，可以批量删除这些任务</li>
        <li><strong>保留运行中任务</strong>：批量删除时，等待中和运行中的任务会被保留，不会被删除</li>
      </ul>
      <el-alert class="note" type="info" show-icon :closable="false">
        批量删除操作同样不会删除已下载的图片文件，只会删除任务记录。
      </el-alert>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 创建任务对话框示例图片
// 图片路径：/help-images/tasks/management-create-dialog-*.png
const createDialogImages = ref<TipImage[]>([]);

// 拖入文件创建任务示例图片
// 图片路径：/help-images/tasks/management-drag-drop-*.png
const dragDropImages = ref<TipImage[]>([]);

// 终止任务示例图片
// 图片路径：/help-images/tasks/management-stop-*.png
const stopImages = ref<TipImage[]>([]);

// 删除任务示例图片
// 图片路径：/help-images/tasks/management-delete-*.png
const deleteImages = ref<TipImage[]>([]);
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
    margin: 12px 0 6px 0;
    font-size: 13px;
    font-weight: 700;
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

.note {
  margin-top: 6px;
}
</style>
