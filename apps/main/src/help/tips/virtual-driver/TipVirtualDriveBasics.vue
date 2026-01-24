<template>
    <div class="tip-article">
        <el-alert class="note" type="warning" show-icon :closable="false" style="margin-bottom: 10px;">
            Light 模式不支持此功能
        </el-alert>
        <section class="section">
            <h3>这是什么</h3>
            <p>“虚拟盘（VD）”会把你的图库以一个盘符的形式挂载到资源管理器里。</p>
            <p>这样你可以像浏览普通文件夹一样浏览画册和图片文件（适合拖拽、复制路径、外部工具打开等）。</p>
        </section>

        <section class="section">
            <h3>如何开启</h3>
            <p>到 <strong>设置</strong> → <strong>应用设置</strong> → <strong>画册盘</strong> 开启。</p>
            <p>开启后，默认挂载点通常是 <code>K:\</code>（具体以你的设置为准）。</p>
        </section>

        <section class="section">
            <h3>如何打开</h3>
            <ul>
                <li>在“画册列表”页右上角点击 <strong>去VD查看</strong></li>
                <li>或在“画册详情”页右上角点击 <strong>去VD查看</strong></li>
                <li>也可以直接在资源管理器地址栏输入挂载点，例如 <code>K:\</code></li>
            </ul>
        </section>

        <section class="section">
            <h3>注意事项</h3>
            <p>虚拟盘属于“按需映射”的文件视图，一些高级文件操作可能不完全支持（以应用说明/实际表现为准）。</p>
            <el-alert class="note" type="info" show-icon :closable="false">
                如果你在资源管理器里没看到盘符，先检查是否已开启“画册盘”，以及挂载点盘符是否被其他软件占用。
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
