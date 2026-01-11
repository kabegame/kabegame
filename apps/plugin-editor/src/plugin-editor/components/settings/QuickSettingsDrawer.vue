<template>
    <CoreQuickSettingsDrawer :drawer="drawer" :groups="QUICK_SETTINGS_GROUPS" />
</template>

<script setup lang="ts">
import CoreQuickSettingsDrawer from "@kabegame/core/components/settings/QuickSettingsDrawer.vue";
import { useQuickSettingsDrawerStore } from "../../stores/quick-settings-drawer";
import { QUICK_SETTINGS_GROUPS } from "../../settings/quick-settings-registry";

const drawer = useQuickSettingsDrawerStore();
</script>
