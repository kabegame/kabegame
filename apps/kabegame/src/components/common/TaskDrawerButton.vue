<template>
  <Tooltip :content="t('header.tasks')">
    <Button
      variant="ghost"
      size="icon"
      :aria-label="activeTasksCount > 0 ? `${t('header.tasks')} (${activeTasksCount})` : t('header.tasks')"
      @click="handleClick"
    >
      <ListChecks />
      <CountBadge :count="activeTasksCount" />
    </Button>
  </Tooltip>
</template>

<script setup lang="ts">
import { ListChecks } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { storeToRefs } from "pinia";
import { Button, CountBadge, Tooltip } from "@/components/ui";
import { useTaskDrawerStore } from "@/stores/taskDrawer";

const { t } = useI18n();
const taskDrawerStore = useTaskDrawerStore();
const { activeTasksCount } = storeToRefs(taskDrawerStore);

const handleClick = () => {
  taskDrawerStore.toggle();
};
</script>
