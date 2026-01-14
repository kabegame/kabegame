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
            <p>当画廊中的图片总数超过 <strong>1000 张</strong> 时，会自动启用分页功能。</p>
            <p>分页器会显示在画廊顶部工具栏下方，包含以下功能：</p>
            <ul>
                <li><strong>上一页/下一页</strong>：快速切换相邻页面</li>
                <li><strong>页码输入框</strong>：直接输入页码跳转到指定页面</li>
                <li><strong>总页数显示</strong>：显示当前为第几页，共多少页</li>
            </ul>
            <p>每页显示 <strong>1000 张图片</strong>，这样无论多慢的电脑，都能畅游自己的图库啦。</p>
            <TipImageCarousel v-if="paginationImages.length > 0" :images="paginationImages" />
        </section>

        <section class="section">
            <h3>去重功能</h3>
            <p>画廊工具栏中有一个 <strong>"去重"</strong> 按钮（带过滤图标），可以帮你快速清理重复的图片。</p>
            <p>去重功能基于文件的哈希值（SHA256）来判断图片是否重复，即使文件名不同，只要文件内容相同就会被识别为重复。</p>
            <p>点击"去重"按钮后，会弹出确认对话框，你可以选择：</p>
            <ul>
                <li><strong>仅从画廊移除</strong>：只删除画廊中的记录，保留电脑上的源文件（推荐）</li>
                <li><strong>同时删除源文件</strong>：从画廊移除记录，并永久删除电脑上的重复文件（<strong>慎用，不可恢复</strong>）</li>
            </ul>
            <p>去重过程中会显示进度条，你可以随时点击取消按钮中断操作。</p>
            <el-alert class="note" type="warning" show-icon :closable="false">
                如果选择"同时删除源文件"，该操作不可恢复，请谨慎使用。建议先选择"仅从画廊移除"测试效果。
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
