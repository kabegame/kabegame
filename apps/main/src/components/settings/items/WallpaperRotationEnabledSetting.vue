<template>
  <el-switch v-model="localValue" :disabled="disabled || loading" :loading="loading" @change="handleChange" />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@kabegame/core/stores/settings";

const props = defineProps<{
  disabled?: boolean;
}>();

const settingsStore = useSettingsStore();

const loading = ref(false);
const localValue = ref(false);

watch(
  () => settingsStore.values.wallpaperRotationEnabled,
  (v) => {
    localValue.value = !!v;
  },
  { immediate: true }
);

const waitForRotatorStatus = async (expected: "running" | "idle", maxRetries: number) => {
  let status = await invoke<string>("get_wallpaper_rotator_status");
  let retries = 0;
  while (status !== expected && retries < maxRetries) {
    await new Promise((r) => setTimeout(r, 100));
    status = await invoke<string>("get_wallpaper_rotator_status");
    retries++;
  }
  return status;
};

const handleChange = async (value: boolean) => {
  if (loading.value || props.disabled) return;
  loading.value = true;
  try {
    if (value) {
      // 1) 仅落盘开启（不启动线程）
      await invoke("set_wallpaper_rotation_enabled", { enabled: true });

      // 2) 由后端根据“上次画册ID -> 失败回落到画廊”逻辑启动轮播线程
      const res = await invoke<{
        started: boolean;
        source: "album" | "gallery";
        albumId?: string | null;
        fallback?: boolean;
        warning?: string | null;
      }>("start_wallpaper_rotation");

      if (!res?.started) throw new Error("轮播线程未能启动");

      // 3) 等待状态变为 running
      await waitForRotatorStatus("running", 20);

      // 设置变更会通过 setting-change 事件自动更新 UI
      if (res.fallback && res.warning) ElMessage.warning(res.warning);
      ElMessage.success(res.source === "album" ? "已开启轮播：画册" : "已开启轮播：画廊");
    } else {
      await invoke("set_wallpaper_rotation_enabled", { enabled: false });
      await waitForRotatorStatus("idle", 50);
      // 设置变更会通过 setting-change 事件自动更新 UI
      ElMessage.info("壁纸轮播已禁用");
    }
  } catch (e: any) {
    // 回滚 UI，并确保后端状态关闭
    localValue.value = false;
    settingsStore.values.wallpaperRotationEnabled = false as any;
    try {
      await invoke("set_wallpaper_rotation_enabled", { enabled: false });
    } catch { }

    const msg = e?.message || String(e);
    if (String(msg).includes("画廊内没有图片")) {
      ElMessage.warning("画廊没有图片，请先去收集图片，开启轮播失败");
    } else if (String(msg).includes("画册内没有图片")) {
      ElMessage.warning("画册为空，请先添加图片，开启轮播失败");
    } else {
      ElMessage.error(`操作失败：${msg}`);
    }
    // eslint-disable-next-line no-console
    console.error(e);
  } finally {
    loading.value = false;
  }
};
</script>
