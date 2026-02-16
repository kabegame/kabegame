<template>
    <div v-if="visible" class="context-menu-overlay" @click="$emit('close')" @contextmenu.prevent="$emit('close')">
        <div ref="menuRef" class="context-menu" :style="menuStyle">
            <!-- 如果提供了 items，渲染菜单项 -->
            <template v-if="items">
                <template v-for="(item, index) in items" :key="index">
                    <!-- 分隔符 -->
                    <div v-if="item.type === 'divider'" class="context-menu-divider"></div>
                    <!-- 菜单项 -->
                    <template v-else-if="getItemVisible(item)">
                        <!-- 有子菜单的项 -->
                        <div v-if="item.children && item.children.length > 0" class="context-menu-item submenu-trigger"
                            :class="item.className" @mouseenter="handleSubmenuTriggerEnter(index)"
                            @mouseleave="handleSubmenuTriggerLeave">
                            <el-icon v-if="item.icon">
                                <component :is="item.icon" />
                            </el-icon>
                            <span style="margin-left: 8px;">{{ item.label }}</span>
                            <span v-if="item.suffix"
                                style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
                                {{ item.suffix }}
                            </span>
                            <el-icon class="submenu-arrow">
                                <ArrowRight />
                            </el-icon>
                            <!-- 子菜单 -->
                            <div v-if="activeSubmenuIndex === index"
                                :ref="(el) => { if (el) setSubmenuRef(el as HTMLElement, index); }" class="submenu"
                                :style="getSubmenuStyle(index)" @mouseenter="handleSubmenuEnter(index)"
                                @mouseleave="handleSubmenuLeave">
                                <template v-for="(child, childIndex) in item.children" :key="childIndex">
                                    <div v-if="child.type !== 'divider' && getItemVisible(child)"
                                        class="context-menu-item" :class="child.className"
                                        @click.stop="handleItemClick(child)">
                                        <el-icon v-if="child.icon">
                                            <component :is="child.icon" />
                                        </el-icon>
                                        <span style="margin-left: 8px;">{{ child.label }}</span>
                                        <span v-if="child.suffix"
                                            style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
                                            {{ child.suffix }}
                                        </span>
                                    </div>
                                    <div v-else-if="child.type === 'divider'" class="context-menu-divider"></div>
                                </template>
                            </div>
                        </div>
                        <!-- 普通菜单项 -->
                        <div v-else class="context-menu-item" :class="item.className"
                            @click.stop="handleItemClick(item)">
                            <el-icon v-if="item.icon">
                                <component :is="item.icon" />
                            </el-icon>
                            <span style="margin-left: 8px;">{{ item.label }}</span>
                            <span v-if="item.suffix"
                                style="margin-left: 8px; color: var(--anime-text-muted); font-size: 12px;">
                                {{ item.suffix }}
                            </span>
                        </div>
                    </template>
                </template>
            </template>
            <!-- 否则使用 slot -->
            <slot v-else />
        </div>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, type CSSProperties } from "vue";
import { ArrowRight } from "@element-plus/icons-vue";
import type { Component } from "vue";

export interface MenuItem {
    key?: string; // 菜单项的唯一标识，用于隐藏控制
    type?: "item" | "divider";
    label?: string;
    icon?: Component;
    command?: string;
    visible?: boolean | (() => boolean);
    className?: string;
    suffix?: string;
    children?: MenuItem[];
    onClick?: () => void;
}

interface Props {
    visible: boolean;
    position: { x: number; y: number };
    items?: MenuItem[]; // 可选的菜单项列表，如果提供则渲染 items，否则使用 slot
}

const props = defineProps<Props>();

const emit = defineEmits<{
    close: [];
    command: [command: string];
}>();

const menuRef = ref<HTMLElement | null>(null);
const adjustedPosition = ref({ x: props.position.x, y: props.position.y });

// 子菜单相关状态
const activeSubmenuIndex = ref<number | null>(null);
const submenuRefs = new Map<number, HTMLElement>(); // 非响应式，避免触发重新渲染
const submenuStyles = ref<Map<number, CSSProperties>>(new Map());
// 记录已经调整过位置的子菜单索引，避免重复调整导致死循环
const adjustedSubmenuIndexes = new Set<number>();
// 子菜单关闭延迟定时器（解决从父菜单项移动到子菜单时的过渡区域问题）
let submenuCloseTimer: ReturnType<typeof setTimeout> | null = null;
const SUBMENU_CLOSE_DELAY = 150; // ms

const menuStyle = computed<CSSProperties>(() => ({
    position: "fixed",
    left: `${adjustedPosition.value.x}px`,
    top: `${adjustedPosition.value.y}px`,
    zIndex: 9999,
}));

const calculateMenuPosition = (
    element: HTMLElement,
    position: { x: number; y: number }
): { x: number; y: number } => {
    const menuRect = element.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const margin = 10;

    if (menuRect.width === 0 || menuRect.height === 0) {
        return position;
    }

    let x = position.x;
    let y = position.y;

    if (x + menuRect.width > windowWidth) {
        x = windowWidth - menuRect.width - margin;
        if (x < margin) x = margin;
    }

    const spaceBelow = windowHeight - y;
    const spaceAbove = y;
    if (menuRect.height > spaceBelow) {
        if (spaceAbove >= menuRect.height) {
            y = position.y - menuRect.height;
        } else {
            y = Math.max(margin, windowHeight - menuRect.height - margin);
        }
    }

    if (x < margin) x = margin;
    if (y < margin) y = margin;

    return { x, y };
};

