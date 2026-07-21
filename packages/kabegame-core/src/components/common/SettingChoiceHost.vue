<template>
  <SettingChoiceDialog
    :model-value="request !== null"
    :title="request?.title"
    :options="request?.options ?? []"
    @update:model-value="handleVisibleChange"
    @select="resolveSettingChoice"
  />
</template>

<script setup lang="ts">
import SettingChoiceDialog from "./SettingChoiceDialog.vue";
import {
  resolveSettingChoice,
  settingChoiceRequest as request,
} from "../../composables/useSettingChoice";

function handleVisibleChange(visible: boolean) {
  if (!visible) resolveSettingChoice(null);
}
</script>
