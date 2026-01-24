<template>
    <div class="tip-article">
        <el-alert class="note" type="warning" show-icon :closable="false" style="margin-bottom: 10px;">
            Light 模式不支持此功能
        </el-alert>
        <section class="section">
            <h3>插件编辑器是什么</h3>
            <p>插件编辑器是一个独立的窗口，用于创建、编辑和调试 Kabegame 的收集源插件。</p>
            <p>它提供了完整的插件开发环境，包括代码编辑、配置管理和插件打包功能。</p>
        </section>

        <section class="section">
            <h3>如何打开插件编辑器</h3>
            <ul>
                <li>在侧边栏进入<strong>源管理</strong>页面</li>
                <li>点击右上角的<strong>插件编辑器</strong>按钮</li>
                <li>系统会打开一个新的插件编辑器窗口</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                插件编辑器是一个独立窗口，可以与应用主窗口同时使用。
            </el-alert>
        </section>

        <section class="section">
            <h3>基本功能</h3>
            <ul>
                <li><strong>创建新插件</strong>：从零开始编写新的收集源插件</li>
                <li><strong>编辑已有插件</strong>：打开并修改已安装的插件代码</li>
                <li><strong>编写爬虫脚本</strong>：使用 Rhai 脚本语言编写 <code>crawl.rhai</code> 文件</li>
                <li><strong>配置插件信息</strong>：编辑 <code>plugin.json</code> 文件，设置插件名称、描述、版本等</li>
                <li><strong>打包插件</strong>：将插件打包成 <code>.kgpg</code> 格式，便于分发和导入</li>
                <li><strong>直接导入</strong>：打包完成后可以直接在编辑器内导入到应用</li>
            </ul>
        </section>

        <section class="section">
            <h3>适用场景</h3>
            <ul>
                <li><strong>自定义爬虫源</strong>：为特定网站或 API 编写收集插件</li>
                <li><strong>修改现有插件</strong>：调整已安装插件的爬取逻辑或参数</li>
                <li><strong>学习插件开发</strong>：查看和参考现有插件的代码结构</li>
                <li><strong>插件调试</strong>：测试和验证插件的功能是否正常</li>
            </ul>
        </section>

        <section class="section">
            <h3>注意事项</h3>
            <p>插件编辑器需要你了解 <strong>Rhai 脚本语言</strong>的基本语法。</p>
            <p>如果你不熟悉编程，建议先查看现有插件的代码作为参考，或使用应用内置的插件。</p>
            <el-alert class="note" type="warning" show-icon :closable="false">
                修改插件代码时请谨慎，错误的代码可能导致插件无法正常工作。
            </el-alert>
        </section>
    </div>
</template>

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

        li {
            margin-bottom: 4px;
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