const adjustPosition = () => {
    nextTick(() => {
        nextTick(() => {
            nextTick(() => {
                if (!menuRef.value) return;

                const menuRect = menuRef.value.getBoundingClientRect();
                if (menuRect.width === 0 || menuRect.height === 0) {
                    setTimeout(adjustPosition, 10);
                    return;
                }

                adjustedPosition.value = calculateMenuPosition(menuRef.value, props.position);
            });
        });
    });
};

watch(
    () => props.visible,
    (newVal) => {
        if (newVal) {
            adjustedPosition.value = { x: props.position.x, y: props.position.y };
            adjustPosition();
        } else {
            activeSubmenuIndex.value = null;
            submenuRefs.clear();
            submenuStyles.value.clear();
            adjustedSubmenuIndexes.clear();
            // 清理子菜单关闭定时器
            if (submenuCloseTimer) {
                clearTimeout(submenuCloseTimer);
                submenuCloseTimer = null;
            }
        }
    }
);

watch(
    () => props.position,
    () => {
        if (props.visible) {
            adjustedPosition.value = { x: props.position.x, y: props.position.y };
            adjustPosition();
        }
    },
    { deep: true }
);

watch(activeSubmenuIndex, (newIndex, oldIndex) => {
    if (oldIndex !== null && oldIndex !== newIndex) {
        submenuRefs.delete(oldIndex);
        submenuStyles.value.delete(oldIndex);
        adjustedSubmenuIndexes.delete(oldIndex);
    }
});

// 子菜单 hover 处理（带延迟，解决从父菜单项移动到子菜单时的过渡问题）
const handleSubmenuTriggerEnter = (index: number) => {
    // 取消关闭定时器
    if (submenuCloseTimer) {
        clearTimeout(submenuCloseTimer);
        submenuCloseTimer = null;
    }
    activeSubmenuIndex.value = index;
};

const handleSubmenuTriggerLeave = () => {
    // 延迟关闭子菜单，给用户移动到子菜单的时间
    if (submenuCloseTimer) {
        clearTimeout(submenuCloseTimer);
    }
    submenuCloseTimer = setTimeout(() => {
        activeSubmenuIndex.value = null;
        submenuCloseTimer = null;
    }, SUBMENU_CLOSE_DELAY);
};

const handleSubmenuEnter = (index: number) => {
    // 进入子菜单区域，取消关闭定时器
    if (submenuCloseTimer) {
        clearTimeout(submenuCloseTimer);
        submenuCloseTimer = null;
    }
    activeSubmenuIndex.value = index;
};

const handleSubmenuLeave = () => {
    // 离开子菜单区域，延迟关闭
    if (submenuCloseTimer) {
        clearTimeout(submenuCloseTimer);
    }
    submenuCloseTimer = setTimeout(() => {
        activeSubmenuIndex.value = null;
        submenuCloseTimer = null;
    }, SUBMENU_CLOSE_DELAY);
};

const getItemVisible = (item: MenuItem) => {
    // 当 item 声明了 children，但 children 为空时，不渲染该 item（例如“更多”菜单没有任何子项）
    if (item.children && item.children.length === 0) return false;
    if (item.visible === undefined) return true;
    if (typeof item.visible === "boolean") return item.visible;
    try {
        return item.visible();
    } catch {
        return false;
    }
};

const handleItemClick = (item: MenuItem) => {
    if (item.onClick) item.onClick();
    if (item.command) emit("command", item.command);
    emit("close");
};

const setSubmenuRef = (el: HTMLElement, index: number) => {
    submenuRefs.set(index, el);
    if (!adjustedSubmenuIndexes.has(index)) {
        adjustedSubmenuIndexes.add(index);
        nextTick(() => {
            const submenuEl = submenuRefs.get(index);
            if (!submenuEl) return;
            const rect = submenuEl.getBoundingClientRect();
            const windowWidth = window.innerWidth;
            const windowHeight = window.innerHeight;
            const margin = 10;

            let style: CSSProperties = {};
            if (rect.right > windowWidth) {
                style = { ...style, right: "100%", left: "auto" };
            }
            if (rect.bottom > windowHeight) {
                style = { ...style, bottom: "0", top: "auto" };
            }
            if (rect.top < margin) {
                style = { ...style, top: "0", bottom: "auto" };
            }

            submenuStyles.value.set(index, style);
        });
    }
};

const getSubmenuStyle = (index: number): CSSProperties => {
    return submenuStyles.value.get(index) || {};
};
</script>

<style scoped lang="scss">
.context-menu-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9998;
}

.context-menu {
    background: var(--anime-bg-card);
    border: 1px solid var(--anime-border);
    border-radius: 12px;
    padding: 6px;
    min-width: 180px;
    box-shadow: var(--anime-shadow);
    backdrop-filter: blur(10px);
}

.context-menu-item {
    display: flex;
    align-items: center;
    padding: 8px 10px;
    border-radius: 10px;
    cursor: pointer;
    user-select: none;
    transition: background 0.15s ease;
    color: var(--anime-text-primary);
}

.context-menu-item:hover {
    background: rgba(255, 107, 157, 0.12);
}

.context-menu-divider {
    height: 1px;
    background: var(--anime-border);
    margin: 6px 0;
}

.submenu-trigger {
    position: relative;
}

.submenu {
    position: absolute;
    left: 100%;
    top: 0;
    margin-left: 8px;
    background: var(--anime-bg-card);
    border: 1px solid var(--anime-border);
    border-radius: 12px;
    padding: 6px;
    min-width: 180px;
    box-shadow: var(--anime-shadow);
}

.submenu-arrow {
    margin-left: auto;
    color: var(--anime-text-muted);
    opacity: 0.9;
}
</style>
