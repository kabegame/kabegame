<template>
  <el-popover
    :visible="modal.isOpen.value"
    trigger="manual"
    :placement="variant === 'sidebar' ? 'top-start' : 'top'"
    :offset="6"
    :width="variant === 'sidebar' ? 260 : 280"
    popper-class="global-tools-popover-popper"
    @update:visible="(v: boolean) => (v ? modal.open() : modal.close())"
  >
    <template #reference>
      <div
        v-if="variant === 'sidebar'"
        class="global-tools-trigger global-tools-trigger--sidebar"
        :class="{ 'is-active': modal.isOpen.value, 'is-collapsed': collapsed }"
        @click="modal.toggle()"
      >
        <el-icon class="trigger-icon"><Tools /></el-icon>
        <span v-if="!collapsed" class="trigger-label">{{ t("header.toolbox") }}</span>
      </div>
      <div
        v-else
        class="global-tools-trigger global-tools-trigger--compact"
        :class="{ 'is-active': modal.isOpen.value }"
        @click="modal.toggle()"
      >
        <el-icon class="trigger-icon"><Tools /></el-icon>
        <span class="trigger-label">{{ t("header.toolbox") }}</span>
      </div>
    </template>

    <div class="global-tools-content">
      <template v-if="variant === 'compact'">
        <!-- 任务入口不进工具箱：各页 header 已常驻 TaskDrawerButton -->
        <div class="tool-group-title">{{ t("header.toolboxApp") }}</div>
        <div class="tool-row" @click="handleOpenSettings">
          <el-icon class="row-icon"><Setting /></el-icon>
          <span class="row-label">{{ t("route.settings") }}</span>
        </div>
        <div v-if="groups.length > 0" class="tool-divider" />
      </template>

      <template v-for="(group, gi) in groups" :key="group.id">
        <div class="tool-group-title">{{ group.title }}</div>
        <template v-for="item in group.items" :key="item.id">
          <div v-if="item.comp" class="tool-row-comp">
            <component :is="item.comp" />
          </div>
          <div v-else class="tool-row" @click="handleItemClick(item)">
            <el-icon class="row-icon"><component :is="item.icon" /></el-icon>
            <span class="row-label">{{ item.label }}</span>
            <span v-if="item.shortcut" class="row-shortcut">{{ item.shortcut }}</span>
            <el-switch
              v-if="item.kind === 'toggle'"
              :model-value="item.toggleGet?.()"
              class="row-switch"
              @click.stop
              @change="(v: string | number | boolean) => item.toggleSet?.(!!v)"
            />
          </div>
        </template>
        <div v-if="gi < groups.length - 1" class="tool-divider" />
      </template>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { Tools, Setting } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
import { useModal } from "@kabegame/core/composables/useModal";
import { useGlobalTools, type GlobalToolItem } from "@/header/globalToolsRegistry";

withDefaults(defineProps<{ variant: "sidebar" | "compact"; collapsed?: boolean }>(), {
  collapsed: false,
});
const emit = defineEmits<{ "open-settings": [] }>();

const { t } = useI18n();
const modal = useModal();
const { groups } = useGlobalTools();

const handleOpenSettings = () => {
  emit("open-settings");
  modal.close();
};
const handleItemClick = (item: GlobalToolItem) => {
  if (item.kind === "toggle") return;
  item.action?.();
  modal.close();
};

defineExpose({ close: () => modal.close() });
</script>

<style scoped lang="scss">
.global-tools-trigger {
  cursor: pointer;
  color: var(--anime-text-secondary);
  transition: all 0.2s ease;

  &--sidebar {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 12px;
    border-radius: 11px;
    color: var(--anime-text-primary);

    &:hover,
    &.is-active {
      background: rgba(255, 107, 157, 0.1);
      border: 1px solid rgba(255, 107, 157, 0.3);
    }

    &.is-collapsed {
      justify-content: center;
      padding: 0;
    }

    .trigger-icon {
      font-size: 17px;
    }

    .trigger-label {
      font-size: 13px;
      font-weight: 600;
    }
  }

  &--compact {
    height: 100%;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 9px 2px;

    &.is-active {
      color: var(--anime-primary);
    }

    .trigger-icon {
      font-size: 22px;
    }

    .trigger-label {
      font-size: 11px;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
  }

  .trigger-icon {
    flex-shrink: 0;
  }
}

.global-tools-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 60vh;
  overflow-y: auto;
}

.tool-group-title {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--anime-text-muted);
  padding: 8px 12px 6px;
  font-family: ui-monospace, Menlo, monospace;

  &:first-child {
    padding-top: 4px;
  }
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 11px;
  height: 42px;
  padding: 0 12px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--anime-text-primary);
  transition: background 0.15s ease;

  &:hover {
    background: rgba(255, 107, 157, 0.08);
  }

  .row-icon {
    font-size: 17px;
    color: var(--anime-secondary);
    flex-shrink: 0;
  }

  .row-label {
    font-size: 14px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-shortcut {
    margin-left: auto;
    font-size: 12px;
    color: var(--anime-text-muted);
    font-family: ui-monospace, Menlo, monospace;
  }

  .row-switch {
    margin-left: auto;
    flex-shrink: 0;
  }
}

.tool-row-comp {
  display: flex;
  align-items: center;

  :deep(.el-button) {
    width: 100%;
    justify-content: flex-start;
    gap: 11px;
    height: 42px;
    padding: 0 12px;
    border: none;
    background: transparent;
    box-shadow: none;
    color: var(--anime-text-primary);
    font-size: 14px;
    font-weight: 400;

    &:hover {
      background: rgba(255, 107, 157, 0.08);
      transform: none;
      box-shadow: none;
    }

    .el-icon {
      font-size: 17px;
      color: var(--anime-secondary);
      margin: 0 !important;
    }
  }
}

.tool-divider {
  height: 1px;
  background: var(--anime-border);
  margin: 7px 12px;
}
</style>
