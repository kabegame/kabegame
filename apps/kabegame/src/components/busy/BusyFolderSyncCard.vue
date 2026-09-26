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
    <div class="mt-2 h-1 overflow-hidden rounded-full bg-[rgba(167,139,250,0.18)]">
      <div
        class="h-full rounded-full bg-[var(--anime-primary)] transition-[width] duration-200"
        :style="{ width: `${Math.min(100, Math.max(0, task.progress))}%` }"
      />
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Close, Refresh } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import { useRouter } from "vue-router";
import { useFolderSyncStore } from "@/stores/folderSync";
import { useAlbumStore } from "@/stores/albums";
import { useAlbumIdPathState } from "@/composables/useAlbumIdPathState";
import * as folderSyncService from "@/services/folderSync";

const props = defineProps<{ albumId: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const router = useRouter();
const store = useFolderSyncStore();
const albumStore = useAlbumStore();
const albumPath = useAlbumIdPathState();

const task = computed(() => store.tasks.get(props.albumId) ?? null);
const detail = computed(() => {
  const current = task.value;
  if (!current) return "";
  const parts = [`${Math.round(current.progress)}%`, t("albums.syncScanning", { added: current.added })];
  if (current.deleted > 0) {
    parts.push(t("albums.syncDetailDeleted", { deleted: current.deleted }));
  }
  if (current.reimported > 0) {
    parts.push(t("albums.syncDetailReimported", { reimported: current.reimported }));
  }
  return parts.join(" · ");
});

async function viewAlbum() {
  const album = albumStore.albums.find((item) => item.id === props.albumId);
  if (album) await albumPath.set(album.ancestorPath);
  await router.push({ name: "Albums" });
  emit("close");
}
</script>
