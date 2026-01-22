<template>
    <div class="tip-article">
        <section class="section">
            <h3>虚拟盘根目录结构</h3>
            <p>开启虚拟盘后，在资源管理器中打开挂载点（默认 <code>K:\</code>），你会看到以下目录：</p>
        </section>

        <section class="section">
            <h3>📁 全部</h3>
            <p>包含画廊中的所有图片，按分页组织（每页约 1000 张）。</p>
            <p>适合：快速浏览所有图片、查找特定图片。</p>
        </section>

        <section class="section">
            <h3>📁 按插件</h3>
            <p>按收集源插件（如 konachan、anihonet-wallpaper 等）分组显示图片。</p>
            <p>每个插件一个子目录，里面是该插件收集到的所有图片。</p>
            <p>适合：按来源查看图片、管理特定插件的收集结果。</p>
        </section>

        <section class="section">
            <h3>📁 按时间</h3>
            <p>按图片的收集时间（年月）分组显示。</p>
            <p>子目录格式为 <code>YYYY-MM</code>（例如 <code>2024-01</code>），包含该月收集的所有图片。</p>
            <p>适合：按时间线浏览、查找特定时期的图片。</p>
        </section>

        <section class="section">
            <h3>📁 按任务</h3>
            <p>按收集任务分组显示图片。</p>
            <p>每个任务一个子目录，目录名为 <code>任务名称 - 任务ID</code>，包含该任务收集到的所有图片。</p>
            <p>适合：查看特定任务的收集结果、追踪任务产出。</p>
        </section>

        <section class="section">
            <h3>📁 画册</h3>
            <p>包含你创建的所有画册。</p>
            <p>每个画册一个子目录，目录名为画册名称，里面是该画册中的所有图片。</p>
            <p>适合：按画册浏览、管理画册内容、拖拽图片到画册。</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                画册目录支持部分文件操作（如删除、重命名），但图片文件本身是只读的。
            </el-alert>
        </section>

        <section class="section">
            <h3>📄 在这里你可以自由查看图片.txt</h3>
            <p>根目录下的说明文件，介绍虚拟盘的基本用法。</p>
            <p>双击可以查看详细说明。</p>
        </section>

        <section class="section">
            <h3>使用建议</h3>
            <ul>
                <li><strong>快速浏览</strong>：使用“全部”目录，按分页查看所有图片</li>
                <li><strong>按来源管理</strong>：使用“按插件”目录，查看特定插件的收集结果</li>
                <li><strong>时间线查看</strong>：使用“按时间”目录，按月份浏览图片</li>
                <li><strong>任务追踪</strong>：使用“按任务”目录，查看特定任务的产出</li>
                <li><strong>画册管理</strong>：使用“画册”目录，管理你的画册和图片</li>
            </ul>
        </section>

        <section class="section">
            <h3>注意事项</h3>
            <p>虚拟盘是“按需映射”的文件视图，主要用途是浏览和查看图片。</p>
            <p>部分高级文件操作可能不完全支持，具体以应用说明和实际表现为准。</p>
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
