<template>
    <el-radio-group v-model="localValue" :disabled="switching" class="wallpaper-mode-radio-group"
        @change="handleChange">
        <el-radio value="native">{{ t('settings.modeNative') }}</el-radio>
        <el-radio v-if="isPlasma" value="plasma-plugin">{{ t('settings.modePlugin') }}</el-radio>
        <el-radio v-if="IS_WINDOWS || IS_MACOS" value="window">{{ t('settings.modeWindow') }}</el-radio>
    </el-radio-group>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { IS_MACOS, IS_WINDOWS } from "@kabegame/core/env";
import { useDesktop } from "@/composables/useDesktop";

const { t } = useI18n();
const { isPlasma } = useDesktop();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wallpaperMode");
const uiStore = useUiStore();

const switching = computed(() => uiStore.wallpaperModeSwitching === true);

const localValue = ref<string>("native");
watch(
    () => settingValue.value,
    (v) => {
        localValue.value = (v as any as string) || "native";
    },
    { immediate: true }
);

const handleChange = async (mode: string) => {
    if (switching.value) return;

    if (mode === "native") {
        try {
            await ElMessageBox.confirm(
                t("settings.wallpaperModeConfirmMessage"),
                t("settings.wallpaperModeConfirmTitle"),
                {
                    confirmButtonText: t("settings.wallpaperModeConfirmOk"),
                    cancelButtonText: t("common.cancel"),
                    type: "warning",
                }
            );
        } catch {
            // 用户取消，恢复原值
            localValue.value = (settingValue.value as any as string) || "native";
            return;
        }
    }
    if (mode === "plasma-plugin") {
        try {
            await ElMessageBox.confirm(
                t("settings.wallpaperModePluginConfirmMessage"),
                t("settings.wallpaperModeConfirmTitle"),
                {
                    confirmButtonText: t("settings.wallpaperModeConfirmOk"),
                    cancelButtonText: t("common.cancel"),
                    type: "warning",
                }
            );
        } catch {
            localValue.value = (settingValue.value as any as string) || "native";
            return;
        }
    }

    const prevMode = (settingValue.value as any as string) || "native";
    uiStore.wallpaperModeSwitching = true as any;

    try {
        await set(mode);
        ElMessage.success(t("settings.wallpaperModeSwitchSuccess"));
    } catch (e: any) {
        const msg = e?.message || String(e);
        ElMessage.error(`${t("settings.wallpaperModeSwitchFailed")}: ${msg}`);
        // 回滚
        localValue.value = prevMode;
        // eslint-disable-next-line no-console
        console.error("切换模式异常:", e);
    } finally {
        uiStore.wallpaperModeSwitching = false as any;
    }
};
</script>

<style scoped lang="scss">
.wallpaper-mode-radio-group {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
}
</style>