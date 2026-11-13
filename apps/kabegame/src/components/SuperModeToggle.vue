<template>
  <Tooltip :content="tooltipText" side="right">
    <label
      class="fixed bottom-3 left-3 z-100 box-border flex h-8 cursor-pointer items-center gap-2 rounded-full bg-kb-surface-raised pl-2 pr-3 shadow-kb-pop"
      :class="app.isSuper ? 'ring-1 ring-kb-accent' : ''"
    >
      <Switch :model-value="app.isSuper" size="sm" @update:model-value="(v: boolean) => app.setSuper(v)" />
      <span class="text-[12px] font-600 tabular-nums" :class="app.isSuper ? 'text-kb-fg' : 'text-kb-fg-muted'">
        {{ app.isSuper ? "S" : "R" }}
      </span>
    </label>
  </Tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Switch, Tooltip } from "@/components/ui";
import { useApp } from "@/stores/app";

const app = useApp();

const tooltipText = computed(() => (app.isSuper ? "Super mode ON — 写操作已启用" : "Super mode OFF — 只读模式"));
</script>
