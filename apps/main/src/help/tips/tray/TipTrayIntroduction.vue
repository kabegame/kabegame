<template>
    <div class="tip-article">
        <section class="section">
            <h3>托盘位置</h3>
            <p>Kabegame 会在系统托盘（任务栏右侧）显示一个图标。</p>
            <p>托盘图标使用应用的主图标，鼠标悬停时会显示 <code>Kabegame</code> 提示。</p>
        </section>

        <section class="section">
            <h3>左键点击</h3>
            <p>左键点击托盘图标可以快速切换主窗口的显示/隐藏状态：</p>
            <ul>
                <li>如果窗口当前是隐藏的，点击后会显示窗口并获取焦点</li>
                <li>如果窗口当前是显示的，点击后会隐藏窗口（但应用仍在后台运行）</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                左键点击不会显示菜单，只会切换窗口显示状态。菜单需要通过右键点击打开。
            </el-alert>
        </section>

        <section class="section">
            <h3>右键点击</h3>
            <p>右键点击托盘图标会显示一个上下文菜单，包含以下功能：</p>
            <ul>
                <li><strong>显示窗口</strong>：显示主窗口并获取焦点（如果窗口已隐藏）</li>
                <li><strong>隐藏窗口</strong>：隐藏主窗口（但应用仍在后台运行）</li>
                <li><strong>下一张壁纸</strong>：如果已启用壁纸轮播，立即切换到下一张壁纸</li>
                <li><strong>退出</strong>：完全退出应用</li>
            </ul>
        </section>

        <section class="section">
            <h3>使用场景</h3>
            <ul>
                <li>需要快速隐藏窗口但保持应用运行（例如切换到其他应用时）</li>
                <li>需要快速显示窗口（例如从其他应用切换回来时）</li>
                <li>需要在不打开主窗口的情况下切换壁纸</li>
                <li>需要完全退出应用（关闭窗口时默认只是隐藏，不会退出）</li>
            </ul>
        </section>

        <section class="section">
            <h3>注意事项</h3>
            <p>关闭主窗口时，应用默认会隐藏窗口而不是退出，这样可以保持应用在后台运行。</p>
            <p>如果需要完全退出应用，请使用托盘菜单中的 <strong>退出</strong> 选项。</p>
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
