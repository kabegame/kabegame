<template>
    <div class="help-container">
        <PageHeader :title="$t('help.pageTitle')" :subtitle="$t('help.pageSubtitle')" sticky />

        <StyledTabs v-model="activeTab" sticky>
            <el-tab-pane :label="$t('help.tipsTab')" name="tips">
                <el-card class="help-card">
                    <template #header>
                        <div class="tips-header">
                            <span>{{ $t('help.tipsTitle') }}</span>
                            <el-button v-if="selectedTip" @click="closeTipDetail" plain size="small">{{ $t('help.backToList') }}</el-button>
                        </div>
                    </template>

                    <!-- 列表：目录分类 + 下拉折叠 -->
                    <div v-if="!selectedTip" class="tips-list">
                        <el-alert class="help-alert" type="info" show-icon :closable="false">
                            {{ $t('help.clickToDetail') }}
                        </el-alert>

                        <el-collapse v-model="expandedCategoryIds">
                            <el-collapse-item v-for="c in tipCategories" :key="c.id" :name="c.id">
                                <template #title>
                                    <div class="category-title">
                                        <span class="category-name">{{ c.title }}</span>
                                        <el-tag v-for="(tag, idx) in c.tags" :key="idx" :type="tag.type" size="small"
                                            effect="dark" style="margin-left: 8px;">
                                            {{ tag.text }}
                                        </el-tag>
                                        <span class="category-desc" v-if="c.description">{{ c.description }}</span>
                                    </div>
                                </template>

                                <el-table :data="c.tips" size="small" style="width: 100%" :empty-text="$t('help.noTips')"
                                    :show-header="false" @row-click="handleTipRowClick" row-class-name="tip-row">
                                    <el-table-column min-width="460">
                                        <template #default="{ row }">
                                            <div class="tip-row-content">
                                                <div class="tip-row-text">
                                                    <div class="tip-row-title">
                                                        {{ row.title }}
                                                        <el-tag v-for="(tag, idx) in row.tags" :key="idx"
                                                            :type="tag.type" size="small" effect="dark"
                                                            style="margin-left: 8px; vertical-align: text-bottom;">
                                                            {{ tag.text }}
                                                        </el-tag>
                                                    </div>
                                                    <div class="tip-row-summary">{{ row.summary }}</div>
                                                </div>
                                                <el-icon class="tip-row-arrow">
                                                    <ArrowRight />
                                                </el-icon>
                                            </div>
                                        </template>
                                    </el-table-column>
                                </el-table>
                            </el-collapse-item>
                        </el-collapse>
                    </div>

                    <!-- 详情 -->
                    <div v-else class="tip-detail">
                        <div class="tip-title">
                            {{ selectedTip.title }}
                            <el-tag v-for="(tag, idx) in selectedTip.tags" :key="idx" :type="tag.type" size="default"
                                effect="dark" style="margin-left: 10px; vertical-align: middle;">
                                {{ tag.text }}
                            </el-tag>
                        </div>
                        <div class="tip-summary">{{ selectedTip.summary }}</div>

                        <!-- 复杂详情：优先渲染组件 -->
                        <component v-if="selectedTip.component" :is="selectedTip.component" />

                        <!-- 简单详情：兜底渲染段落结构 -->
                        <div v-else-if="selectedTip.detail" class="tip-sections">
                            <div v-for="(s, idx) in selectedTip.detail.sections" :key="idx" class="tip-section">
                                <div class="tip-section-title">{{ s.title }}</div>
                                <div class="tip-paragraph" v-for="(p, pIdx) in s.paragraphs" :key="pIdx">{{ p }}</div>
                                <ul v-if="s.bullets && s.bullets.length" class="tip-bullets">
                                    <li v-for="(b, bIdx) in s.bullets" :key="bIdx">{{ b }}</li>
                                </ul>
                                <el-alert v-if="s.note" class="tip-note" type="warning" show-icon :closable="false">
                                    {{ s.note }}
                                </el-alert>
                            </div>
                        </div>
                    </div>
                </el-card>
            </el-tab-pane>
            <el-tab-pane :label="$t('help.shortcutsTab')" name="shortcuts">
                <el-card class="help-card">
                    <template #header>
                        <span>{{ $t('help.shortcutHelpTitle') }}</span>
                    </template>

                    <el-alert class="help-alert" type="info" show-icon :closable="false">
                        {{ $t('help.shortcutNote') }}
                    </el-alert>

                    <div class="help-list">
                        <SettingRow v-for="item in shortcutItems" :key="item.id" :label="$t(item.labelKey)"
                            :description="$t(item.descriptionKey)">
                            <div class="shortcut-keys">
                                <span v-for="(k, idx) in item.keys" :key="idx" class="kbd">{{ k }}</span>
                            </div>
                        </SettingRow>
                    </div>
                </el-card>
            </el-tab-pane>
        </StyledTabs>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import StyledTabs from "@/components/common/StyledTabs.vue";
