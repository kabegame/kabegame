<template>
    <div class="tip-article">
        <section class="section">
            <h3>方法一：双击插件文件导入</h3>
            <p>在资源管理器中直接<strong>双击</strong> <code>.kgpg</code> 插件文件，会自动打开导入窗口。</p>
            <p>这是最快捷的方式，适合从下载目录或网盘直接安装插件。</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                首次双击时，Windows 可能会询问"选择打开方式"，选择 Kabegame 即可。之后双击会自动关联。
            </el-alert>
            <TipImageCarousel v-if="method1Images.length > 0" :images="method1Images" />
        </section>

        <section class="section">
            <h3>方法二：拖入主窗口</h3>
            <p>把 <code>.kgpg</code> 文件直接<strong>拖到主窗口</strong>中，应用会自动识别并导入。</p>
            <p>可以同时拖入多个插件文件，应用会批量处理。</p>
            <TipImageCarousel v-if="method2Images.length > 0" :images="method2Images" />
        </section>

        <section class="section">
            <h3>方法三：从源管理页面导入</h3>
            <p>在侧边栏进入<strong>源管理</strong>页面，点击右上角的<strong>导入源</strong>按钮。</p>
            <p>在弹出的文件选择对话框中，选择要导入的 <code>.kgpg</code> 文件即可。</p>
            <TipImageCarousel v-if="method3Images.length > 0" :images="method3Images" />
        </section>

        <section class="section">
            <h3>方法四：通过插件编辑器自行编写并导入</h3>
            <p>在侧边栏进入<strong>源管理</strong>页面，点击右上角的<strong>插件编辑器</strong>按钮。</p>
            <p>在插件编辑器中：</p>
            <ul>
                <li>可以创建新插件或编辑已有插件</li>
                <li>编写 <code>crawl.rhai</code> 爬虫脚本（Rhai 语言）</li>
                <li>配置 <code>manifest.json</code> 和 <code>config.json</code></li>
                <li>添加插件图标和文档</li>
                <li>使用编辑器内置的打包功能生成 <code>.kgpg</code> 文件</li>
                <li>打包完成后，可以直接在编辑器内导入，或使用上述其他方法导入</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                插件编辑器提供了完整的插件开发环境，适合想要自定义爬虫源或修改现有插件的用户。
            </el-alert>
            <TipImageCarousel v-if="method4Images.length > 0" :images="method4Images" />
        </section>

        <section class="section">
            <h3>导入后的处理</h3>
            <p>无论使用哪种方法，导入成功后：</p>
            <ul>
                <li>插件会自动安装到<strong>已安装源</strong>列表中</li>
                <li>如果插件已存在（同名），会提示是否覆盖/更新</li>
                <li>导入完成后，可以在“源管理”的“已安装源”tab 中查看和管理</li>
            </ul>
        </section>

        <section class="section">
            <h3>插件文件格式</h3>
            <p>插件文件是 <code>.kgpg</code> 格式的压缩包，包含：</p>
            <ul>
                <li><code>manifest.json</code>：插件元信息（名称、版本、描述等）</li>
                <li><code>crawl.rhai</code>：Rhai 爬虫脚本（必需）</li>
                <li><code>config.json</code>：插件配置与变量定义（可选）</li>
                <li><code>icon.png</code>：插件图标（可选）</li>
                <li><code>doc_root/</code>：插件文档目录（可选）</li>
            </ul>
        </section>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import TipImageCarousel from "@/help/components/TipImageCarousel.vue";
import type { TipImage } from "@/help/components/TipImageCarousel.vue";

// 方法一：双击导入的示例图片
// 图片路径：/help-images/plugins/import-method1-*.png
const method1Images = ref<TipImage[]>([]);

// 方法二：拖入主窗口的示例图片
// 图片路径：/help-images/plugins/import-method2-*.png
const method2Images = ref<TipImage[]>([]);

// 方法三：从源管理页面导入的示例图片
// 图片路径：/help-images/plugins/import-method3-*.png
const method3Images = ref<TipImage[]>([]);

// 方法四：插件编辑器的示例图片
// 图片路径：/help-images/plugins/import-method4-*.png
const method4Images = ref<TipImage[]>([]);
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
