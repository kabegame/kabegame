<template>
  <Tooltip :content="label">
    <Button variant="ghost" size="icon" :aria-label="label" @click="handleClick">
      <component :is="icon" />
    </Button>
  </Tooltip>
</template>

<script setup lang="ts">
import type { Component } from "vue";
import { Button, Tooltip } from "@/components/ui";

defineProps<{
  icon: Component;
  label: string;
  type?: string;
}>();

const emit = defineEmits<{
  action: [data: { type: string; [key: string]: any }];
}>();

const handleClick = () => {
  emit("action", { type: "click" });
};
</script>
