<template>
  <div class="rotation-target-setting">
    <el-button type="primary" @click="handleNavigate">
      <template v-if="rotationEnabled">
        {{ selectedAlbumName || "前往画册页面" }}
      </template>
      <template v-else>前往画廊选择壁纸</template>
    </el-button>

    <div class="hint">
      <template v-if="rotationEnabled">
        {{ selectedAlbumName ? `当前选择：${selectedAlbumName}` : "点击按钮前往画册页面选择用于轮播的画册" }}
      </template>
      <template v-else>
        <div>
          点击按钮前往画廊页面选择单张壁纸
          <template v-if="currentWallpaperName">
            <br />
            当前壁纸：{{ currentWallpaperName }}
            <el-button text size="small" class="path-button" @click="handleRevealCurrentWallpaper">
              <el-icon><FolderOpened /></el-icon>
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
import { useSettingsStore } from "@/stores/settings";

interface Album {
  id: string;
  name: string;
  createdAt: number;
}

const router = useRouter();
const settingsStore = useSettingsStore();

const albums = ref<Album[]>([]);
const currentWallpaperPath = ref<string | null>(null);

const rotationEnabled = computed(() => !!settingsStore.values.wallpaperRotationEnabled);

const selectedAlbumName = computed(() => {
  const id = settingsStore.values.wallpaperRotationAlbumId as any as string | null | undefined;
  // 约定：空字符串表示“全画廊轮播”
  if (id === "") return "全画廊";
  if (!id) return null;
  const a = albums.value.find((x) => x.id === id);
  return a ? a.name : null;
});

const currentWallpaperName = computed(() => {
  if (!currentWallpaperPath.value) return null;
  const p = currentWallpaperPath.value.replace(/\\/g, "/");
  return p.split("/").pop() || currentWallpaperPath.value;
});

const refreshAlbums = async () => {
  try {
    albums.value = await invoke<Album[]>("get_albums");
  } catch {
    albums.value = [];
  }
};

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
  await refreshAlbums();
  await refreshCurrentWallpaperPath();
});

watch(
  () => settingsStore.values.currentWallpaperImageId,
  async () => {
    await refreshCurrentWallpaperPath();
  }
);

const handleNavigate = () => {
  if (rotationEnabled.value) {
    const id = settingsStore.values.wallpaperRotationAlbumId as any as string | null | undefined;
    if (id === "") router.push("/gallery");
    else router.push("/albums");
  } else {
    router.push("/gallery");
  }
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


