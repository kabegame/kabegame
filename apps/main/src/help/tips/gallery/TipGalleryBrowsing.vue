<template>
    <div class="tip-article">
        <section class="section">
            <h3>总数提示</h3>
            <p>画廊顶部工具栏的副标题会显示当前浏览的图片总数。</p>
            <ul>
                <li><strong>未启用分页时</strong>：显示 <code>共 X 张图片</code></li>
                <li><strong>启用分页时</strong>：显示 <code>第 X / Y</code>（X 为当前位置，Y 为总图片数）</li>
            </ul>
            <p>这个提示会实时更新，当你删除图片、导入新图片或执行去重操作后，总数会相应变化。</p>
            <TipImageCarousel v-if="totalCountImages.length > 0" :images="totalCountImages" />
        </section>

        <section class="section">
            <h3>分页浏览</h3>
            <p>当画廊中的图片总数超过 <strong>100 张</strong> 时，会自动启用分页功能。</p>
            <p>分页器会显示在画廊顶部工具栏下方，包含以下功能：</p>
            <ul>
                <li><strong>上一页/下一页</strong>：快速切换相邻页面</li>
                <li><strong>页码输入框</strong>：直接输入页码跳转到指定页面</li>
                <li><strong>总页数显示</strong>：显示当前为第几页，共多少页</li>
            </ul>
            <p>每页显示 <strong>100 张图片</strong></p>
            <TipImageCarousel v-if="paginationImages.length > 0" :images="paginationImages" />
        </section>

        <section class="section">
            <h3>整理功能</h3>
            <p>画廊工具栏中有一个 <strong>"整理"</strong> 按钮（带过滤图标），可以帮你对画廊进行综合整理。</p>
            <p>整理功能包含三个可选操作：</p>
            <ul>
                <li><strong>去重</strong>：基于文件的哈希值（SHA256）清理重复图片，即使文件名不同，只要文件内容相同就会被移除</li>
                <li><strong>清除失效图片</strong>：移除画廊中本地文件已不存在的图片记录</li>
                <li><strong>补充缩略图</strong>：为缺失缩略图的图片生成缩略图</li>
            </ul>
            <p>点击"整理"按钮后，会弹出整理选项对话框，你可以选择需要执行的操作。整理过程会在后台执行，支持取消操作。</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                整理操作会立即生效，建议根据需要选择合适的整理选项。
            </el-alert>
            <TipImageCarousel v-if="dedupeImages.length > 0" :images="dedupeImages" />
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 总数提示示例图片
// 图片路径：/help-images/gallery/browsing-total-count-*.png
const totalCountImages = ref<TipImage[]>([]);

// 分页功能示例图片
// 图片路径：/help-images/gallery/browsing-pagination-*.png
const paginationImages = ref<TipImage[]>([]);

// 去重功能示例图片
// 图片路径：/help-images/gallery/browsing-dedupe-*.png
const dedupeImages = ref<TipImage[]>([]);
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