import SettingRow from "@kabegame/core/components/settings/SettingRow.vue";
import { ArrowRight } from "@element-plus/icons-vue";
import { getTipCategories, type Tip, type TipCategoryId, type TipId } from "@/help/tipsRegistry";
import { getHelpGroups } from "@/help/helpRegistry";
import { useI18n } from "vue-i18n";

const route = useRoute();
const router = useRouter();

const activeTab = ref<string>("tips");
const { t, locale } = useI18n();

// 使用技巧：目录分类 + 点击进入详情（随语言切换更新）
const tipCategories = computed(() => {
  void locale.value;
  return getTipCategories(t);
});
const selectedTipId = ref<string | null>(null);
const expandedCategoryIds = ref<TipCategoryId[]>(["gallery"]);

// 从路由参数读取 tipId
const routeTipId = computed(() => {
    const tipId = route.params.tipId;
    return typeof tipId === "string" ? (tipId as TipId) : null;
});

// 同步路由参数到 selectedTipId
watch(
    routeTipId,
    (tipId) => {
        if (tipId) {
            // 有路由参数时，切换到 tips tab 并设置选中
            activeTab.value = "tips";
            selectedTipId.value = tipId;
            // 自动展开包含该 tip 的分类
            for (const category of tipCategories.value) {
                if (category.tips.some((t) => t.id === tipId)) {
                    if (!expandedCategoryIds.value.includes(category.id)) {
                        expandedCategoryIds.value = [...expandedCategoryIds.value, category.id];
                    }
                    break;
                }
            }
        } else {
            // 没有路由参数时，清除选中
            selectedTipId.value = null;
        }
    },
    { immediate: true }
);

const selectedTip = computed<Tip | null>(() => {
    if (!selectedTipId.value) return null;
    for (const category of tipCategories.value) {
        const tip = category.tips.find((t) => t.id === selectedTipId.value);
        if (tip) return tip;
    }
    return null;
});

const handleTipRowClick = (row: Tip) => {
    // 跳转到路由
    router.push(`/help/tips/${row.id}`);
};

const closeTipDetail = () => {
    // 跳转回帮助首页
    router.push("/help");
};

// 从 helpRegistry 获取快捷键列表（含 i18n key），展平为单列表
const shortcutItems = computed(() => {
    const groups = getHelpGroups();
    return groups.flatMap((g) => g.items).filter((it) => it.labelKey && it.descriptionKey);
});
</script>

<style scoped lang="scss">
.help-container {
    width: 100%;
    height: 100%;
    padding: 20px;
    overflow-y: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;

    &::-webkit-scrollbar {
        display: none;
    }
}

.help-card {
    background: var(--anime-bg-card);
    border-radius: 16px;
    box-shadow: var(--anime-shadow);
    transition: none !important;

    &:hover {
        transform: none !important;
        box-shadow: var(--anime-shadow) !important;
    }
}

.help-alert {
    margin-bottom: 12px;
}

.help-list {
    display: flex;
    flex-direction: column;
}

.shortcut-keys {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}

.kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px 10px;
    border-radius: 8px;
    border: 1px solid var(--anime-border);
    background: rgba(255, 255, 255, 0.5);
    color: var(--anime-text-primary);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    user-select: none;
}

.tips-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.tips-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.category-title {
    display: flex;
    align-items: center;
    gap: 2px;
}

.category-name {
    font-weight: 700;
    color: var(--anime-text-primary);
}

.category-desc {
    font-size: 12px;
    color: var(--anime-text-muted);
}

.tip-detail {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.tip-title {
    font-size: 18px;
    font-weight: 800;
    color: var(--anime-text-primary);
}

.tip-summary {
    font-size: 13px;
    color: var(--anime-text-secondary);
}

.tip-sections {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 4px;
}

.tip-section {
    padding: 10px 0;
    border-bottom: 1px solid var(--anime-border);
}

.tip-section-title {
    font-weight: 700;
    color: var(--anime-text-primary);
    margin-bottom: 6px;
}

.tip-paragraph {
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
    margin-bottom: 6px;
}

.tip-bullets {
    margin: 6px 0 0 18px;
    color: var(--anime-text-primary);
    font-size: 13px;
    line-height: 1.7;
}

.tip-note {
    margin-top: 10px;
}

.tip-row-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 6px;
    cursor: pointer;
}

.tip-row-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
}

.tip-row-title {
    font-weight: 700;
    color: var(--anime-text-primary);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tip-row-summary {
    font-size: 12px;
    color: var(--anime-text-muted);
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.tip-row-arrow {
    color: var(--anime-text-muted);
    flex-shrink: 0;
}

:deep(.el-table__row.tip-row) {
    transition: background-color 0.15s ease;
}

:deep(.el-table__row.tip-row:hover) {
    background: rgba(255, 107, 157, 0.08);
}
</style>
