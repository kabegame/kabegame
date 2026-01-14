<template>
    <div class="tip-article">
        <section class="section">
            <h3>打开收集对话框</h3>
            <p>在<strong>画廊</strong>页面，点击右上角的<strong>收集</strong>按钮（或空状态下的"开始导入"按钮），打开收集对话框。</p>
            <p>这是创建爬取任务的主要入口，用于配置插件参数并开始收集图片。</p>
            <TipImageCarousel v-if="openDialogImages.length > 0" :images="openDialogImages" />
        </section>

        <section class="section">
            <h3>选择插件源</h3>
            <p>在收集对话框中，从<strong>选择源</strong>下拉菜单中挑选已安装的插件。</p>
            <p>下拉菜单会显示所有已安装的源插件，包括：</p>
            <ul>
                <li>从商店安装的插件</li>
                <li>手动导入的插件（.kgpg 文件）</li>
                <li>内置插件（如 <code>local-import</code>）</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                如果下拉菜单为空，说明还没有安装任何插件。请先到"源管理"页面安装插件。
            </el-alert>
            <TipImageCarousel v-if="selectPluginImages.length > 0" :images="selectPluginImages" />
        </section>

        <section class="section">
            <h3>配置插件变量</h3>
            <p>选择插件后，如果该插件定义了配置变量，会在<strong>插件配置</strong>区域显示。</p>
            <p>常见的配置类型包括：</p>
            <ul>
                <li><strong>文本输入</strong>：如目标 URL、搜索关键词等</li>
                <li><strong>数字输入</strong>：如页码、数量限制等（支持最小值/最大值限制）</li>
                <li><strong>下拉选择</strong>：从预设选项中选择</li>
                <li><strong>开关</strong>：布尔值配置</li>
                <li><strong>多选</strong>：列表或复选框类型</li>
                <li><strong>文件/文件夹路径</strong>：通过浏览按钮选择本地路径</li>
            </ul>
            <p>根据插件的要求填写这些配置，必填项会标注红色星号（*）。</p>
            <TipImageCarousel v-if="configVarsImages.length > 0" :images="configVarsImages" />
        </section>

        <section class="section">
            <h3>设置输出目录和画册</h3>
            <p><strong>输出目录</strong>：指定图片保存位置。留空则使用默认下载目录（可在设置中配置）。</p>
            <p><strong>输出画册</strong>：选择将收集的图片添加到哪个画册，或选择"+ 新建画册"创建新画册。留空则仅添加到画廊。</p>
            <p>对于本地导入（<code>local-import</code> 插件），还可以勾选<strong>为该文件夹/压缩包创建画册</strong>，自动为每个导入来源创建同名画册。</p>
            <TipImageCarousel v-if="outputSettingsImages.length > 0" :images="outputSettingsImages" />
        </section>

        <section class="section">
            <h3>保存运行配置（可选）</h3>
            <p>在<strong>运行配置</strong>下拉菜单中，可以保存当前的任务配置，方便下次快速复用。</p>
            <p>保存配置后，下次创建任务时可以直接选择该配置，无需重新填写所有参数。</p>
            <p>配置会保存以下信息：</p>
            <ul>
                <li>选择的插件</li>
                <li>插件变量值</li>
                <li>输出目录（如果指定）</li>
            </ul>
            <el-alert class="note" type="warning" show-icon :closable="false">
                注意：如果插件版本更新导致配置不兼容，会显示"不兼容"标签，需要重新配置。
            </el-alert>
            <TipImageCarousel v-if="saveConfigImages.length > 0" :images="saveConfigImages" />
        </section>

        <section class="section">
            <h3>开始收集和查看进度</h3>
            <p>配置完成后，点击<strong>开始收集</strong>按钮创建任务。</p>
            <p>任务创建后：</p>
            <ul>
                <li>可以在右下角的<strong>任务抽屉</strong>中查看任务列表和进度</li>
                <li>任务状态包括：等待中、运行中、已完成、失败、已取消</li>
                <li>点击任务可以查看详情，包括已收集的图片和失败记录</li>
                <li>运行中的任务可以随时停止</li>
            </ul>
            <p>收集完成后，图片会自动保存到指定目录，并添加到画廊（和画册，如果指定了）。</p>
            <TipImageCarousel v-if="taskProgressImages.length > 0" :images="taskProgressImages" />
        </section>

        <section class="section">
            <h3>常见问题</h3>
            <p><strong>Q: 任务一直显示"等待中"？</strong></p>
            <p>A: 检查是否达到最大并发下载数限制（在设置中配置）。如果已有多个任务在运行，新任务会排队等待。</p>

            <p><strong>Q: 任务失败怎么办？</strong></p>
            <p>A: 点击任务查看详情，可以查看失败原因。常见原因包括网络错误、插件配置错误、目标 URL 无效等。可以修改配置后重试失败项。</p>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 打开对话框的示例图片
// 图片路径：/help-images/plugins/usage-open-dialog-*.png
const openDialogImages = ref<TipImage[]>([]);

// 选择插件的示例图片
// 图片路径：/help-images/plugins/usage-select-plugin-*.png
const selectPluginImages = ref<TipImage[]>([]);

// 配置变量的示例图片
// 图片路径：/help-images/plugins/usage-config-vars-*.png
const configVarsImages = ref<TipImage[]>([]);

// 输出设置的示例图片
// 图片路径：/help-images/plugins/usage-output-settings-*.png
const outputSettingsImages = ref<TipImage[]>([]);

// 保存配置的示例图片
// 图片路径：/help-images/plugins/usage-save-config-*.png
const saveConfigImages = ref<TipImage[]>([]);

// 任务进度的示例图片
// 图片路径：/help-images/plugins/usage-task-progress-*.png
const taskProgressImages = ref<TipImage[]>([]);
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
