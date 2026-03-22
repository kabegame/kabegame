<template>
  <div class="organize-header-control">
    <!-- 空闲：显示整理按钮 -->
    <el-button v-if="!loading" circle :title="t('header.organize')" @click="showDialog = true">
      <el-icon>
        <FolderOpened />
      </el-icon>
    </el-button>
    <!-- 进行中：进度 + 取消 -->
    <div v-else class="organize-progress-row">
      <span class="progress-text">
        {{ progress.total > 0 ? t('gallery.organizingProgress', { processed: progress.processed, total: progress.total }) : t('gallery.organizingEllipsis') }}
        <span v-if="progress.removed > 0 || progress.regenerated > 0" class="progress-detail">
          {{ t('gallery.organizingDetail', { removed: progress.removed, regenerated: progress.regenerated }) }}
        </span>
      </span>
      <el-button type="danger" link size="small" @click="handleCancel">
        {{ t('common.cancel') }}
      </el-button>
    </div>

    <Teleport to="body">
      <OrganizeDialog v-model="showDialog" :loading="loading" @confirm="handleConfirm" />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import { FolderOpened } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import OrganizeDialog from "@/components/OrganizeDialog.vue";

const { t } = useI18n();
const loading = ref(false);
const showDialog = ref(false);
const progress = ref({ processed: 0, total: 0, removed: 0, regenerated: 0 });

let unlistenProgress: (() => void) | undefined;
let unlistenFinished: (() => void) | undefined;

onMounted(async () => {
  unlistenProgress = await listen<{
    processed: number;
    total: number;
    removed: number;
    regenerated: number;
  }>("organize-progress", (event) => {
    const p = event.payload;
    if (!p) return;
    progress.value = {
      processed: p.processed,
      total: p.total,
      removed: p.removed,
      regenerated: p.regenerated,
    };
  });

  unlistenFinished = await listen<{
    removed: number;
    regenerated: number;
    canceled: boolean;
  }>("organize-finished", (event) => {
    const p = event.payload;
    loading.value = false;
    if (p?.canceled) {
      ElMessage.info(t("gallery.organizeCanceled"));
      return;
    }
    ElMessage.success(t("gallery.organizeDone", { removed: p?.removed ?? 0, regenerated: p?.regenerated ?? 0 }));
  });
});

onUnmounted(() => {
  unlistenProgress?.();
  unlistenFinished?.();
});

async function handleConfirm(options: { dedupe: boolean; removeMissing: boolean; regenThumbnails: boolean }) {
  showDialog.value = false;
  if (loading.value) return;
  try {
    loading.value = true;
    progress.value = { processed: 0, total: 0, removed: 0, regenerated: 0 };
    await invoke("start_organize", {
      dedupe: options.dedupe,
      removeMissing: options.removeMissing,
      regenThumbnails: options.regenThumbnails,
    });
  } catch (e) {
    console.error("启动整理失败:", e);
    ElMessage.error(t("gallery.startOrganizeFailed"));
    loading.value = false;
  }
}

async function handleCancel() {
  if (!loading.value) return;
  try {
    const ok = await invoke<boolean>("cancel_organize");
    if (ok) ElMessage.info(t("gallery.cancelOrganizeRequested"));
  } catch (e) {
    console.error("取消整理失败:", e);
    ElMessage.error(t("gallery.cancelOrganizeFailed"));
  }
}
</script>

<style scoped lang="scss">
.organize-header-control {
  display: inline-flex;
  align-items: center;
}

.organize-progress-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-regular);

  .progress-text {
    white-space: nowrap;
  }

  .progress-detail {
    color: var(--el-text-color-secondary);
    font-size: 11px;
  }
}

.el-button {
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}
</style>
