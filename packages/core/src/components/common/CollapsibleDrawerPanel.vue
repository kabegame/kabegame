<template>
  <section
    class="kb-collapsible-panel"
    :class="{
      'kb-collapsible-panel--collapsed': !panelOpen,
      'kb-collapsible-panel--fill': fillWhenExpanded,
    }"
  >
    <button
      type="button"
      class="kb-collapsible-panel__header"
      :aria-expanded="panelOpen"
      :aria-label="toggleAriaLabel"
      @click="panelOpen = !panelOpen"
    >
      <span class="kb-collapsible-panel__title">
        <slot name="title" />
      </span>
      <div class="kb-collapsible-panel__header-right">
        <slot name="trailing" />
        <span class="kb-collapsible-panel__caret" :class="{ 'is-open': panelOpen }">▾</span>
      </div>
    </button>
    <div v-show="panelOpen" class="kb-collapsible-panel__body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import { useLocalStorage } from "@vueuse/core";

const props = withDefaults(
  defineProps<{
    storageKey: string;
    defaultOpen?: boolean;
    /** 无障碍：标题区无可见文案时建议传入 */
    toggleAriaLabel?: string;
    /** 展开时是否参与 flex 占满剩余高度（任务抽屉、图片详情插件区等） */
    fillWhenExpanded?: boolean;
  }>(),
  {
    defaultOpen: true,
    fillWhenExpanded: true,
  },
);

const panelOpen = useLocalStorage(props.storageKey, props.defaultOpen, {
  mergeDefaults: true,
});
</script>

<style scoped lang="scss">
.kb-collapsible-panel {
  border: 1px solid var(--anime-border);
  border-radius: 10px;
  background: var(--anime-bg-secondary);
  display: flex;
  flex-direction: column;
  min-height: 44px;
  overflow: hidden;

  &--fill:not(.kb-collapsible-panel--collapsed) {
    flex: 1;
    min-height: 0;
  }

  &--collapsed {
    flex: 0 0 auto;
  }
}

.kb-collapsible-panel__header {
  border: 0;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: transparent;
  color: var(--anime-text-primary);
  cursor: pointer;
  text-align: left;
}

.kb-collapsible-panel__title {
  font-size: 14px;
  font-weight: 600;
  min-width: 0;
  flex: 1;
}

.kb-collapsible-panel__header-right {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.kb-collapsible-panel__caret {
  font-size: 13px;
  color: var(--anime-text-secondary);
  transition: transform 0.2s ease;

  &.is-open {
    transform: rotate(180deg);
  }
}

.kb-collapsible-panel__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
