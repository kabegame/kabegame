<template>
    <div class="empty-state">
        <img :src="imageSrc" alt="空状態" class="empty-image" />
        <p v-for="(line, index) in textLines" :key="index" class="empty-tip">{{ line }}</p>
        <el-button v-if="showButton" type="primary" class="empty-action-btn" @click="emit('buttonClick')">
            {{ buttonText }}
        </el-button>
    </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useUiStore } from "@kabegame/core/stores/ui";

const props = defineProps<{
  /** 传入时替换主提示（用于壁纸顺序空状态等）；不传则使用默认 emptyStateTip */
  primaryTip?: string;
  /** 自定义多行文案，每行单独居中显示；传入时完全替换默认文案（含 primaryTip） */
  lines?: string[];
  /** 自定义图片地址；不传则使用默认空状态图 */
  image?: string;
  /** 是否显示操作按钮；默认不显示 */
  showButton?: boolean;
  /** 按钮文案 */
  buttonText?: string;
}>();

const emit = defineEmits<{
  (e: "buttonClick"): void;
}>();

const { t } = useI18n();
const uiStore = useUiStore();

const imageSrc = computed(() => props.image ?? "/album-empty.png");

const primaryText = computed(() => props.primaryTip ?? t("common.emptyStateTip"));

/** 自定义主文案时不显示第二行提示，保持与默认两行文案总高度接近时可单独传 primaryTip */
const showSecondLine = computed(() => !props.primaryTip && !uiStore.isCompact);

/** 默认两行（主提示 + 通用提示）；传入 lines 时按传入行数渲染 */
const textLines = computed(() => {
  if (props.lines?.length) return props.lines;
  return showSecondLine.value ? [primaryText.value, t("common.emptyStateHint")] : [primaryText.value];
});
</script>

<style scoped lang="scss">
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 32px;
    height: 100%;
    min-height: 300px;

    .empty-image {
        width: 200px;
        max-width: 60%;
        height: auto;
        opacity: 0.85;
        margin-bottom: 24px;
        user-select: none;
        pointer-events: none;
    }

    .empty-tip {
        color: gray;
        font-size: 14px;
        text-align: center;
        line-height: 1.6;
        text-shadow: 0 1px 3px rgba(255, 255, 255, 0.3);
    }

    .empty-action-btn {
        margin-top: 16px;
    }
}
</style>