<template>
  <el-drawer v-model="drawer.isOpen" :title="drawer.title" :size="drawerSize" append-to-body class="help-drawer drawer-max-width">
    <div v-if="filteredGroups.length === 0" class="empty">
      <el-empty description="此页面暂无帮助内容" :image-size="100" />
    </div>

    <div v-else class="list">
      <el-alert class="tip" type="info" show-icon :closable="false">
        说明：部分快捷键仅在图片网格获得焦点时生效（先在网格空白处/图片上点一下）。
      </el-alert>

      <div v-for="g in filteredGroups" :key="g.id" class="group">
        <div class="group-header">
          <div class="group-title">{{ g.title }}</div>
          <div v-if="g.description" class="group-desc">{{ g.description }}</div>
        </div>

        <div class="group-items">
          <div v-for="it in g.items" :key="it.id" class="item">
            <SettingRow :label="it.label" :description="it.description">
              <div v-if="it.kind === 'shortcut'" class="shortcut-keys">
                <span v-for="(k, idx) in it.keys" :key="idx" class="kbd">{{ k }}</span>
              </div>
            </SettingRow>
          </div>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, watch, ref } from "vue";
import SettingRow from "@kabegame/core/components/settings/SettingRow.vue";
import { useHelpDrawerStore } from "@/stores/helpDrawer";
import { HELP_GROUPS } from "@/help/helpRegistry";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalStackStore } from "@kabegame/core/stores/modalStack";

const drawer = useHelpDrawerStore();
const modalStack = useModalStackStore();
const modalStackId = ref<string | null>(null);

watch(
  () => drawer.isOpen,
  (visible) => {
    if (visible && IS_ANDROID) {
      modalStackId.value = modalStack.push(() => drawer.close());
    } else if (!visible && modalStackId.value) {
      modalStack.remove(modalStackId.value);
      modalStackId.value = null;
    }
  }
);

const drawerSize = computed(() => IS_ANDROID ? "70%" : "420px");

const filteredGroups = computed(() => {
  const pid = drawer.pageId;
  return HELP_GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((x) => x.pages.includes(pid)),
    }))
    .filter((g) => g.items.length > 0);
});
</script>

<style scoped lang="scss">
.list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.tip {
  margin-bottom: 6px;
}

.group {
  padding: 10px 0;
  border-bottom: 1px solid var(--anime-border);
}

.group-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}

.group-title {
  font-weight: 700;
  font-size: 14px;
  color: var(--anime-text-primary);
}

.group-desc {
  font-size: 12px;
  color: var(--anime-text-muted);
}

.group-items {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.item {
  padding: 2px 0;
}

.empty {
  padding: 12px 0;
}

.shortcut-keys {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--anime-border);
  background: rgba(255, 255, 255, 0.5);
  color: var(--anime-text-primary);
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  user-select: none;
}
</style>

<style lang="scss">
</style>
