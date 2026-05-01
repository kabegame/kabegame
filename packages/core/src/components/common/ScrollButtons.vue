<template>
    <Teleport to="body">
        <Transition name="scroll-btn-fade">
            <div v-if="showTopButton" class="scroll-btn scroll-btn-top" :style="buttonStyle" @click="scrollToTop">
                <el-icon :size="20">
                    <ArrowUp />
                </el-icon>
            </div>
        </Transition>
    </Teleport>
    <Teleport to="body">
        <Transition name="scroll-btn-fade">
            <div v-if="showBottomButton" class="scroll-btn scroll-btn-bottom" :style="buttonStyle"
                @click="scrollToBottom">
                <el-icon :size="20">
                    <ArrowDown />
                </el-icon>
            </div>
        </Transition>
    </Teleport>
    <Teleport to="body">
        <Transition name="scroll-btn-fade">
            <div v-if="showLeftButton" class="scroll-btn scroll-btn-left" :style="buttonStyle" @click="scrollToLeft">
                <el-icon :size="20">
                    <ArrowLeft />
                </el-icon>
            </div>
        </Transition>
    </Teleport>
    <Teleport to="body">
        <Transition name="scroll-btn-fade">
            <div v-if="showRightButton" class="scroll-btn scroll-btn-right" :style="buttonStyle" @click="scrollToRight">
                <el-icon :size="20">
                    <ArrowRight />
                </el-icon>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from "@element-plus/icons-vue";

interface Props {
    /** 获取滚动容器的函数 */
    getContainer: () => HTMLElement | null;
    /** @deprecated 箭头现在仅按是否贴紧顶部/底部显示，保留该字段兼容旧调用。 */
    threshold?: number;
    /** 按钮距离右侧的距离 */
    right?: number;
    /** 回到顶部按钮距离底部的距离 */
    topButtonBottom?: number;
    /** 滑到底部按钮距离底部的距离 */
    bottomButtonBottom?: number;
}

const props = withDefaults(defineProps<Props>(), {
    threshold: 2000,
    right: 24,
    topButtonBottom: 120,
    bottomButtonBottom: 60,
});

// 滚动状态
const scrollTop = ref(0);
const scrollLeft = ref(0);
const scrollHeight = ref(0);
const clientHeight = ref(0);
const scrollWidth = ref(0);
const clientWidth = ref(0);

// 是否可以滚动（有滚动条）
const canScrollVertical = computed(() => scrollHeight.value > clientHeight.value + 1);
const canScrollHorizontal = computed(() => scrollWidth.value > clientWidth.value + 1);

// 距离底部的距离
const distanceToBottom = computed(() => {
    return Math.max(0, scrollHeight.value - scrollTop.value - clientHeight.value);
});

// 距离右侧的距离
const distanceToRight = computed(() => {
    return Math.max(0, scrollWidth.value - scrollLeft.value - clientWidth.value);
});

// 是否已到达顶部（小于1px算到达）
const isAtTop = computed(() => scrollTop.value < 1);

// 是否已到达底部（距离底部小于1px算到达）
const isAtBottom = computed(() => distanceToBottom.value < 1);

const isAtLeft = computed(() => scrollLeft.value < 1);
const isAtRight = computed(() => distanceToRight.value < 1);

// 回到顶部按钮显示逻辑
const showTopButton = computed(() => {
    if (!canScrollVertical.value) return false;
    return !isAtTop.value;
});

// 滑到底部按钮显示逻辑
const showBottomButton = computed(() => {
    if (!canScrollVertical.value) return false;
    return !isAtBottom.value;
});

const showLeftButton = computed(() => {
    if (!canScrollHorizontal.value) return false;
    return !isAtLeft.value;
});

const showRightButton = computed(() => {
    if (!canScrollHorizontal.value) return false;
    return !isAtRight.value;
});

// 按钮样式
const buttonStyle = computed(() => ({
    "--scroll-btn-right": `${props.right}px`,
    "--scroll-btn-top-bottom": `${props.topButtonBottom}px`,
    "--scroll-btn-bottom-bottom": `${props.bottomButtonBottom}px`,
}));

