<template>
    <!-- 与「轮播模式」等设置一致，用方框分段切换而不是 radio -->
    <SegmentedControl :model-value="localValue" :options="modeOptions" :disabled="switching"
        @update:model-value="handleChange" />
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";
import SegmentedControl from "@kabegame/core/components/settings/controls/SegmentedControl.vue";

const { t, locale } = useI18n();
const capabilities = useWallpaperCapabilities();

const { settingValue, disabled, set } = useSettingKeyState("wallpaperMode");
const uiStore = useUiStore();

const switching = computed(() => uiStore.wallpaperModeSwitching === true || disabled.value);
const modeOptions = computed(() =>
    capabilities.modes.value.map((mode) => ({
        value: mode.value,
        label: resolveManifestText(mode.label, locale.value),
    }))
);

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
            // 用户取消。SegmentedControl 不做乐观更新，选中项还停在原值，无需回滚
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
            return;
        }
    }

    const prevMode = (settingValue.value as any as string) || "native";
    // 切换期间控件被 switching 禁用，这里乐观更新只为让选中框立刻跟手，失败再回滚
    localValue.value = mode;
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
