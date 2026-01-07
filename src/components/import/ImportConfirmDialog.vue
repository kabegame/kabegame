<template>
    <!-- 这是一个“逻辑组件”，不渲染任何可见 DOM；通过 expose 的 open() 调起 ElMessageBox -->
    <span style="display: none" />
</template>

<script setup lang="ts">
import { h, ref } from "vue";
import { ElMessageBox } from "element-plus";
import ImportConfirmContent from "./ImportConfirmContent.vue";

export type ImportItem = {
    path: string;
    name: string;
    isDirectory: boolean;
    isZip?: boolean;
};

async function open(items: ImportItem[]): Promise<boolean | null> {
    // 注意：ElMessageBox 关闭时会卸载内容组件；如果依赖子组件 ref 来读取 checkbox，
    // 很容易读到 null（导致永远返回 false）。因此把状态保存在外部 ref 并传入内容组件。
    const createAlbumPerSource = ref(false);

    try {
        await ElMessageBox.confirm(
            h(ImportConfirmContent, {
                items,
                createAlbumPerSourceRef: createAlbumPerSource,
            }),
            "确认导入",
            {
                confirmButtonText: "确认导入",
                cancelButtonText: "取消",
                type: "info",
                customClass: "file-drop-confirm-dialog",
            }
        );
        return createAlbumPerSource.value;
    } catch {
        return null;
    }
}

defineExpose({ open });
</script>
