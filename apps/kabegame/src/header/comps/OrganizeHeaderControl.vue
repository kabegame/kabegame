<template>
  <div class="organize-header-control flex w-full items-center">
    <el-button
      class="w-full"
      :disabled="organizeStore.running"
      :title="organizeStore.running ? t('header.organizeInProgress') : t('header.organize')"
      @click="handleClick"
    >
      <el-icon><FolderOpened /></el-icon>
      <span>{{ t("header.organize") }}</span>
      <span
        v-if="organizeStore.running"
        class="ml-auto text-xs text-[var(--anime-text-muted)]"
      >
        {{ t("header.organizeInProgress") }}
      </span>
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { FolderOpened } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
import { useOrganizeStore } from "@/stores/organize";

const { t } = useI18n();
const organizeStore = useOrganizeStore();

function handleClick() {
  if (!organizeStore.running) organizeStore.openDialog();
}
</script>
