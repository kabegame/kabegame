<template>
    <el-drawer v-model="drawer.isOpen" :title="drawer.title" size="420px" append-to-body>
        <div v-loading="loading" style="min-height: 120px;">
            <div v-if="groups.length === 0" class="empty">
                <el-empty description="此页面暂无可快捷调整的设置" :image-size="100" />
            </div>

            <div v-else class="list">
                <div v-for="g in groups" :key="g.id" class="group">
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
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useQuickSettingsDrawerStore } from "@/stores/quickSettingsDrawer";
import { useSettingsStore, type AppSettingKey } from "@/stores/settings";
import { QUICK_SETTINGS_GROUPS, SettingRow } from "@/settings/quickSettingsRegistry";

const drawer = useQuickSettingsDrawerStore();
const settingsStore = useSettingsStore();
const { pageId } = storeToRefs(drawer);

const loading = ref(false);

const groups = computed(() => {
    const pid = pageId.value;
    return QUICK_SETTINGS_GROUPS
        .map((g) => ({
            ...g,
            items: g.items.filter((x) => x.pages.includes(pid)),
        }))
        .filter((g) => g.items.length > 0);
});

// 依赖轮播启用的设置项（未启用时应禁用+提示）
const ROTATION_DEPENDENT_KEYS: AppSettingKey[] = [
    "wallpaperRotationIntervalMinutes",
    "wallpaperRotationMode",
    "wallpaperRotationTransition",
];

const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

// 计算每个项的禁用状态
const isItemDisabled = (item: (typeof groups.value)[0]["items"][0]): boolean => {
    if (ROTATION_DEPENDENT_KEYS.includes(item.key)) {
        return !rotationEnabled.value;
    }
    return false;
};

// 获取有效的 props（注入 disabled 状态）
const getEffectiveProps = (item: (typeof groups.value)[0]["items"][0]): Record<string, any> => {
    const base = item.props || {};
    const disabled = isItemDisabled(item);
    return { ...base, disabled: disabled || base.disabled };
};

// 获取有效的描述（未启用时追加提示）
const getEffectiveDescription = (item: (typeof groups.value)[0]["items"][0]): string | undefined => {
    const base = item.description;
    if (ROTATION_DEPENDENT_KEYS.includes(item.key) && !rotationEnabled.value) {
        return base ? `${base}（需先启用壁纸轮播）` : "需先启用壁纸轮播";
    }
    return base;
};

watch(
    () => drawer.isOpen,
    async (open) => {
        if (!open) return;
        loading.value = true;
        try {
            // 目前先全量拉取（设置页/抽屉都更顺滑），后续可按 keysForPage 细化为 loadMany
            await settingsStore.loadAll();
        } finally {
            loading.value = false;
        }
    }
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
