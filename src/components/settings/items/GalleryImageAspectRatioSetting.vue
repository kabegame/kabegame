<template>
  <div class="aspect-ratio-setting">
    <el-select v-model="localValue" placeholder="选择宽高比" style="width: 180px" clearable :disabled="saving"
      @change="onChange">
      <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" />
    </el-select>
    <div class="hint">
      选择画廊图片的宽高比。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings";

const settingsStore = useSettingsStore();
const saving = computed(() => settingsStore.savingByKey.galleryImageAspectRatio === true);

const desktopResolution = ref<{ width: number; height: number } | null>(null);

const commonAspectRatios = [
  { label: "16:9", value: "16:9", ratio: 16 / 9 },
  { label: "16:10", value: "16:10", ratio: 16 / 10 },
  { label: "21:9", value: "21:9", ratio: 21 / 9 },
  { label: "4:3", value: "4:3", ratio: 4 / 3 },
  { label: "5:4", value: "5:4", ratio: 5 / 4 },
  { label: "3:2", value: "3:2", ratio: 3 / 2 },
  { label: "32:9", value: "32:9", ratio: 32 / 9 },
];

const options = computed(() => {
  if (!desktopResolution.value) {
    return commonAspectRatios.map((ar) => ({ label: ar.label, value: ar.value }));
  }

  const desktopRatio = desktopResolution.value.width / desktopResolution.value.height;
  const matched = commonAspectRatios.find((ar) => Math.abs(ar.ratio - desktopRatio) < 0.01);

  const opts = commonAspectRatios.map((ar) => {
    const isDesktopMatch = Math.abs(ar.ratio - desktopRatio) < 0.01;
    return {
      label: isDesktopMatch ? `${ar.label} (您的桌面)` : ar.label,
      value: ar.value,
    };
  });

  if (!matched) {
    const customValue = `custom:${desktopResolution.value.width}:${desktopResolution.value.height}`;
    opts.push({
      label: `自定义 ${desktopResolution.value.width}:${desktopResolution.value.height} (您的桌面)`,
      value: customValue,
    });
  }

  return opts;
});

const localValue = ref<string | null>(null);
watch(
  () => settingsStore.values.galleryImageAspectRatio,
  (v) => {
    localValue.value = (v as any as string | null) || null;
  },
  { immediate: true }
);

const save = async (value: string | null) => {
  const prev = settingsStore.values.galleryImageAspectRatio as any;
  settingsStore.values.galleryImageAspectRatio = value as any;
  settingsStore.savingByKey.galleryImageAspectRatio = true;
  try {
    await invoke("set_gallery_image_aspect_ratio", { aspectRatio: value });
  } catch (e) {
    settingsStore.values.galleryImageAspectRatio = prev;
    localValue.value = (prev as any as string | null) || null;
    ElMessage.error("保存设置失败");
    // eslint-disable-next-line no-console
    console.error("保存宽高比失败:", e);
  } finally {
    settingsStore.savingByKey.galleryImageAspectRatio = false;
  }
};

const onChange = async (v: any) => {
  await save(v == null ? null : String(v));
};

onMounted(async () => {
  try {
    const [width, height] = await invoke<[number, number]>("get_desktop_resolution");
    desktopResolution.value = { width, height };
  } catch (e) {
    desktopResolution.value = null;
  }

  // 若未设置，则自动匹配桌面宽高比（保持与旧 Settings.vue 行为一致）
  if (!settingsStore.values.galleryImageAspectRatio && desktopResolution.value) {
    const ratio = desktopResolution.value.width / desktopResolution.value.height;
    const matched = commonAspectRatios.find((ar) => Math.abs(ar.ratio - ratio) < 0.01);
    const autoValue = matched
      ? matched.value
      : `custom:${desktopResolution.value.width}:${desktopResolution.value.height}`;
    await save(autoValue);
  }
});
</script>

<style scoped lang="scss">
.aspect-ratio-setting {
  width: 100%;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--anime-text-muted);
}
</style>
