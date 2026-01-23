<template>
  <div class="rotation-target-setting">
    <template v-if="rotationEnabled">
      <div class="select-row">
        <el-select v-model="localAlbumId" class="album-select" :loading="albumStore.loading || showDisabled"
          :disabled="disabled || keyDisabled || wallpaperModeSwitching" placeholder="选择用于轮播的画册" style="min-width: 180px"
          @change="handleAlbumChange">
          <el-option value="">
            <div class="gallery-option">
              <div class="gallery-option__title">全画廊</div>
              <div class="gallery-option__desc">从画廊图片中轮播（从当前壁纸开始）</div>
            </div>
          </el-option>
          <el-option v-for="a in albumStore.albums" :key="a.id" :label="a.name" :value="a.id" />
        </el-select>
      </div>
    </template>

    <template v-else>
      <el-button type="primary" :disabled="disabled" @click="handleNavigatePickWallpaper">前往画廊选择壁纸</el-button>
    </template>

    <div class="hint">
      <template v-if="!rotationEnabled">
        <div>
          点击按钮前往画廊页面选择单张壁纸
          <template v-if="currentWallpaperName">
            <br />
            当前壁纸：{{ currentWallpaperName }}
            <el-button text size="small" class="path-button" @click="handleRevealCurrentWallpaper">
              <el-icon>
                <FolderOpened />
              </el-icon>
              定位
            </el-button>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { FolderOpened } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useAlbumStore } from "@/stores/albums";
import { useUiStore } from "@kabegame/core/stores/ui";

const props = defineProps<{
  disabled?: boolean;
}>();

const router = useRouter();
const settingsStore = useSettingsStore();
const albumStore = useAlbumStore();
const { wallpaperModeSwitching } = useUiStore();

const {
  settingValue,
  set,
  disabled: keyDisabled,
  showDisabled
} = useSettingKeyState("wallpaperRotationAlbumId");

const currentWallpaperPath = ref<string | null>(null);
const localAlbumId = ref<string>("");

const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const currentWallpaperName = computed(() => {
  if (!currentWallpaperPath.value) return null;
  const p = currentWallpaperPath.value.replace(/\\/g, "/");
  return p.split("/").pop() || currentWallpaperPath.value;
});

const refreshCurrentWallpaperPath = async () => {
  try {
    const id = settingsStore.values.currentWallpaperImageId as any as string | null | undefined;
    if (!id) {
      currentWallpaperPath.value = null;
      return;
    }
    currentWallpaperPath.value = await invoke<string | null>("get_image_local_path_by_id", { imageId: id });
  } catch {
    currentWallpaperPath.value = null;
  }
};

onMounted(async () => {
  await albumStore.loadAlbums();
  await refreshCurrentWallpaperPath();
});

watch(
  () => settingsStore.values.currentWallpaperImageId,
  async () => {
    await refreshCurrentWallpaperPath();
  }
);

// 同步 settings -> local（以及“画册被删/变更后”的矫正）
watch(
  () => [settingValue.value, albumStore.albums] as const,
  ([rawId]) => {
    const id = (rawId as any as string | null | undefined) ?? "";
    // 约定：空字符串表示“全画廊轮播”；null/undefined 也视为 ""
    if (id === "" || albumStore.albums.some((a) => a.id === id)) {
      localAlbumId.value = id;
      return;
    }

    // 选中的画册已不存在：自动回退到“全画廊”，并同步落盘
    localAlbumId.value = "";
    if (rotationEnabled.value) {
      // 使用 set 方法持久化
      set("", async () => {
        await settingsStore.loadAll();
      }).catch(() => {
        // 静默失败
      });
    }
  },
  { immediate: true }
);

const handleAlbumChange = async (value: string) => {
  if (props.disabled || keyDisabled.value) return;
  try {
    // value: "" 表示全画廊；非空表示指定画册
    await set(value, async () => {
      await settingsStore.loadAll();
    });
  } catch (e: any) {
    // 错误时 watcher 会自动回滚 localAlbumId (如果 store 值被 revert)
    ElMessage.error(`设置失败：${e?.message || String(e)}`);
  }
};

const handleNavigatePickWallpaper = () => {
  router.push("/gallery");
};

const handleRevealCurrentWallpaper = async () => {
  try {
    if (!currentWallpaperPath.value) return;
    await invoke("open_file_path", { filePath: currentWallpaperPath.value });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("定位当前壁纸失败:", e);
    ElMessage.error("定位失败");
  }
};
</script>

<style scoped lang="scss">
.rotation-target-setting {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.select-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.album-select {
  flex: 1;
}

.gallery-option {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.gallery-option__title {
  font-weight: 600;
}

.gallery-option__desc {
  font-size: 12px;
  color: var(--anime-text-muted);
  margin-top: 2px;
}

.hint {
  font-size: 12px;
  color: var(--anime-text-muted);
  line-height: 1.4;
}

.path-button {
  padding: 0;
  margin-left: 6px;
}
</style>
