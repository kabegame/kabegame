<template>
    <el-radio-group v-model="localValue" :disabled="switching" class="flex flex-col items-start gap-3"
        @change="handleChange">
        <el-radio v-for="mode in modeOptions" :key="mode.value" :value="mode.value">
            {{ mode.label }}
        </el-radio>
    </el-radio-group>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { resolveManifestText, useI18n } from "@kabegame/i18n";
import { ElMessageBox } from "element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useWallpaperCapabilities } from "@/composables/useWallpaperCapabilities";

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
