<template>
    <div class="code-block-wrapper">
        <pre class="code-block"><code>{{ code }}</code></pre>
        <el-button class="copy-btn" circle size="small" @click="handleCopy" :icon="copied ? Check : DocumentCopy">
        </el-button>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { DocumentCopy, Check } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

const props = defineProps<{
    code: string;
}>();

const copied = ref(false);

const handleCopy = async () => {
    try {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (isTauri()) {
            const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
            await writeText(props.code);
        } else {
            await navigator.clipboard.writeText(props.code);
        }
        copied.value = true;
        ElMessage.success("已复制到剪贴板");
        setTimeout(() => {
            copied.value = false;
        }, 2000);
    } catch (error) {
        console.error("复制失败:", error);
        ElMessage.error("复制失败");
    }
};
</script>

<style scoped lang="scss">
.code-block-wrapper {
    position: relative;
    margin: 8px 0;

    .code-block {
        margin: 0;
        padding: 12px;
        padding-right: 40px;
        border-radius: 8px;
        border: 1px solid var(--anime-border);
        background: rgba(0, 0, 0, 0.05);
        overflow-x: auto;

        code {
            padding: 0;
            border: none;
            background: transparent;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 12px;
            line-height: 1.6;
            white-space: pre;
            color: var(--anime-text-primary);
        }
    }

    .copy-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        opacity: 0.7;
        transition: opacity 0.2s;

        &:hover {
            opacity: 1;
        }
    }
}
</style>
