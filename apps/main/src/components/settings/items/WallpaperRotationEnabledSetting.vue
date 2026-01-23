<template>
  <el-switch v-model="localValue" :disabled="props.disabled || disabled" :loading="showDisabled" @change="handleChange" />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";

const props = defineProps<{
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wallpaperRotationEnabled");
const localValue = ref(false);

watch(
  () => settingValue.value,
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
  // 特殊逻辑：启动/停止轮播线程
  const onAfterSave = async () => {
    try {
      if (value) {
        // 启动轮播线程
        const res = await invoke<{
          started: boolean;
          source: "album" | "gallery";
          albumId?: string | null;
          fallback?: boolean;
          warning?: string | null;
        }>("start_wallpaper_rotation");

        if (!res?.started) throw new Error("轮播线程未能启动");

        // 等待状态变为 running
        await waitForRotatorStatus("running", 20);

        if (res.fallback && res.warning) ElMessage.warning(res.warning);
        ElMessage.success(res.source === "album" ? "已开启轮播：画册" : "已开启轮播：画廊");
      } else {
        // 停止轮播线程
        await waitForRotatorStatus("idle", 50);
        ElMessage.info("壁纸轮播已禁用");
      }
    } catch (e: any) {
      // 如果启动失败，抛出错误让 set 函数处理回滚
      const msg = e?.message || String(e);
      if (String(msg).includes("画廊内没有图片")) {
        ElMessage.warning("画廊没有图片，请先去收集图片，开启轮播失败");
      } else if (String(msg).includes("画册内没有图片")) {
        ElMessage.warning("画册为空，请先添加图片，开启轮播失败");
      } else {
        ElMessage.error(`操作失败：${msg}`);
      }
      throw e; // 重新抛出错误，让 set 函数处理回滚
    }
  };

  await set(value, onAfterSave);
};
</script>