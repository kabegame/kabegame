<template>
  <template v-for="node in nodes" :key="node.key ?? node.name">
    <el-dropdown-item
      v-if="!node.children?.length"
      :command="node.name"
      :class="{ 'is-active': dateTail === node.name }"
    >
      {{ node.label }}
      <span class="gallery-time-filter-count">({{ node.count }})</span>
    </el-dropdown-item>
    <el-dropdown-item v-else class="gallery-time-submenu-wrap" @click.stop>
      <el-dropdown
        trigger="hover"
        placement="right-start"
        @command="(cmd: string) => $emit('command', cmd)"
        @visible-change="onNodeMenuVisible($event, node)"
      >
        <span
          class="gallery-time-submenu-trigger"
          :class="{ 'is-active': isTimeMenuNodeActive(node, dateTail) }"
          @mouseenter="$emit('lazy-open', node)"
        >
          <span class="gallery-time-submenu-label">
            {{ node.label }}
            <span class="gallery-time-filter-count">({{ node.count }})</span>
          </span>
          <el-icon class="gallery-time-submenu-chevron">
            <ArrowRight />
          </el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu class="gallery-time-submenu-menu">
            <el-dropdown-item v-if="loadingNames.has(node.name)" disabled>
              {{ loadingText }}
            </el-dropdown-item>
            <GalleryTimeFilterSubmenuAsync
              :nodes="node.children"
              :date-tail="dateTail"
              :loading-names="loadingNames"
              :loading-text="loadingText"
              @command="$emit('command', $event)"
              @lazy-open="$emit('lazy-open', $event)"
            />
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </el-dropdown-item>
  </template>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from "vue";
import { ArrowRight } from "@element-plus/icons-vue";
import type { TimeMenuNode } from "@/utils/galleryTimeFilterMenu";
import { isTimeMenuNodeActive } from "@/utils/galleryTimeFilterMenu";

const GalleryTimeFilterSubmenuAsync = defineAsyncComponent(
  () => import("./GalleryTimeFilterSubmenu.vue")
);

withDefaults(defineProps<{
  nodes: TimeMenuNode[];
  dateTail: string | null;
  loadingNames?: ReadonlySet<string>;
  loadingText?: string;
}>(), {
  loadingNames: () => new Set<string>(),
  loadingText: "Loading",
});

const emit = defineEmits<{
  command: [name: string];
  "lazy-open": [node: TimeMenuNode];
}>();

function onNodeMenuVisible(open: boolean, node: TimeMenuNode) {
  if (open) emit("lazy-open", node);
}
</script>

<style scoped lang="scss">
.gallery-time-submenu-wrap {
  padding: 0 !important;
}

.gallery-time-submenu-label {
  flex: 1;
  min-width: 0;
}

.gallery-time-submenu-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 5px 16px;
  font-size: 14px;
  line-height: 22px;
  box-sizing: border-box;
  cursor: pointer;
  outline: none;
}

.gallery-time-submenu-chevron {
  margin-left: 12px;
  font-size: 12px;
}

.gallery-time-submenu-menu {
  max-height: min(60vh, 360px);
  overflow-y: auto;
}

.gallery-time-filter-count {
  margin-left: 4px;
  opacity: 0.75;
  font-size: 12px;
}
</style>
