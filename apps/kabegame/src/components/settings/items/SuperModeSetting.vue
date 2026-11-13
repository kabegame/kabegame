<template>
  <Switch :model-value="app.isSuper" @update:model-value="(v) => app.setSuper(v)" />
</template>

<script setup lang="ts">
import Switch from "@/components/ui/Switch.vue";
import { useApp } from "@/stores/app";

const app = useApp();
</script>
