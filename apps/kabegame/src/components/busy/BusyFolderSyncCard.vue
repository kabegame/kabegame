<template>
  <BusyTaskCard
    v-if="task"
    :icon="FolderSync"
    :title="t('albums.syncCardTitle')"
    :subtitle="`${task.albumName} · ${detail}`"
    :progress="Math.min(100, Math.max(0, task.progress))"
    cancellable
    @cancel="folderSyncService.cancel(props.albumId)"
  >
    <template #actions>
      <Button variant="ghost" size="sm" class="-my-1" @click="viewAlbum">{{ t("header.busyView") }}</Button>
    </template>
  </BusyTaskCard>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { FolderSync } from "@lucide/vue";
import { Button } from "@/components/ui";
import BusyTaskCard from "./BusyTaskCard.vue";
import { useI18n } from "@kabegame/i18n";
import { useRouter } from "vue-router";
import { useFolderSyncStore } from "@/stores/folderSync";
import { fetchAlbum } from "@/services/albums";
import { useAlbumIdPathState } from "@/composables/useAlbumIdPathState";
import * as folderSyncService from "@/services/folderSync";

const props = defineProps<{ albumId: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const router = useRouter();
const store = useFolderSyncStore();
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
  const album = await fetchAlbum(props.albumId);
  if (album) await albumPath.set(album.ancestorPath);
  await router.push({ name: "Albums" });
  emit("close");
}
</script>
