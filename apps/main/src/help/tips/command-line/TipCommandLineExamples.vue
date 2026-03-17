<template>
    <div class="tip-article">
        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-examples.commonTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-examples.commonPara') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-examples.singleTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-examples.singlePara') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --file_path="C:\\Users\\YourName\\Pictures\\image.jpg"' />
            <p>{{ $t('help.tipsContent.command-line-examples.singleDesc') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.command-line-examples.singleItem1') }}</li>
                <li>{{ $t('help.tipsContent.command-line-examples.singleItem2') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.command-line-examples.singleWinTitle') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --file_path="C:/Users/YourName/Pictures/image.jpg"' />
            <p>{{ $t('help.tipsContent.command-line-examples.singleUnixTitle') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --file_path="/home/username/Pictures/image.jpg"' />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-examples.folderTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-examples.folderPara') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="C:\\Users\\YourName\\Pictures\\MyAlbum" --recursive=true' />
            <p>{{ $t('help.tipsContent.command-line-examples.singleDesc') }}</p>
            <ul>
                <li>{{ $t('help.tipsContent.command-line-examples.folderItem1') }}</li>
                <li>{{ $t('help.tipsContent.command-line-examples.folderItem2') }}</li>
                <li>{{ $t('help.tipsContent.command-line-examples.folderItem3') }}</li>
            </ul>
            <p>{{ $t('help.tipsContent.command-line-examples.folderWinTitle') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="C:/Users/YourName/Pictures/MyAlbum" --recursive=true' />
            <p>{{ $t('help.tipsContent.command-line-examples.folderUnixTitle') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="/home/username/Pictures/MyAlbum" --recursive=true' />
            <p>{{ $t('help.tipsContent.command-line-examples.folderNoRecurseTitle') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import -- --folder_path="C:/Users/YourName/Pictures/MyAlbum" --recursive=false' />
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-examples.outputTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-examples.outputPara1') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import --output-dir "C:\\Downloads\\Kabegame" -- --folder_path="C:\\Users\\YourName\\Pictures\\MyAlbum" --recursive=true' />
            <p>{{ $t('help.tipsContent.command-line-examples.outputPara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-examples.albumTitle') }}</h3>
            <p>{{ $t('help.tipsContent.command-line-examples.albumPara1') }}</p>
            <CodeBlock
                code='kabegame-cli plugin run --plugin local-import --output-album "album-name-here" -- --folder_path="C:\\Users\\YourName\\Pictures\\MyAlbum" --recursive=true' />
            <p>{{ $t('help.tipsContent.command-line-examples.albumPara2') }}</p>
        </section>

        <section class="section">
            <h3>{{ $t('help.tipsContent.command-line-examples.noteTitle') }}</h3>
            <ul>
                <li>{{ $t('help.tipsContent.command-line-examples.noteItem1') }}</li>
                <li>{{ $t('help.tipsContent.command-line-examples.noteItem2') }}</li>
                <li>{{ $t('help.tipsContent.command-line-examples.noteItem3') }}</li>
                <li>{{ $t('help.tipsContent.command-line-examples.noteItem4') }}</li>
            </ul>
            <el-alert class="note" type="info" show-icon :closable="false">
                {{ $t('help.tipsContent.command-line-examples.noteNote') }}
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
