<template>
    <el-drawer v-model="drawer.isOpen" :title="drawer.title" :size="drawerSize" :append-to-body="appendToBody" class="quick-settings-drawer drawer-max-width">
        <div v-loading="loading" style="min-height: 120px;">
            <div v-if="filteredGroups.length === 0" class="empty">
                <el-empty :description="emptyDescription" :image-size="100" />
            </div>

            <div v-else class="list">
                <div v-for="g in filteredGroups" :key="g.id" class="group">
                    <div class="group-header">
                        <div class="group-title">{{ g.title }}</div>
                        <div v-if="g.description" class="group-desc">{{ g.description }}</div>
                    </div>

                    <div class="group-items">
                        <div v-for="it in g.items" :key="it.key" class="item">
                            <SettingRow :label="it.label" :description="getEffectiveDescription(it)">
                                <component :is="it.comp" v-bind="getEffectiveProps(it)" />
                            </SettingRow>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch, type PropType } from "vue";
import { useSettingsStore } from "../../stores/settings";
import SettingRow from "./SettingRow.vue";
import type {
    QuickSettingGroup,
    QuickSettingItem,
} from "./quick-settings-registry-types";

type DrawerLike<PageId extends string> = {
    isOpen: boolean;
    title: string;
    pageId: PageId;
};

const props = defineProps({
    drawer: {
        type: Object as PropType<DrawerLike<string>>,
        required: true,
    },
    groups: {
        type: Array as PropType<Array<QuickSettingGroup<string>>>,
        required: true,
    },
    drawerSize: {
        type: String,
        default: "420px",
    },
    appendToBody: {
        type: Boolean,
        default: true,
    },
    emptyDescription: {
        type: String,
        default: "此页面暂无可快捷调整的设置",
    },
    loadOnOpen: {
        type: Boolean,
        default: true,
    },
    getItemDisabled: {
        type: Function as PropType<(item: QuickSettingItem<string>) => boolean>,
        default: undefined,
    },
    getItemProps: {
        type: Function as PropType<
            (
                item: QuickSettingItem<string>,
                baseProps: Record<string, any>
            ) => Record<string, any>
        >,
        default: undefined,
    },
    getItemDescription: {
        type: Function as PropType<
            (
                item: QuickSettingItem<string>,
                baseDescription: string | undefined
            ) => string | undefined
        >,
        default: undefined,
    },
});

const drawer = props.drawer;
const settingsStore = useSettingsStore();
const loading = ref(false);

const filteredGroups = computed(() => {
    const pid = drawer.pageId;
    return props.groups
        .map((g) => ({
            ...g,
            items: g.items.filter((x) => x.pages.includes(pid)),
        }))
        .filter((g) => g.items.length > 0);
});

const getEffectiveProps = (item: QuickSettingItem<string>): Record<string, any> => {
    const base = item.props || {};
    const extra = props.getItemProps ? props.getItemProps(item, base) : {};
    const disabled = props.getItemDisabled ? props.getItemDisabled(item) : false;
    return { ...base, ...extra, disabled: disabled || base.disabled };
};

const getEffectiveDescription = (
    item: QuickSettingItem<string>
): string | undefined => {
    const base = item.description;
    return props.getItemDescription ? props.getItemDescription(item, base) : base;
};

watch(
    () => [drawer.isOpen, drawer.pageId] as const,
    async ([open]) => {
        if (!open) return;
        if (!props.loadOnOpen) return;
        const keys = Array.from(
            new Set(filteredGroups.value.flatMap((g) => g.items.map((it) => it.key)))
        );
        if (keys.length === 0) return;
        loading.value = true;
        try {
            await settingsStore.loadMany(keys);
        } finally {
            loading.value = false;
        }
    },
    { flush: "post" }
);
</script>

<style scoped lang="scss">
.list {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.group {
    padding: 10px 0;
    border-bottom: 1px solid var(--anime-border);
}

.group-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
}

.group-title {
    font-weight: 700;
    font-size: 14px;
    color: var(--anime-text-primary);
}

.group-desc {
    font-size: 12px;
    color: var(--anime-text-muted);
}

.group-items {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.item {
    padding: 2px 0;
}

.empty {
    padding: 12px 0;
}
</style>

<style lang="scss">
</style>
