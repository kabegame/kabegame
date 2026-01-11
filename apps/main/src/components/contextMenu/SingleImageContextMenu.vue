<template>
    <ContextMenu :visible="visible" :position="position" :items="menuItems" @close="$emit('close')"
        @command="$emit('command', $event)" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
    InfoFilled,
    DocumentCopy,
    FolderOpened,
    Folder,
    Picture,
    Star,
    StarFilled,
    FolderAdd,
    Download,
    Delete,
    More,
} from "@element-plus/icons-vue";
import type { ImageInfo } from "@/stores/crawler";
import ContextMenu, { type MenuItem } from "@kabegame/core/components/ContextMenu.vue";
import { IS_WINDOWS } from "@kabegame/core/env";

interface Props {
    visible: boolean;
    position: { x: number; y: number };
    image: ImageInfo | null;
    hide?: string[]; // 要隐藏的菜单项 key 列表
    removeText?: string; // "移除"菜单项文案（不同页面可定制）
}

const props = withDefaults(defineProps<Props>(), {
    hide: () => [],
    removeText: "删除",
});

// 静态菜单项列表模板
const getMenuItemsTemplate = (image: ImageInfo | null, removeText: string): MenuItem[] => [
    {
        key: "detail",
        type: "item",
        label: "详情",
        icon: InfoFilled,
        command: "detail",
    },
    {
        key: "favorite",
        type: "item",
        label: image?.favorite ? "取消收藏" : "收藏",
        icon: image?.favorite ? StarFilled : Star,
        command: "favorite",
    },
    {
        key: "copy",
        type: "item",
        label: "复制图片",
        icon: DocumentCopy,
        command: "copy",
    },
    {
        key: "open",
        type: "item",
        label: "仔细欣赏",
        icon: FolderOpened,
        command: "open",
    },
    {
        key: "openFolder",
        type: "item",
        label: "欣赏更多",
        icon: Folder,
        command: "openFolder",
    },
    {
        key: "wallpaper",
        type: "item",
        label: "抱到桌面上",
        icon: Picture,
        command: "wallpaper",
    },
    {
        key: "addToAlbum",
        type: "item",
        label: "加入画册",
        icon: FolderAdd,
        command: "addToAlbum",
    },
    {
        key: "more",
        type: "item",
        label: "更多",
        icon: More,
        children: IS_WINDOWS
            ? [
                {
                    key: "exportToWEAuto",
                    type: "item",
                    label: "导出到wallpaper engine",
                    // 注意：仅 Windows 构建才会保留这一分支（配合 __WINDOWS__ 的 define 做 DCE）
                    icon: Download,
                    command: "exportToWEAuto",
                },
            ]
            : [],
    },
    { key: "divider", type: "divider" },
    {
        key: "remove",
        type: "item",
        label: removeText,
        icon: Delete,
        command: "remove",
    },
];

const menuItems = computed<MenuItem[]>(() => {
    const hideSet = new Set(props.hide);
    const items = getMenuItemsTemplate(props.image, props.removeText);

    // 根据 hide 列表过滤菜单项
    return items.filter((item) => {
        if (item.key && hideSet.has(item.key)) {
            return false;
        }
        // 如果有子菜单，也要过滤子菜单项
        if (item.children) {
            item.children = item.children.filter(
                (child) => !child.key || !hideSet.has(child.key)
            );
            // 如果子菜单为空，隐藏父菜单项
            if (item.children.length === 0) {
                return false;
            }
        }
        return true;
    });
});

defineEmits<{
    close: [];
    command: [command: string];
}>();
</script>

<style scoped lang="scss"></style>
