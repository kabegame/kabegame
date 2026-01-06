<template>
    <el-radio-group v-model="localValue" :disabled="switching" @change="handleChange"
        class="wallpaper-mode-radio-group">
        <el-radio label="native">原生模式</el-radio>
        <el-radio label="window">窗口模式</el-radio>
    </el-radio-group>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";

const settingsStore = useSettingsStore();
const uiStore = useUiStore();

const switching = computed(() => uiStore.wallpaperModeSwitching === true);

const localValue = ref<string>("native");
watch(
    () => settingsStore.values.wallpaperMode,
    (v) => {
        localValue.value = (v as any as string) || "native";
    },
    { immediate: true }
);

const handleChange = async (mode: string) => {
    if (switching.value) return;

    const prevMode = (settingsStore.values.wallpaperMode as any as string) || "native";
    uiStore.wallpaperModeSwitching = true as any;

    let unlistenFn: (() => void) | null = null;
    try {
        const waitForSwitchComplete = new Promise<{ success: boolean; error?: string }>(
            async (resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    const fn = unlistenFn as (() => void) | null;
                    if (fn) {
                        fn();
                        unlistenFn = null;
                    }
                    reject(new Error("切换模式超时：后端未在 30 秒内响应"));
                }, 30000);

                try {
                    const listenFn = await listen<{ success: boolean; mode: string; error?: string }>(
                        "wallpaper-mode-switch-complete",
                        (event) => {
                            if (event.payload.mode === mode) {
                                clearTimeout(timeoutId);
                                const fn = unlistenFn as (() => void) | null;
                                if (fn) {
                                    fn();
                                    unlistenFn = null;
                                }
                                resolve({ success: event.payload.success, error: event.payload.error });
                            }
                        }
                    );
                    unlistenFn = listenFn;
                } catch (listenError) {
                    clearTimeout(timeoutId);
                    reject(new Error(`监听切换完成事件失败: ${listenError}`));
                }
            }
        );

        // 启动切换（不等待完成）
        settingsStore.values.wallpaperMode = mode as any;
        try {
            await invoke("set_wallpaper_mode", { mode });
        } catch (invokeError: any) {
            const fn = unlistenFn as (() => void) | null;
            if (fn) {
                fn();
                unlistenFn = null;
            }
            const errorMsg = invokeError?.message || invokeError?.toString() || "未知错误";
            ElMessage.error(`启动模式切换失败: ${errorMsg}`);
            settingsStore.values.wallpaperMode = prevMode as any;
            localValue.value = prevMode;
            return;
        }

        const result = await waitForSwitchComplete;
        if (result.success) {
            ElMessage.success("壁纸模式已切换");
            // 后端在切换时可能会按“模式缓存”恢复 style/transition，这里强制刷新以保持 UI 同步
            try {
                await settingsStore.loadAll();
            } catch { }
        } else {
            const errorMsg = result.error || "切换模式失败";
            ElMessage.error(`切换模式失败: ${errorMsg}`);
            // 回滚
            settingsStore.values.wallpaperMode = prevMode as any;
            localValue.value = prevMode;
        }
    } catch (e: any) {
        const msg = e?.message || String(e);
        ElMessage.error(`切换模式失败: ${msg}`);
        settingsStore.values.wallpaperMode = prevMode as any;
        localValue.value = prevMode;
        // eslint-disable-next-line no-console
        console.error("切换模式异常:", e);
    } finally {
        const fn = unlistenFn as (() => void) | null;
        if (fn) {
            try {
                fn();
            } catch { }
            unlistenFn = null;
        }
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