<template>
    <el-dialog v-model="visible" title="任务详情" width="720px" top="8vh" :append-to-body="true"
        :close-on-click-modal="true" @open="handleOpen">
        <div v-if="loading" class="loading">
            <el-skeleton :rows="8" animated />
        </div>

        <div v-else-if="!task" class="empty">
            <el-empty description="任务不存在或尚未写入数据库" :image-size="80" />
        </div>

        <div v-else class="body">
            <div class="row">
                <div class="k">任务ID</div>
                <div class="v mono">{{ task.id }}</div>
            </div>
            <div class="row">
                <div class="k">插件</div>
                <div class="v">{{ task.pluginId }}</div>
            </div>
            <div class="row">
                <div class="k">状态</div>
                <div class="v">
                    <el-tag size="small" :type="statusTagType(task.status)">{{ task.status }}</el-tag>
                </div>
            </div>
            <div class="row">
                <div class="k">进度</div>
                <div class="v">
                    <el-progress :percentage="Math.floor(task.progress || 0)" :stroke-width="10" />
                </div>
            </div>
            <div class="row">
                <div class="k">时间</div>
                <div class="v">
                    <div>开始：{{ formatTime(task.startTime) }}</div>
                    <div>结束：{{ formatTime(task.endTime) }}</div>
                    <div v-if="task.startTime">耗时：{{ formatDuration(task.startTime, task.endTime) }}</div>
                </div>
            </div>
            <div class="row">
                <div class="k">统计</div>
                <div class="v">
                    <el-tag size="small" type="danger">已删除: {{ task.deletedCount }}</el-tag>
                </div>
            </div>
            <div v-if="task.error" class="row">
                <div class="k">错误</div>
                <div class="v err">{{ task.error }}</div>
            </div>

            <div class="footer">
                <el-button @click="$emit('open-images', task.id)">查看任务图片</el-button>
                <el-button type="primary" @click="handleRefresh" :loading="loading">刷新</el-button>
            </div>
        </div>
    </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

type TaskInfo = {
    id: string;
    pluginId: string;
    outputDir?: string | null;
    userConfig?: Record<string, any> | null;
    outputAlbumId?: string | null;
    status: string;
    progress: number;
    deletedCount: number;
    startTime?: number | null;
    endTime?: number | null;
    error?: string | null;
};

const props = defineProps<{
    modelValue: boolean;
    taskId: string;
}>();

const emit = defineEmits<{
    (e: "update:modelValue", v: boolean): void;
    (e: "open-images", taskId: string): void;
}>();

const visible = computed({
    get: () => props.modelValue,
    set: (v) => emit("update:modelValue", v),
});

const loading = ref(false);
const task = ref<TaskInfo | null>(null);

function statusTagType(s: string): "info" | "warning" | "success" | "danger" {
    if (s === "running") return "warning";
    if (s === "completed") return "success";
    if (s === "failed") return "danger";
    return "info";
}

function formatTime(ts?: number | null): string {
    if (!ts) return "—";
    const ms = ts > 1e12 ? ts : ts * 1000;
    const d = new Date(ms);
    return d.toLocaleString();
}

function formatDuration(start: number, end?: number | null): string {
    const sMs = start > 1e12 ? start : start * 1000;
    const eMs = end ? (end > 1e12 ? end : end * 1000) : Date.now();
    const diff = Math.max(0, eMs - sMs);
    const sec = Math.floor(diff / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    if (hr > 0) return `${hr}小时${min % 60}分钟`;
    if (min > 0) return `${min}分钟`;
    return `${sec}秒`;
}

async function handleRefresh() {
    const id = (props.taskId || "").trim();
    if (!id) return;
    loading.value = true;
    try {
        const res = await invoke<TaskInfo | null>("get_task", { taskId: id });
        task.value = res || null;
    } finally {
        loading.value = false;
    }
}

async function handleOpen() {
    await handleRefresh();
}
</script>

<style scoped>
.mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    word-break: break-all;
}

.row {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.k {
    opacity: 0.8;
}

.err {
    color: #f56c6c;
    word-break: break-word;
}

.footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 14px;
}
</style>
