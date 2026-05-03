<template>
  <el-switch :model-value="app.isSuper" @update:model-value="(v) => app.setSuper(!!v)" />
</template>

<script setup lang="ts">
import { useApp } from "@/stores/app";

const app = useApp();
</script>
