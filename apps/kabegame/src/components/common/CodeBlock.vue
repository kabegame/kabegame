<template>
    <div class="code-block-wrapper" :class="{ 'is-single-line': singleLine }">
        <!-- kb-selectable：全局 body 是 user-select:none，代码/路径要能划词部分复制 -->
        <pre class="code-block kb-selectable"><code>{{ code }}</code></pre>
        <el-button class="copy-btn" circle size="small" @click="handleCopy" :icon="copied ? Check : DocumentCopy">
        </el-button>
    </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { DocumentCopy, Check } from "@kabegame/element-plus-icons";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { IS_WEB } from "@kabegame/core/env";

const { t } = useI18n();
const props = defineProps<{
    code: string;
    /** 单行紧凑形态（工具栏那条 PathQL 路径）：不留上下外边距、复制图标垂直居中。 */
    singleLine?: boolean;
}>();

const copied = ref(false);

const handleCopy = async () => {
    try {
        if (!IS_WEB) {
            const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
            await writeText(props.code);
        } else {
            await navigator.clipboard.writeText(props.code);
        }
        copied.value = true;
        ElMessage.success(t('common.copySuccess'));
        setTimeout(() => {
            copied.value = false;
        }, 2000);
    } catch (error) {
        console.error("复制失败:", error);
        ElMessage.error(t('common.copyFailed'));
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

    &.is-single-line {
        margin: 0;

        .code-block {
            padding: 7px 40px 7px 12px;
        }

        .copy-btn {
            top: 50%;
            transform: translateY(-50%);
        }
    }
}
</style>
