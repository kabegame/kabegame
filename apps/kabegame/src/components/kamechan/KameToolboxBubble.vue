<template>
  <Transition name="kame-bubble">
    <div
      v-if="visible"
      class="kame-toolbox-bubble"
      :class="[`is-side-${side}`, { 'is-compact': compact }]"
      :style="bubbleStyle"
      @pointerdown.stop
      @click.stop
      @contextmenu.stop
    >
      <div class="kame-toolbox-bubble__header">
        <span class="kame-toolbox-bubble__title">{{ t("kamechan.toolboxTitle") }}</span>
        <button type="button" class="kame-toolbox-bubble__settings" @click="emit('open-settings')">
          <el-icon><Setting /></el-icon>
          <span>{{ t("route.settings") }}</span>
          <span class="kame-toolbox-bubble__shortcut">{{ shortcutLabel("openSettings") }}</span>
        </button>
      </div>
      <div class="kame-toolbox-bubble__divider" />

      <div class="kame-toolbox-bubble__body">
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
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { Setting } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
import { useGlobalTools, type GlobalToolItem } from "@/header/globalToolsRegistry";
import { shortcutLabel } from "@/composables/useGlobalShortcuts";

const props = withDefaults(defineProps<{
  visible: boolean;
  side?: "left" | "right";
  maxWidth?: string;
  compact?: boolean;
}>(), {
  side: "right",
  maxWidth: "320px",
  compact: false,
});

const emit = defineEmits<{
  "open-settings": [];
  close: [];
}>();

const { t } = useI18n();
const { groups } = useGlobalTools();

// 工具箱内容比消息气泡宽，最小宽度单独兜底，避免贴边时被压扁到不可读
const bubbleStyle = computed(() => ({
  "--kame-bubble-max-width": props.maxWidth,
}));

const handleItemClick = (item: GlobalToolItem) => {
  if (item.kind === "toggle") return;
  item.action?.();
  emit("close");
};
</script>

<style scoped lang="scss">
.kame-toolbox-bubble {
  --kame-bubble-overlap: 18px;
  --kame-bubble-max-width: 320px;

  position: absolute;
  bottom: 174px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: max-content;
  min-width: 260px;
  max-width: min(344px, max(260px, var(--kame-bubble-max-width)));
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.8);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.96);
  color: var(--anime-text-primary);
  box-shadow: 0 14px 34px rgba(24, 24, 40, 0.2);
  backdrop-filter: blur(10px);
  // 与消息气泡不同：工具箱要可点、可滚
  pointer-events: auto;

  &::before {
    content: "";
    position: absolute;
    bottom: 26px;
    width: 14px;
    height: 14px;
    background: rgba(255, 255, 255, 0.96);
    transform: rotate(45deg);
  }
}

.kame-toolbox-bubble.is-compact {
  bottom: 4px;
}

.kame-toolbox-bubble.is-side-right {
  left: calc(100% - var(--kame-bubble-overlap));

  &::before {
    left: -8px;
    border-left: 1px solid rgba(255, 255, 255, 0.8);
    border-bottom: 1px solid rgba(255, 255, 255, 0.8);
  }
}

.kame-toolbox-bubble.is-side-left {
  right: calc(100% - var(--kame-bubble-overlap));

  &::before {
    right: -8px;
    border-top: 1px solid rgba(255, 255, 255, 0.8);
    border-right: 1px solid rgba(255, 255, 255, 0.8);
  }
}

.kame-toolbox-bubble__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px 10px 12px;
}

.kame-toolbox-bubble__title {
  font-size: 16px;
  font-weight: 700;
  color: var(--anime-text-primary);
}

.kame-toolbox-bubble__settings {
  appearance: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid rgba(255, 107, 157, 0.32);
  background: rgba(255, 255, 255, 0.9);
  color: var(--anime-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;

  &:hover {
    background: rgba(255, 107, 157, 0.08);
  }
}

.kame-toolbox-bubble__shortcut {
  font-size: 11px;
  font-weight: 400;
  color: var(--anime-text-muted);
  font-family: ui-monospace, Menlo, monospace;
}

.kame-toolbox-bubble__divider {
  height: 1px;
  background: var(--anime-border);
  margin: 0 12px 6px;
}

.kame-toolbox-bubble__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: min(52vh, 420px);
  overflow-y: auto;
}

.tool-group-title {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--anime-text-muted);
  padding: 2px 12px 6px;
  font-family: ui-monospace, Menlo, monospace;
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

.kame-bubble-enter-active,
.kame-bubble-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.kame-bubble-enter-from,
.kame-bubble-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}

@media (max-width: 520px) {
  .kame-toolbox-bubble {
    --kame-bubble-overlap: 14px;

    bottom: 142px;
    min-width: 240px;
    max-width: min(300px, max(240px, var(--kame-bubble-max-width)));
  }
}
</style>
