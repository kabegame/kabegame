<template>
    <el-radio-group v-model="localValue" :disabled="switching" class="wallpaper-mode-radio-group"
        @change="handleChange">
        <el-radio value="native">原生模式</el-radio>
        <el-radio v-if="IS_WINDOWS" value="window">窗口模式</el-radio>
    </el-radio-group>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { listen } from "@tauri-apps/api/event";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { IS_WINDOWS } from "@kabegame/core/env";

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

    // 如果切换到原生模式，提示用户会覆盖原来壁纸
    if (mode === "native") {
        try {
            await ElMessageBox.confirm(
                "切换到原生模式会覆盖系统当前壁纸设置，是否继续？",
                "提示",
                {
                    confirmButtonText: "继续",
                    cancelButtonText: "取消",
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
                        reject(new Error("切换模式超时：后端未在 30 秒内响应"));
                    }, 30000);

                    const unlistenFn = await listen<{ success: boolean; mode: string; error?: string }>(
                        "wallpaper-mode-switch-complete",
                        (event) => {
                            if (event.payload.mode === mode) {
                                clearTimeout(timeoutId);
                                unlistenFn();
                                if (event.payload.success) {
                                    ElMessage.success("壁纸模式已切换");
                                    resolve();
                                } else {
                                    const errorMsg = event.payload.error || "切换模式失败";
                                    ElMessage.error(`切换模式失败: ${errorMsg}`);
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
        ElMessage.error(`切换模式失败: ${msg}`);
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