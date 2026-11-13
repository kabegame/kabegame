<template>
  <ToolRow
    :label="t('header.organize')"
    :hint="organizeStore.running ? t('header.organizeInProgress') : undefined"
    :disabled="organizeStore.running"
    @click="handleClick"
  >
    <template #icon><FolderCog /></template>
  </ToolRow>
</template>

<script setup lang="ts">
import { FolderCog } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useOrganizeStore } from "@/stores/organize";
import ToolRow from "./ToolRow.vue";

const emit = defineEmits<{ done: [] }>();
const { t } = useI18n();
const organizeStore = useOrganizeStore();

function handleClick() {
  if (organizeStore.running) return;
  organizeStore.openDialog();
  emit("done");
}
</script>
