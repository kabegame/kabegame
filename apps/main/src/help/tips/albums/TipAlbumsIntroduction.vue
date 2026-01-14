<template>
    <div class="tip-article">
        <section class="section">
            <h3>什么是画册？</h3>
            <p>画册是用于整理和分类图片的功能，类似于相册或收藏夹。你可以创建多个画册，把不同主题、来源或用途的图片分别整理到不同的画册中。</p>
            <p>画册与画廊的区别：</p>
            <ul>
                <li><strong>画廊</strong>：包含所有收集到的图片，按插件、时间等维度自动分类浏览</li>
                <li><strong>画册</strong>：由你手动创建和管理，可以自由选择哪些图片加入画册</li>
            </ul>
            <p>一张图片可以同时存在于多个画册中，画册只是对图片的引用，不会复制文件。</p>
        </section>

        <section class="section">
            <h3>创建画册</h3>
            <p>在“画册”页面（左侧菜单），点击右上角的 <strong>“新建画册”</strong> 按钮，输入画册名称即可创建。</p>
            <p>画册名称最多 50 个字符，建议使用有意义的名称，方便后续查找和管理。</p>
            <TipImageCarousel v-if="createImages.length > 0" :images="createImages" />
        </section>

        <section class="section">
            <h3>添加图片到画册</h3>
            <p>有多种方式可以将图片添加到画册：</p>
            <ul>
                <li><strong>从画廊添加</strong>：在画廊中选择图片（单选或多选），右键菜单选择“加入画册”，选择目标画册或新建画册</li>
                <li><strong>从画册详情添加</strong>：在画册详情页中，选择图片后右键菜单选择“加入画册”，可以添加到其他画册</li>
                <li><strong>从任务详情添加</strong>：在任务详情页中，选择图片后右键菜单选择“加入画册”</li>
                <li><strong>导入时创建画册</strong>：拖入文件/文件夹导入时，可以选择“为每个来源创建画册”，自动创建并导入</li>
            </ul>
            <p>添加图片时，如果图片已经在目标画册中，会自动跳过，不会重复添加。</p>
            <TipImageCarousel v-if="addImages.length > 0" :images="addImages" />
        </section>

        <section class="section">
            <h3>画册管理</h3>
            <p>在画册列表页面，你可以：</p>
            <ul>
                <li><strong>查看画册</strong>：点击画册卡片进入详情页，查看画册中的所有图片</li>
                <li><strong>重命名画册</strong>：在画册详情页，双击画册名称即可重命名（或点击标题进入编辑模式）</li>
                <li><strong>删除画册</strong>：在画册详情页，点击右上角的“删除画册”按钮（<strong>注意：删除画册不会删除图片文件，只是移除画册记录</strong>）</li>
                <li><strong>设为轮播壁纸</strong>：在画册详情页，点击“设为轮播壁纸”按钮，可以将该画册设为壁纸轮播源</li>
            </ul>
            <TipImageCarousel v-if="manageImages.length > 0" :images="manageImages" />
        </section>

        <section class="section">
            <h3>从画册移除图片</h3>
            <p>在画册详情页中，选择图片后右键菜单选择“从画册移除”，可以：</p>
            <ul>
                <li><strong>仅从画册移除</strong>：只移除画册中的记录，图片文件和其他画册中的记录都保留（推荐）</li>
                <li><strong>同时删除图片</strong>：从画册移除，并永久删除电脑上的图片文件（<strong>慎用，不可恢复</strong>）</li>
            </ul>
            <el-alert class="note" type="warning" show-icon :closable="false">
                如果选择“同时删除图片”，该操作不可恢复，请谨慎使用。建议先选择“仅从画册移除”测试效果。
            </el-alert>
            <TipImageCarousel v-if="removeImages.length > 0" :images="removeImages" />
        </section>

        <section class="section">
            <h3>画册与壁纸轮播</h3>
            <p>画册可以作为壁纸轮播的源：</p>
            <ul>
                <li>在画册详情页，点击 <strong>“设为轮播壁纸”</strong> 按钮，可以将该画册设为壁纸轮播源</li>
                <li>在设置页的“壁纸轮播”标签中，也可以选择画册作为轮播源</li>
                <li>轮播会从选定的画册中按顺序或随机选择图片更换桌面壁纸</li>
            </ul>
            <p>如果删除的画册正在被壁纸轮播引用，轮播会自动关闭，切回单张壁纸模式。</p>
        </section>

        <section class="section">
            <h3>画册数量限制</h3>
            <p>每个画册最多可以包含 <strong>100,000 张图片</strong>。当画册中的图片数量接近或达到上限时，画册详情页顶部会显示警告提示。</p>
            <p>如果画册图片数量过多，建议：</p>
            <ul>
                <li>创建多个画册，按主题或时间分类</li>
                <li>定期清理不需要的图片</li>
                <li>使用画廊的分页功能浏览大量图片</li>
            </ul>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 创建画册示例图片
// 图片路径：/help-images/albums/introduction-create-*.png
const createImages = ref<TipImage[]>([]);

// 添加图片示例图片
// 图片路径：/help-images/albums/introduction-add-*.png
const addImages = ref<TipImage[]>([]);

// 画册管理示例图片
// 图片路径：/help-images/albums/introduction-manage-*.png
const manageImages = ref<TipImage[]>([]);

// 移除图片示例图片
// 图片路径：/help-images/albums/introduction-remove-*.png
const removeImages = ref<TipImage[]>([]);
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
