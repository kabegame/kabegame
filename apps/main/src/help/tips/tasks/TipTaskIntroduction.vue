<template>
    <div class="tip-article">
        <section class="section">
            <h3>任务是什么？</h3>
            <p><strong>任务</strong>是 Kabegame 中执行图片收集的工作单元。每个任务代表一次完整的图片收集过程，包括：</p>
            <ul>
                <li><strong>使用指定的插件</strong>：任务会执行某个源插件的脚本，从目标网站或本地文件系统收集图片</li>
                <li><strong>按照配置的参数</strong>：根据你提供的参数（如搜索关键词、页码、URL 等）执行收集逻辑</li>
                <li><strong>下载图片到指定位置</strong>：将收集到的图片下载并保存到你指定的输出目录</li>
                <li><strong>添加到画廊和画册</strong>：下载完成后，图片会自动添加到画廊，如果指定了画册，也会添加到对应画册</li>
            </ul>
            <p>任务创建后，会在后台自动执行，你可以在任务抽屉中查看进度和状态。</p>
        </section>

        <section class="section">
            <h3>任务做了什么？</h3>
            <p>任务执行时会完成以下工作：</p>

            <h4>1. 执行插件脚本</h4>
            <p>根据你选择的插件，任务会执行对应的 Rhai 脚本，访问目标网站或本地文件系统，获取图片列表。</p>

            <h4>2. 下载图片</h4>
            <p>对于网络源插件，任务会下载图片文件到本地；对于本地导入插件，任务会扫描并导入本地文件。</p>
            <ul>
                <li>网络下载：支持断点续传、重试机制，确保图片完整下载</li>
                <li>本地导入：递归扫描文件夹，识别并导入支持的图片格式</li>
            </ul>

            <h4>3. 保存到指定目录</h4>
            <p>图片会保存到你指定的输出目录（如果未指定，则使用默认下载目录），并按插件 ID 分文件夹组织。</p>

            <h4>4. 添加到画廊和画册</h4>
            <p>下载完成后，图片会自动添加到画廊，方便你浏览和管理。如果创建任务时指定了画册，图片也会自动添加到该画册中。</p>

            <h4>5. 记录任务信息</h4>
            <p>任务会记录执行过程中的所有信息，包括：收集的图片数量、下载进度、失败记录等，方便你查看和管理。</p>
        </section>

        <section class="section">
            <h3>最大运行任务数量</h3>
            <p>Kabegame <strong>限制同时运行的任务数量为10个</strong>，超过10个的任务会进入等待中状态，排队等待执行</p>

            <p>任务的执行速度受以下因素影响：</p>
            <ul>
                <li><strong>最大并发下载量</strong>：在"设置 → 下载设置"中可以配置同时下载的图片数量（1-10）</li>
                <li>这个设置控制的是<strong>所有任务总共同时下载的图片数量</strong>，而不是单个任务的并发数</li>
                <li>例如：如果设置为 5，那么即使有 10 个任务在运行，同时最多只会下载 5 张图片</li>
            </ul>

            <p><strong>任务排队机制</strong>：</p>
            <ul>
                <li>新创建的任务如果达到并发下载限制，会进入"等待中"状态</li>
                <li>当有下载槽位空闲时，等待中的任务会自动开始执行</li>
                <li>你可以在任务抽屉中看到所有任务的状态：等待中、运行中、已完成、失败、已取消</li>
            </ul>

            <el-alert class="note" type="info" show-icon :closable="false">
                <p><strong>提示</strong>：如果任务一直显示"等待中"，可能是因为达到了最大并发下载数限制。你可以：</p>
                <ul style="margin: 8px 0 0 0; padding-left: 20px;">
                    <li>等待其他任务完成，释放下载槽位</li>
                    <li>在设置中增加"最大并发下载量"（注意：过高的并发数可能影响网络稳定性）</li>
                    <li>手动停止或删除不需要的任务</li>
                </ul>
            </el-alert>
        </section>

        <section class="section">
            <h3>任务类型</h3>
            <p>根据使用的插件类型，任务可以分为：</p>
            <ul>
                <li><strong>网络收集任务</strong>：使用网络源插件（如 konachan、anihonet-wallpaper 等），从网站下载图片</li>
                <li><strong>本地导入任务</strong>：使用本地导入插件（local-import），从本地文件系统导入图片</li>
            </ul>
            <p>两种类型的任务执行流程基本相同，只是数据来源不同。</p>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 任务说明示例图片（如果需要）
// 图片路径：/help-images/tasks/introduction-*.png
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

    :deep(.el-alert__content) {
        p {
            margin: 0 0 8px 0;
        }

        ul {
            margin: 8px 0 0 0;
            padding-left: 20px;
        }
    }
}
</style>
