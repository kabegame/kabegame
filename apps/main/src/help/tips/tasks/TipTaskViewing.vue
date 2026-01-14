<template>
    <div class="tip-article">
        <section class="section">
            <h3>任务抽屉</h3>
            <p>在画廊、画册的右上角有一个<strong>任务按钮</strong>，点击后可以打开任务抽屉，查看所有任务的列表。</p>
            <p>任务抽屉中会显示：</p>
            <ul>
                <li><strong>任务名称</strong>：显示任务使用的插件名称和输出目录</li>
                <li><strong>任务状态</strong>：包括等待中、运行中、已完成、失败、已取消</li>
                <li><strong>进度信息</strong>：显示已收集的图片数量和总进度</li>
                <li><strong>操作按钮</strong>：可以查看详情、停止任务、删除任务等</li>
            </ul>
            <TipImageCarousel v-if="drawerImages.length > 0" :images="drawerImages" />
        </section>

        <section class="section">
            <h3>任务详情页</h3>
            <p>在任务抽屉中点击任务，或右键任务选择"查看详情"，可以进入任务详情页。</p>
            <p>任务详情页包含以下信息：</p>
            <ul>
                <li><strong>任务基本信息</strong>：任务名称、状态、使用的插件、输出目录等</li>
                <li><strong>已收集的图片</strong>：以网格形式展示任务已收集的所有图片</li>
                <li><strong>失败记录</strong>：如果任务中有图片下载失败，会显示失败原因和重试选项</li>
                <li><strong>操作按钮</strong>：刷新、停止任务、删除任务等</li>
            </ul>
            <TipImageCarousel v-if="detailImages.length > 0" :images="detailImages" />
        </section>

        <section class="section">
            <h3>任务状态说明</h3>
            <p>任务有以下几种状态：</p>
            <ul>
                <li><strong>等待中（pending）</strong>：任务已创建，等待开始执行</li>
                <li><strong>运行中（running）</strong>：任务正在执行，正在收集图片</li>
                <li><strong>已完成（completed）</strong>：任务已成功完成，所有图片都已收集</li>
                <li><strong>失败（failed）</strong>：任务执行过程中出现错误，已停止</li>
                <li><strong>已取消（cancelled）</strong>：任务被用户手动取消</li>
            </ul>
            <p>在任务详情页中，你可以查看任务的具体状态，以及每个状态下的详细信息。</p>
        </section>

        <section class="section">
            <h3>查看任务图片</h3>
            <p>在任务详情页中，所有已收集的图片会以网格形式展示，你可以：</p>
            <ul>
                <li><strong>浏览图片</strong>：滚动查看任务收集的所有图片</li>
                <li><strong>预览图片</strong>：双击图片可以打开预览对话框，查看大图</li>
                <li><strong>选择图片</strong>：点击图片可以选择，支持多选和范围选择</li>
                <li><strong>添加到画册</strong>：选择图片后，右键菜单可以选择"加入画册"</li>
                <li><strong>删除图片</strong>：选择图片后，可以删除任务中的图片（不影响已下载的文件）</li>
            </ul>
            <TipImageCarousel v-if="imagesViewImages.length > 0" :images="imagesViewImages" />
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 任务抽屉示例图片
// 图片路径：/help-images/tasks/viewing-drawer-*.png
const drawerImages = ref<TipImage[]>([]);

// 任务详情页示例图片
// 图片路径：/help-images/tasks/viewing-detail-*.png
const detailImages = ref<TipImage[]>([]);

// 任务图片查看示例图片
// 图片路径：/help-images/tasks/viewing-images-*.png
const imagesViewImages = ref<TipImage[]>([]);
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
