<template>
    <div class="import-confirm-content">
        <div class="import-summary">
            <p>是否导入以下 <strong>{{ itemCount }}</strong> 个项目？</p>
            <div class="summary-stats">
                <span>📁 文件夹: <strong>{{ folderCount }}</strong> 个</span>
                <span>🖼️ 图片: <strong>{{ imageCount }}</strong> 个</span>
                <span>📦 ZIP: <strong>{{ zipCount }}</strong> 个</span>
            </div>
        </div>

        <div class="import-list">
            <div v-for="(item, idx) in items" :key="`${item.path ?? item.name}-${idx}`" class="import-item">
                <span class="item-icon">{{ getItemIcon(item) }}</span>
                <span class="item-name">{{ item.name }}</span>
                <span class="item-type">{{ getItemType(item) }}</span>
            </div>
        </div>

        <div v-if="showOptions" class="import-options">
            <el-checkbox v-model="createAlbumPerSourceModel" class="import-option">
                为每个文件夹/压缩包创建画册
            </el-checkbox>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, type Ref, ref } from "vue";
import { ElCheckbox } from "element-plus";

type ImportItem = {
    path?: string;
    name: string;
    isDirectory: boolean;
    isZip?: boolean;
};

const props = defineProps<{
    items: ImportItem[];
    /**
     * 由外部传入的勾选状态（用于 ElMessageBox 的场景：弹窗关闭后组件会卸载，
     * 需要把值保存在外部 ref 中，避免读取不到）。
     */
    createAlbumPerSourceRef?: Ref<boolean>;
}>();

const itemCount = computed(() => props.items.length);
const folderCount = computed(() => props.items.filter(i => i.isDirectory).length);
const zipCount = computed(() => props.items.filter(i => !i.isDirectory && i.isZip).length);
const imageCount = computed(() => props.items.filter(i => !i.isDirectory && !i.isZip).length);
const showOptions = computed(() => folderCount.value + zipCount.value > 0);

// checkbox 状态：优先使用外部 ref；否则使用内部状态（兼容潜在的其他用法）
const innerCreateAlbumPerSource = ref(false);
const createAlbumPerSourceModel = computed<boolean>({
    get() {
        return props.createAlbumPerSourceRef?.value ?? innerCreateAlbumPerSource.value;
    },
    set(v: boolean) {
        if (props.createAlbumPerSourceRef) {
            props.createAlbumPerSourceRef.value = v;
        } else {
            innerCreateAlbumPerSource.value = v;
        }
    },
});

function getItemIcon(item: ImportItem) {
    return item.isDirectory ? "📁" : item.isZip ? "📦" : "🖼️";
}

function getItemType(item: ImportItem) {
    return item.isDirectory ? "文件夹" : item.isZip ? "压缩包" : "图片";
}
</script>

<style lang="scss">
.import-list {
    max-height: 400px;
    overflow-y: auto;
    border: 1px solid var(--anime-border);
    border-radius: 12px;
    padding: 12px;
    background: var(--anime-bg-card);
}
</style>
