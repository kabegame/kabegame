<template>
  <section
    class="kb-collapsible-panel"
    :class="{
      'kb-collapsible-panel--collapsed': !panelOpen,
      'kb-collapsible-panel--fill': fillWhenExpanded,
    }"
  >
    <div class="kb-collapsible-panel__header">
      <button
        v-if="collapsible"
        type="button"
        class="kb-collapsible-panel__toggle"
        :aria-expanded="panelOpen"
        :aria-label="toggleAriaLabel"
        @click="panelOpen = !panelOpen"
      >
        <span class="kb-collapsible-panel__title">
          <slot name="title" />
        </span>
      </button>
      <span v-else class="kb-collapsible-panel__title">
        <slot name="title" />
      </span>
      <div class="kb-collapsible-panel__header-right">
        <slot name="trailing" />
        <button
          v-if="collapsible"
          type="button"
          class="kb-collapsible-panel__caret-button"
          :aria-expanded="panelOpen"
          :aria-label="toggleAriaLabel"
          @click="panelOpen = !panelOpen"
        >
          <span class="kb-collapsible-panel__caret" :class="{ 'is-open': panelOpen }">▾</span>
        </button>
      </div>
    </div>
    <!-- 收拢时不渲染内容（v-if 而非 v-show）：插件简介 iframe 等重内容需要真正销毁 -->
    <div v-if="panelOpen" class="kb-collapsible-panel__body">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useLocalStorage } from "@vueuse/core";

const props = withDefaults(
  defineProps<{
    storageKey: string;
    defaultOpen?: boolean;
    /** 无障碍：标题区无可见文案时建议传入 */
    toggleAriaLabel?: string;
    /** 展开时是否参与 flex 占满剩余高度（任务抽屉、图片详情插件区等） */
    fillWhenExpanded?: boolean;
    /**
     * 是否允许收拢。false 时隐藏箭头、标题不可点，内容恒定展开
     * （详情弹窗桌面端三栏并排，空间充足，不提供收拢）。
     */
    collapsible?: boolean;
  }>(),
  {
    defaultOpen: true,
    fillWhenExpanded: true,
    collapsible: true,
  },
);

const storedOpen = useLocalStorage(props.storageKey, props.defaultOpen, {
  mergeDefaults: true,
});

/** 不可收拢时恒定展开，但不写回持久化值（保留用户在可收拢场景下的偏好）。 */
const panelOpen = computed({
  get: () => (props.collapsible ? storedOpen.value : true),
  set: (v: boolean) => {
    if (props.collapsible) storedOpen.value = v;
  },
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
  box-sizing: border-box;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: transparent;
  color: var(--anime-text-primary);
  text-align: left;
}

.kb-collapsible-panel__toggle,
.kb-collapsible-panel__caret-button {
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.kb-collapsible-panel__toggle {
  display: flex;
  min-width: 0;
  flex: 1;
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

.kb-collapsible-panel__caret-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.kb-collapsible-panel__caret {
  display: inline-block;
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
