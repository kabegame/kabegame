<template>
  <article v-if="task" class="busy-task-card border-[rgba(167,139,250,0.26)] bg-[rgba(167,139,250,0.08)]">
    <div class="flex items-center gap-2">
      <el-icon class="shrink-0 text-[15px] text-[var(--anime-text-secondary)]"><Refresh /></el-icon>
      <div class="min-w-0 flex-1 flex flex-col gap-0.5">
        <span class="truncate text-[13px] font-700 text-[var(--anime-text-primary)]">
          {{ t("albums.syncCardTitle") }}
        </span>
        <span class="truncate text-xs text-[#8b6b8f]">
          {{ task.albumName }} · {{ detail }}
        </span>
      </div>
      <button
        type="button"
        class="shrink-0 appearance-none border-0 bg-transparent p-0 cursor-pointer text-xs font-600 text-[var(--anime-text-secondary)] hover:text-[var(--anime-primary)]"
        @click="viewAlbum"
      >
        {{ t("header.busyView") }}
      </button>
      <button
        type="button"
        class="busy-task-cancel"
        :title="t('common.cancel')"
        @click.stop="folderSyncService.cancel(props.albumId)"
      >
        <el-icon class="text-[13px]"><Close /></el-icon>
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Close, Refresh } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
import { useRouter } from "vue-router";
import { useFolderSyncStore } from "@/stores/folderSync";
import * as folderSyncService from "@/services/folderSync";

const props = defineProps<{ albumId: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const router = useRouter();
const store = useFolderSyncStore();

const task = computed(() => store.tasks.get(props.albumId) ?? null);
const detail = computed(() => {
  const current = task.value;
  if (!current) return "";
  const parts = [t("albums.syncScanning", { added: current.added })];
  if (current.deleted > 0) {
    parts.push(t("albums.syncDetailDeleted", { deleted: current.deleted }));
  }
  if (current.reimported > 0) {
    parts.push(t("albums.syncDetailReimported", { reimported: current.reimported }));
  }
  return parts.join(" · ");
});

async function viewAlbum() {
  await router.push({ name: "AlbumDetail", params: { albumId: props.albumId } });
  emit("close");
}
</script>
