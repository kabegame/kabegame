<template>
    <div class="tip-article">
        <section class="section">
            <h3>常用命令示例</h3>
            <p>以下是一些常用的命令行操作示例，可以直接复制使用（记得替换路径为实际路径）。</p>
        </section>

        <section class="section">
            <h3>1. 导入单张图片到画廊</h3>
            <p>使用 <code>local-import</code> 插件导入单张图片文件：</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --file_path="C:\\Users\\YourName\\Pictures\\image.jpg"' />
            <p><strong>说明：</strong></p>
            <ul>
                <li><code>--plugin local-import</code>：使用本地导入插件</li>
                <li><code>--file_path</code>：要导入的图片文件路径（Windows 路径需要用双反斜杠或正斜杠）</li>
            </ul>
            <p><strong>Windows 路径示例：</strong></p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --file_path="C:/Users/YourName/Pictures/image.jpg"' />
            <p><strong>Linux/macOS 路径示例：</strong></p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --file_path="/home/username/Pictures/image.jpg"' />
        </section>

        <section class="section">
            <h3>2. 导入文件夹到画廊</h3>
            <p>使用 <code>local-import</code> 插件导入整个文件夹（递归扫描子目录）：</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="C:\\Users\\YourName\\Pictures\\MyAlbum" --recursive=true' />
            <p><strong>说明：</strong></p>
            <ul>
                <li><code>--plugin local-import</code>：使用本地导入插件</li>
                <li><code>--folder_path</code>：要导入的文件夹路径</li>
                <li><code>--recursive=true</code>：递归扫描子目录（设为 <code>false</code> 则只导入当前目录）</li>
            </ul>
            <p><strong>Windows 路径示例：</strong></p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="C:/Users/YourName/Pictures/MyAlbum" --recursive=true' />
            <p><strong>Linux/macOS 路径示例：</strong></p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="/home/username/Pictures/MyAlbum" --recursive=true' />
            <p><strong>只导入当前目录（不递归）：</strong></p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="C:/Users/YourName/Pictures/MyAlbum" --recursive=false' />
        </section>

        <section class="section">
            <h3>3. 指定输出目录</h3>
            <p>导入时可以指定输出目录（图片保存位置）：</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import --output-dir "C:\\Downloads\\Kabegame" -- --folder_path="C:\\Users\\YourName\\Pictures\\MyAlbum" --recursive=true' />
            <p>如果不指定 <code>--output-dir</code>，图片会保存到默认下载目录。</p>
        </section>

        <section class="section">
            <h3>4. 导入到指定画册</h3>
            <p>导入时可以指定输出画册（需要先创建画册）：</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import --output-album "album-name-here" -- --folder_path="C:\\Users\\YourName\\Pictures\\MyAlbum" --recursive=true' />
            <p>如果不指定 <code>--output-album-id</code>，图片只会添加到画廊，不会添加到画册。</p>
        </section>

        <section class="section">
            <h3>注意事项</h3>
            <ul>
                <li>确保 <code>local-import</code> 插件已安装（这是内置插件，通常已自动安装）</li>
                <li>路径中的空格需要用引号包裹</li>
                <li>Windows 路径可以使用正斜杠 <code>/</code> 或双反斜杠 <code>\\</code></li>
                <li>导入大量文件时可能需要一些时间，请耐心等待</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                如果遇到"插件不存在"错误，请先到"源管理"页面确认 <code>local-import</code> 插件已安装。
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
