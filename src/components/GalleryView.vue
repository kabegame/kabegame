<template>
    <div ref="containerEl" class="gallery-view" v-loading="loading" @mouseenter="isHovering = true"
        @mouseleave="isHovering = false">
        <slot name="before-grid" />

        <ImageGrid v-if="images" ref="gridRef" :images="images" :image-url-map="imageUrlMap"
            :image-click-action="imageClickAction" :columns="columns"
            :aspect-ratio-match-window="aspectRatioMatchWindow" :window-aspect-ratio="windowAspectRatio"
            :allow-select="allowSelect" :enable-context-menu="enableContextMenu"
            :show-load-more-button="showLoadMoreButton" :has-more="hasMore" :loading-more="loadingMore"
            :show-empty-state="showEmptyState"
            @image-dbl-click="(img, ev) => emit('image-dbl-click', img, ev)"
            @context-command="(payload) => emit('context-command', payload)"
            @load-more="() => emit('load-more')"
            @selection-change="(ids) => emit('selection-change', ids)"
            @contextmenu="(ev, img) => emit('contextmenu', ev, img)"
            @reorder="(newOrder) => emit('reorder', newOrder)" />

        <slot name="overlays" />
    </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ImageGrid from "@/components/ImageGrid.vue";
import { enableDragScroll, type DragScrollOptions } from "@/utils/dragScroll";
import type { ImageInfo } from "@/stores/crawler";

type Mode = "gallery" | "albumDetail";

const props = withDefaults(
    defineProps<{
        mode: Mode;
        loading?: boolean;

        images: ImageInfo[];
        imageUrlMap: Record<string, { thumbnail?: string; original?: string }>;
        imageClickAction?: "preview" | "open";
        columns: number;
        aspectRatioMatchWindow: boolean;
        windowAspectRatio: number;

        allowSelect?: boolean;
        enableContextMenu?: boolean;
        showLoadMoreButton?: boolean;
        hasMore?: boolean;
        loadingMore?: boolean;
        showEmptyState?: boolean;

        /** 外部决定是否屏蔽快捷键（弹窗/抽屉等覆盖层） */
        isBlocked?: () => boolean;

        enableCtrlWheelAdjustColumns?: boolean;
        enableCtrlKeyAdjustColumns?: boolean;
        enableDragScroll?: boolean;
        dragScrollOptions?: DragScrollOptions;

        enableScrollStableEmit?: boolean;
        scrollStableDelay?: number;
    }>(),
    {
        loading: false,
        imageClickAction: "preview",
        allowSelect: false,
        enableContextMenu: false,
        showLoadMoreButton: false,
        hasMore: false,
        loadingMore: false,
        showEmptyState: false,
        enableCtrlWheelAdjustColumns: undefined,
        enableCtrlKeyAdjustColumns: undefined,
        enableDragScroll: undefined,
        enableScrollStableEmit: true,
        scrollStableDelay: 180,
    }
);

const emit = defineEmits<{
    (e: "container-mounted", el: HTMLElement): void;
    (e: "adjust-columns", delta: number): void;
    (e: "scroll-stable"): void;

    // ImageGrid 事件透传（命名用 kebab，便于模板里使用）
    (e: "load-more"): void;
    (e: "image-dbl-click", image: ImageInfo, event?: MouseEvent): void;
    (e: "context-command", payload: any): void;
    (e: "selection-change", ids: Set<string>): void;
    (e: "contextmenu", event: MouseEvent, image: ImageInfo): void;
    (e: "reorder", newOrder: ImageInfo[]): void;
}>();

const containerEl = ref<HTMLElement | null>(null);
const gridRef = ref<any>(null);
const isHovering = ref(false);

const enableCtrlWheelAdjustColumns = computed(() => {
    if (props.enableCtrlWheelAdjustColumns !== undefined) return props.enableCtrlWheelAdjustColumns;
    // 默认：两种 mode 都开启（只在按住 Ctrl 时拦截）
    return true;
});
const enableCtrlKeyAdjustColumns = computed(() => {
    if (props.enableCtrlKeyAdjustColumns !== undefined) return props.enableCtrlKeyAdjustColumns;
    return true;
});
const enableDragScrollInView = computed(() => {
    if (props.enableDragScroll !== undefined) return props.enableDragScroll;
    return true;
});

let cleanupDragScroll: null | (() => void) = null;
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
let lastZoomAnim: Animation | null = null;

