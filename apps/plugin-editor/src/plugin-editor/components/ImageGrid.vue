<template>
    <CoreImageGrid ref="coreRef" v-bind="{ ...props, ...attrs }" :on-context-command="handleContextCommand"
        @scroll-stable="$emit('scroll-stable')">
        <template #before-grid>
            <slot name="before-grid" />
        </template>
        <template #footer>
            <slot name="footer" />
        </template>
        <template #empty>
            <slot name="empty">
                <EmptyState />
            </slot>
        </template>
    </CoreImageGrid>

    <!-- 详情弹窗：保持 main 旧行为（view 层仍可 return 'detail'） -->
    <ImageDetailDialog v-model="showImageDetail" :image="detailImage" />
</template>

<script setup lang="ts">
import { ref, useAttrs } from "vue";
import CoreImageGrid from "@kabegame/core/components/image/ImageGrid.vue";
import ImageDetailDialog from "@kabegame/core/components/common/ImageDetailDialog.vue";
import EmptyState from "@kabegame/core/components/common/EmptyState.vue";

export type { ContextCommand, ContextCommandPayload } from "@kabegame/core/components/image/ImageGrid.vue";

// 禁用自动继承，因为组件有多个根节点
defineOptions({ inheritAttrs: false });

interface Props {
    images: any[];
    imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
    contextMenuComponent?: any;
    onContextCommand?: (
        payload: import("@kabegame/core/components/image/ImageGrid.vue").ContextCommandPayload
    ) =>
        | import("@kabegame/core/components/image/ImageGrid.vue").ContextCommand
        | null
        | undefined
        | Promise<
            import("@kabegame/core/components/image/ImageGrid.vue").ContextCommand | null | undefined
        >;
    showEmptyState?: boolean;
    loading?: boolean; // 加载状态：为 true 时不显示空状态
    loadingOverlay?: boolean; // 加载遮罩：仅覆盖 grid 区域；不传则默认等同于 loading
    enableCtrlWheelAdjustColumns?: boolean;
    enableCtrlKeyAdjustColumns?: boolean;
    hideScrollbar?: boolean;
    scrollStableDelay?: number;
    enableScrollStableEmit?: boolean;
    enableVirtualScroll?: boolean;
    virtualOverscan?: number;
    windowAspectRatio?: number; // 外部传入的窗口宽高比（可选）
}

const props = defineProps<Props>();
const attrs = useAttrs();
defineEmits<{
    "scroll-stable": [];
    // 兼容旧 API：保留事件名避免上层模板报错
    addedToAlbum: [];
}>();

const coreRef = ref<any>(null);

// main 的“内置详情弹窗”在 wrapper 层实现
const showImageDetail = ref(false);
const detailImage = ref<any | null>(null);

async function handleContextCommand(payload: any) {
    const res = await props.onContextCommand?.(payload);
    // 兼容：view 层如果 return 'detail'，则在 wrapper 内打开详情弹窗
    if (res === "detail") {
        detailImage.value = payload.image;
        showImageDetail.value = true;
    }
    return res;
}

defineExpose({
    getContainerEl: () => coreRef.value?.getContainerEl?.(),
    getSelectedIds: () => coreRef.value?.getSelectedIds?.(),
    clearSelection: () => coreRef.value?.clearSelection?.(),
});
</script>
