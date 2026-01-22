<template>
    <div class="tip-article">
        <section class="section">
            <h3>什么是命令行工具</h3>
            <p>Kabegame 提供了一个命令行工具（CLI），可以通过终端/命令提示符来执行插件相关操作。</p>
            <p>适合：自动化脚本、批量处理、不打开主窗口的情况下运行插件等场景。</p>
        </section>

        <section class="section">
            <h3>如何启动命令行工具</h3>
            <p>命令行工具通常位于应用安装目录下，名为 <code>kabegame-cli</code>（Windows）或 <code>kabegame-cli.exe</code>。</p>
            <p>在终端/命令提示符中，你可以直接运行：</p>
            <CodeBlock code="kabegame-cli --help" />
            <p>这会显示所有可用的命令和选项。</p>
        </section>

        <section class="section">
            <h3>主要命令</h3>
            
            <h4>1. 运行插件（plugin run）</h4>
            <p>通过命令行运行已安装的插件或本地插件文件：</p>
            <CodeBlock code="kabegame-cli plugin run --plugin <插件ID或路径> [选项] -- <插件参数>" />
            <p><strong>参数说明：</strong></p>
            <ul>
                <li><code>--plugin</code> 或 <code>-p</code>：插件 ID（已安装的插件）或 .kgpg 文件路径</li>
                <li><code>--output-dir</code> 或 <code>-o</code>：输出目录（可选，不指定则使用默认目录）</li>
                <li><code>--task-id</code>：任务 ID（可选，不指定则自动生成）</li>
                <li><code>--output-album-id</code>：输出画册 ID（可选）</li>
                <li><code>--</code> 之后：传给插件的参数（会映射到插件的 var 变量）</li>
            </ul>
            <p><strong>示例：</strong></p>
            <CodeBlock code='kabegame-cli plugin run --plugin konachan --output-dir ./downloads -- --tags="yuri rating:safe"' />

            <h4>2. 打包插件（plugin pack）</h4>
            <p>将插件目录打包为 .kgpg 文件：</p>
            <CodeBlock code="kabegame-cli plugin pack --plugin-dir <插件目录> --output <输出.kgpg路径>" />
            <p><strong>参数说明：</strong></p>
            <ul>
                <li><code>--plugin-dir</code>：包含 manifest.json 和 crawl.rhai 的插件目录</li>
                <li><code>--output</code>：输出的 .kgpg 文件路径</li>
            </ul>
            <p><strong>示例：</strong></p>
            <CodeBlock code="kabegame-cli plugin pack --plugin-dir ./my-plugin --output ./my-plugin.kgpg" />

            <h4>3. 导入插件（plugin import）</h4>
            <p>导入本地 .kgpg 插件文件到应用：</p>
            <CodeBlock code="kabegame-cli plugin import <.kgpg文件路径> [--no-ui]" />
            <p><strong>参数说明：</strong></p>
            <ul>
                <li>第一个参数：.kgpg 文件路径</li>
                <li><code>--no-ui</code>：不启动 UI，直接执行导入（适合脚本/自动化）</li>
            </ul>
            <p><strong>示例：</strong></p>
            <CodeBlock code="kabegame-cli plugin import ./my-plugin.kgpg" />
        </section>

        <section class="section">
            <h3>使用场景</h3>
            <ul>
                <li><strong>自动化脚本</strong>：编写批处理脚本，定期运行插件收集图片</li>
                <li><strong>批量处理</strong>：一次性运行多个插件或处理多个任务</li>
                <li><strong>无界面运行</strong>：在服务器或后台环境中运行，不需要打开主窗口</li>
                <li><strong>插件开发</strong>：快速打包和测试插件，无需通过 UI 操作</li>
            </ul>
        </section>

        <section class="section">
            <h3>注意事项</h3>
            <p>命令行工具需要应用已正确安装，并且插件目录和配置文件路径正确。</p>
            <p>运行插件时，确保插件所需的参数都已通过 <code>--</code> 后的参数正确传递。</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                如果遇到权限问题或路径错误，请检查应用安装路径和插件目录配置。
            </el-alert>
        </section>
    </div>
</template>

<script setup lang="ts">
import CodeBlock from "@/components/help/CodeBlock.vue";
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
