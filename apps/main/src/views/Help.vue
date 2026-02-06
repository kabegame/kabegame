<template>
    <div class="help-container">
        <PageHeader title="도움말" subtitle="お互いに理解を深めましょう" sticky />

        <StyledTabs v-model="activeTab" sticky>
            <el-tab-pane label="使用技巧" name="tips">
                <el-card class="help-card">
                    <template #header>
                        <div class="tips-header">
                            <span>使用技巧</span>
                            <el-button v-if="selectedTip" @click="closeTipDetail" plain size="small">返回列表</el-button>
                        </div>
                    </template>

                    <!-- 列表：目录分类 + 下拉折叠 -->
                    <div v-if="!selectedTip" class="tips-list">
                        <el-alert class="help-alert" type="info" show-icon :closable="false">
                            点击任意表项进入详情。
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

                                <el-table :data="c.tips" size="small" style="width: 100%" empty-text="暂无技巧"
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
            <el-tab-pane label="快捷键" name="shortcuts">
                <el-card class="help-card">
                    <template #header>
                        <span>快捷键帮助</span>
                    </template>

                    <el-alert class="help-alert" type="info" show-icon :closable="false">
                        说明：部分快捷键仅在图片网格获得焦点时生效（先在网格空白处/图片上点一下）。
                    </el-alert>

                    <div class="help-list">
                        <SettingRow v-for="item in shortcutItems" :key="item.id" :label="item.label"
                            :description="item.description">
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
import { TIP_CATEGORIES, type Tip, type TipCategoryId, type TipId } from "@/help/tipsRegistry";
import { IS_MACOS } from "@kabegame/core/env";

type ShortcutItem = {
    id: string;
    label: string;
    description: string;
    keys: string[];
};

const route = useRoute();
const router = useRouter();

const activeTab = ref<string>("tips");

// 使用技巧：目录分类 + 点击进入详情
const tipCategories = TIP_CATEGORIES;
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
            for (const category of tipCategories) {
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
    for (const category of tipCategories) {
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

// 仅收录"代码中确实绑定并生效"的快捷键，避免误导用户：
// - 图片网格（packages/core/src/components/image/ImageGrid.vue）
// - 图片预览（packages/core/src/components/common/ImagePreviewDialog.vue）
const shortcutItems = computed<ShortcutItem[]>(() => {
    return [
        {
            id: "global-fullscreen",
            label: "切换全屏",
            description: "切换应用的全屏显示模式",
            keys: IS_MACOS ? ["Control", "Command", "F"] : ["F11"],
        },
        {
            id: "grid-zoom-wheel",
        label: "调整网格列数",
        description: "按住 Ctrl（macOS 为 Cmd）并滚动鼠标滚轮，可快速调整图片网格的列数",
            keys: ["Ctrl/Cmd", "滚轮"],
        },
        {
            id: "grid-zoom-plus-minus",
            label: "调整网格列数",
            description: "按住 Ctrl（macOS 为 Cmd）并按 +/-（或 =），可调整图片网格的列数",
            keys: ["Ctrl/Cmd", "+ / -（或 =）"],
        },
        {
            id: "grid-select-all",
            label: "全选",
            description: "在图片网格中快速全选当前页面的所有图片",
            keys: ["Ctrl/Cmd", "A"],
        },
        {
            id: "grid-clear-selection",
            label: "清空选择",
            description: "清空已选择的图片，并关闭可能打开的右键菜单",
            keys: ["Esc"],
        },
        {
            id: "grid-delete",
            label: "删除选中图片",
            description: "在图片网格中删除当前选中的图片（会进入应用的删除流程/确认）",
            keys: ["Delete / Backspace"],
        },
        {
            id: "grid-select-range",
            label: "范围选择",
            description: "在网格中按住 Shift 点击图片，可按上次选择位置进行范围选择",
            keys: ["Shift", "点击"],
        },
        {
            id: "grid-toggle-select",
            label: "多选/取消选择",
            description: "在网格中按住 Ctrl（macOS 为 Cmd）点击图片，可切换该图片的选择状态",
            keys: ["Ctrl/Cmd", "点击"],
        },
        {
            id: "preview-prev-next",
            label: "预览上一张/下一张",
            description: "在图片预览对话框中切换上一张/下一张",
            keys: ["←", "→"],
        },
        {
            id: "copy-image",
            label: "复制图片",
            description: "在图片预览对话框中，或图片网格单选时，复制当前图片到剪贴板",
            keys: ["Ctrl/Cmd", "C"],
        },
        {
            id: "preview-delete",
            label: "预览中删除",
            description: "在图片预览对话框中快速删除当前图片（会进入应用的删除流程/确认）",
            keys: ["Delete / Backspace"],
        },
    ];
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
