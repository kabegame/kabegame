<template>
    <el-radio-group v-model="localValue" :disabled="switching" @change="handleChange"
        class="wallpaper-mode-radio-group">
        <el-radio label="native">原生模式</el-radio>
        <el-radio label="window">窗口模式（类似 Wallpaper Engine）</el-radio>
    </el-radio-group>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/stores/settings";
import { useSettingsUiStore } from "@/stores/settingsUi";

const settingsStore = useSettingsStore();
const uiStore = useSettingsUiStore();

const switching = computed(() => uiStore.wallpaperModeSwitching === true);
const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const localValue = ref<string>("native");
watch(
    () => settingsStore.values.wallpaperMode,
    (v) => {
        localValue.value = (v as any as string) || "native";
    },
    { immediate: true }
);

const normalizeStyleForNative = async () => {
    try {
        const supported = await invoke<string[]>("get_native_wallpaper_styles");
        const cur = (settingsStore.values.wallpaperRotationStyle as any as string) || "fill";
        if (supported.length > 0 && !supported.includes(cur)) {
            const newStyle = supported.includes("fill") ? "fill" : supported[0];
            settingsStore.values.wallpaperRotationStyle = newStyle as any;
            try {
                await invoke("set_wallpaper_style", { style: newStyle });
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn("自动切换样式失败:", e);
            }
        }
    } catch {
        // ignore
    }
};

const normalizeTransitionForNative = async () => {
    const unsupported = ["slide", "zoom"];
    const cur = (settingsStore.values.wallpaperRotationTransition as any as string) || "none";

    if (!unsupported.includes(cur)) return;

    settingsStore.values.wallpaperRotationTransition = "none" as any;

    // 只有轮播启用时才需要同步/保存 transition（否则后端会拒绝）
    if (rotationEnabled.value) {
        try {
            await invoke("set_wallpaper_rotation_transition", { transition: "none" });
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("自动切换过渡效果失败:", e);
        }
    }
};

const handleChange = async (mode: string) => {
    if (switching.value) return;

    const prevMode = (settingsStore.values.wallpaperMode as any as string) || "native";
    uiStore.wallpaperModeSwitching = true as any;

    let unlistenFn: (() => void) | null = null;
    try {
        // 预处理：切换到原生模式时，修正样式/过渡为系统支持的值（保持旧 Settings.vue 行为一致）
        if (mode === "native") {
            await normalizeStyleForNative();
            await normalizeTransitionForNative();
        }

        const waitForSwitchComplete = new Promise<{ success: boolean; error?: string }>(async (resolve, reject) => {
            const timeoutId = setTimeout(() => {
                if (unlistenFn) {
                    unlistenFn();
                    unlistenFn = null;
                }
                reject(new Error("切换模式超时：后端未在 30 秒内响应"));
            }, 30000);

            try {
                unlistenFn = await listen<{ success: boolean; mode: string; error?: string }>(
                    "wallpaper-mode-switch-complete",
                    (event) => {
                        if (event.payload.mode === mode) {
                            clearTimeout(timeoutId);
                            if (unlistenFn) {
                                unlistenFn();
                                unlistenFn = null;
                            }
                            resolve({ success: event.payload.success, error: event.payload.error });
                        }
                    }
                );
            } catch (listenError) {
                clearTimeout(timeoutId);
                reject(new Error(`监听切换完成事件失败: ${listenError}`));
            }
        });

        // 启动切换（不等待完成）
        settingsStore.values.wallpaperMode = mode as any;
        try {
            await invoke("set_wallpaper_mode", { mode });
        } catch (invokeError: any) {
            if (unlistenFn) {
                unlistenFn();
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
        if (unlistenFn) {
            try {
                unlistenFn();
            } catch { }
        }
        uiStore.wallpaperModeSwitching = false as any;
    }
};
</script>

<style scoped lang="scss">
.wallpaper-mode-radio-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
}
</style>
