<template>
    <el-radio-group v-model="localValue" :disabled="switching" class="wallpaper-mode-radio-group"
        @change="handleChange">
        <el-radio value="native">{{ t('settings.modeNative') }}</el-radio>
        <el-radio v-if="IS_WINDOWS || IS_MACOS" value="window">{{ t('settings.modeWindow') }}</el-radio>
    </el-radio-group>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { listen } from "@tauri-apps/api/event";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { IS_MACOS, IS_WINDOWS } from "@kabegame/core/env";

const { t } = useI18n();

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

    const prevMode = (settingValue.value as any as string) || "native";
    uiStore.wallpaperModeSwitching = true as any;

    // 特殊逻辑：等待模式切换完成
    const onAfterSave = async () => {
        return new Promise<void>((resolve, reject) => {
            const waitForSwitchComplete = async () => {
                try {
                    const timeoutId = setTimeout(() => {
                        reject(new Error(t("settings.wallpaperModeSwitchTimeout")));
                    }, 30000);

                    const unlistenFn = await listen<{ success: boolean; mode: string; error?: string }>(
                        "wallpaper-mode-switch-complete",
                        (event) => {
                            if (event.payload.mode === mode) {
                                clearTimeout(timeoutId);
                                unlistenFn();
                                if (event.payload.success) {
                                    ElMessage.success(t("settings.wallpaperModeSwitchSuccess"));
                                    resolve();
                                } else {
                                    const errorMsg = event.payload.error || t("settings.wallpaperModeSwitchFailed");
                                    ElMessage.error(`${t("settings.wallpaperModeSwitchFailed")}: ${errorMsg}`);
                                    reject(new Error(errorMsg));
                                }
                            }
                        }
                    );
                } catch (listenError) {
                    reject(new Error(`监听切换完成事件失败: ${listenError}`));
                }
            };

            waitForSwitchComplete();
        });
    };

    try {
        await set(mode, onAfterSave);
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