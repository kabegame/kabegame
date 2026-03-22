<template>
    <div class="empty-state">
        <img src="/album-empty.png" alt="空状態" class="empty-image" />
        <p class="empty-tip">{{ primaryText }}</p>
        <p v-if="showSecondLine" class="empty-tip">{{ $t('common.emptyStateHint') }}</p>
    </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID } from "@kabegame/core/env";

const props = defineProps<{
  /** 传入时替换主提示（用于壁纸顺序空状态等）；不传则使用默认 emptyStateTip */
  primaryTip?: string;
}>();

const { t } = useI18n();

const primaryText = computed(() => props.primaryTip ?? t("common.emptyStateTip"));

/** 自定义主文案时不显示第二行提示，保持与默认两行文案总高度接近时可单独传 primaryTip */
const showSecondLine = computed(() => !props.primaryTip && !IS_ANDROID);
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
}
</style>