const isTextInputLike = (target: EventTarget | null) => {
    const el = target as HTMLElement | null;
    const tag = el?.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el?.isContentEditable;
};

const isShortcutContextActive = () => {
    const el = containerEl.value;
    if (!el) return false;
    if (isHovering.value) return true;
    const active = document.activeElement as HTMLElement | null;
    return !!active && el.contains(active);
};

const prefersReducedMotion = () => {
    try {
        return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    } catch {
        return false;
    }
};

const pulseZoomAnimation = () => {
    if (prefersReducedMotion()) return;
    const container = containerEl.value;
    if (!container) return;
    const grid = container.querySelector<HTMLElement>(".image-grid");
    if (!grid || !(grid as any).animate) return;

    lastZoomAnim?.cancel?.();
    lastZoomAnim = grid.animate(
        [
            { transform: "scale(0.985)", opacity: 0.96 },
            { transform: "scale(1)", opacity: 1 },
        ],
        { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" }
    );
};

const onWheel = (event: WheelEvent) => {
    if (!enableCtrlWheelAdjustColumns.value) return;
    if (props.isBlocked?.()) return;
    if (!event.ctrlKey) return;

    event.preventDefault();
    const delta = event.deltaY > 0 ? 1 : -1;
    emit("adjust-columns", delta);
};

const onKeyDown = (event: KeyboardEvent) => {
    if (!enableCtrlKeyAdjustColumns.value) return;
    if (!isShortcutContextActive()) return;
    if (props.isBlocked?.()) return;
    if (isTextInputLike(event.target)) return;
    if (!event.ctrlKey) return;

    if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        emit("adjust-columns", 1);
    } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        emit("adjust-columns", -1);
    }
};

const onScroll = () => {
    if (!props.enableScrollStableEmit) return;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
        emit("scroll-stable");
        scrollTimer = null;
    }, props.scrollStableDelay);
};

const bind = () => {
    const el = containerEl.value;
    if (!el) return;

    emit("container-mounted", el);

    // wheel：需要 passive:false 才能 preventDefault
    el.addEventListener("wheel", onWheel, { passive: false });

    if (props.enableScrollStableEmit) {
        el.addEventListener("scroll", onScroll, { passive: true });
    }

    if (enableCtrlKeyAdjustColumns.value) {
        window.addEventListener("keydown", onKeyDown);
    }

    if (enableDragScrollInView.value) {
        cleanupDragScroll = enableDragScroll(el, {
            requireSpaceKey: false,
            enableForPointerTypes: ["mouse", "pen"],
            ignoreSelector:
                "a,button,input,textarea,select,label,[contenteditable='true']," +
                ".page-header,.el-button,.el-input,.el-select,.el-dropdown,.el-tooltip,.el-dialog,.el-drawer,.el-message-box",
            ...(props.dragScrollOptions ?? {}),
        });
    }
};

const unbind = () => {
    const el = containerEl.value;

    if (cleanupDragScroll) {
        cleanupDragScroll();
        cleanupDragScroll = null;
    }

    if (scrollTimer) {
        clearTimeout(scrollTimer);
        scrollTimer = null;
    }

    if (enableCtrlKeyAdjustColumns.value) {
        window.removeEventListener("keydown", onKeyDown);
    }

    if (el) {
        el.removeEventListener("wheel", onWheel as any);
        el.removeEventListener("scroll", onScroll as any);
    }
};

onMounted(() => {
    bind();
});

onBeforeUnmount(() => {
    unbind();
});

watch(
    () => [enableCtrlWheelAdjustColumns.value, enableCtrlKeyAdjustColumns.value, enableDragScrollInView.value, props.enableScrollStableEmit],
    () => {
        unbind();
        bind();
    }
);

// 列数变化（缩放）动效：两种模式都统一表现
watch(
    () => props.columns,
    (next, prev) => {
        if (next === prev) return;
        pulseZoomAnimation();
    }
);

// 暴露方法给父组件
defineExpose({
    clearSelection: () => gridRef.value?.clearSelection?.(),
    exitReorderMode: () => gridRef.value?.exitReorderMode?.(),
});
</script>

<style scoped lang="scss">
.gallery-view {
    width: 100%;
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    /* 为图片悬浮上移效果留出空间，避免被容器截断 */
    padding-top: 6px;
    padding-bottom: 6px;
}

/* 确保图片网格根容器允许内容溢出 */
.gallery-view :deep(.image-grid-root) {
    overflow: visible;
}
</style>