const updateScrollState = () => {
    const el = props.getContainer();
    if (!el) return;
    scrollTop.value = el.scrollTop;
    scrollLeft.value = el.scrollLeft;
    scrollHeight.value = el.scrollHeight;
    clientHeight.value = el.clientHeight;
    scrollWidth.value = el.scrollWidth;
    clientWidth.value = el.clientWidth;
};

const notifyProgrammaticScroll = (el: HTMLElement) => {
    el.dispatchEvent(new CustomEvent("scroll-buttons-scroll-command"));
};

const scrollToTop = () => {
    if (!canScrollVertical.value) return;
    const el = props.getContainer();
    if (!el) return;
    notifyProgrammaticScroll(el);
    el.scrollTo({ top: 0, behavior: "smooth" });
};

const scrollToBottom = () => {
    if (!canScrollVertical.value) return;
    const el = props.getContainer();
    if (!el) return;
    notifyProgrammaticScroll(el);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
};

const scrollToLeft = () => {
    if (!canScrollHorizontal.value) return;
    const el = props.getContainer();
    if (!el) return;
    notifyProgrammaticScroll(el);
    el.scrollTo({ left: 0, behavior: "smooth" });
};

const scrollToRight = () => {
    if (!canScrollHorizontal.value) return;
    const el = props.getContainer();
    if (!el) return;
    notifyProgrammaticScroll(el);
    el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
};

let scrollRaf: number | null = null;
const handleScroll = () => {
    if (scrollRaf != null) return;
    scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        updateScrollState();
    });
};

let resizeObserver: ResizeObserver | null = null;
let currentEl: HTMLElement | null = null;

const setupListeners = (el: HTMLElement | null) => {
    if (!el) return;
    currentEl = el;
    el.addEventListener("scroll", handleScroll, { passive: true });
    if (!resizeObserver) {
        resizeObserver = new ResizeObserver(() => {
            updateScrollState();
        });
    }
    resizeObserver.observe(el);
    updateScrollState();
};

const cleanupListeners = (el: HTMLElement | null) => {
    if (!el) return;
    el.removeEventListener("scroll", handleScroll);
    resizeObserver?.unobserve(el);
    currentEl = null;
};

let checkInterval: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
    // 等待 DOM 更新完成，确保容器元素已挂载
    await nextTick();
    setupListeners(props.getContainer());

    // 定期检查容器是否变化（因为 getContainer 是函数，无法直接 watch）
    checkInterval = setInterval(() => {
        const newEl = props.getContainer();
        if (newEl !== currentEl) {
            cleanupListeners(currentEl);
            setupListeners(newEl);
        }
    }, 500);
});

onUnmounted(() => {
    cleanupListeners(currentEl);
    if (scrollRaf != null) cancelAnimationFrame(scrollRaf);
    scrollRaf = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (checkInterval) clearInterval(checkInterval);
    checkInterval = null;
});

defineExpose({
    scrollToTop,
    scrollToBottom,
    scrollToLeft,
    scrollToRight,
});
</script>

<style scoped lang="scss">
.scroll-btn {
    position: fixed;
    right: var(--scroll-btn-right, 24px);
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--anime-primary, #646cff);
    border: none;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 1000;
    transition: all 0.2s ease;
    box-shadow: 0 2px 12px rgba(100, 108, 255, 0.4);
    backdrop-filter: blur(8px);

    &:hover {
        background: var(--anime-primary, #646cff);
        filter: brightness(1.15);
        transform: scale(1.08);
        box-shadow: 0 4px 20px rgba(100, 108, 255, 0.6);
    }

    &:active {
        transform: scale(0.95);
        filter: brightness(0.95);
    }
}

.scroll-btn-top {
    bottom: var(--scroll-btn-top-bottom, 120px);
}

.scroll-btn-bottom {
    bottom: var(--scroll-btn-bottom-bottom, 60px);
}

.scroll-btn-left {
    bottom: var(--scroll-btn-top-bottom, 120px);
}

.scroll-btn-right {
    bottom: var(--scroll-btn-bottom-bottom, 60px);
}

.scroll-btn-fade-enter-active,
.scroll-btn-fade-leave-active {
    transition: opacity 0.25s ease, transform 0.25s ease;
}

.scroll-btn-fade-enter-from,
.scroll-btn-fade-leave-to {
    opacity: 0;
    transform: translateX(20px);
}
</style>
