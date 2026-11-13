<template>
  <Empty class="detail-panel-empty-state" :title="title" :description="description">
    <template #icon><FileText /></template>
  </Empty>
</template>

<script setup lang="ts">
import { FileText } from "@lucide/vue";
import { Empty } from "@/components/ui";

defineProps<{
  title: string;
  description: string;
}>();
</script>
