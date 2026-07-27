<template>
  <button
    type="button"
    class="kamechan-busy-badge"
    :class="{
      'is-minimized': minimized,
      'is-failure': hasUnseenFailure,
      'is-indeterminate': summaryPercent === null && count > 0,
    }"
    :style="badgeStyle"
    :aria-label="t('header.busyBackground', { count })"
    @click.stop="emit('click')"
  >
    <span>{{ count }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useBusyTasks } from "@/composables/useBusyTasks";

defineProps<{ minimized: boolean }>();
const emit = defineEmits<{ click: [] }>();
const { t } = useI18n();
const { count, summaryPercent, hasUnseenFailure } = useBusyTasks();

const badgeStyle = computed(() => ({
  "--busy-angle": `${Math.max(0, summaryPercent.value ?? 0) * 3.6}deg`,
}));
</script>

<style scoped>
.kamechan-busy-badge {
  --busy-color: var(--anime-primary);

  position: absolute;
  left: 112px;
  bottom: 158px;
  z-index: 4;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  display: grid;
  place-items: center;
  cursor: pointer;
  pointer-events: auto;
  color: var(--anime-primary-dark);
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
  background: transparent;
  box-shadow: 0 6px 18px rgba(255, 107, 157, 0.45);
}

.kamechan-busy-badge::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: conic-gradient(
    var(--busy-color) var(--busy-angle),
    rgba(167, 139, 250, 0.28) 0
  );
}

.kamechan-busy-badge::after {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: inherit;
  background: #fff;
}

.kamechan-busy-badge span {
  position: relative;
  z-index: 1;
}

.kamechan-busy-badge.is-minimized {
  left: 36px;
  bottom: 34px;
  width: 24px;
  height: 24px;
  font-size: 9px;
}

.kamechan-busy-badge.is-failure {
  --busy-color: var(--anime-danger);

  color: var(--anime-danger);
  box-shadow: 0 6px 18px rgba(239, 68, 68, 0.4);
}

.kamechan-busy-badge.is-indeterminate {
  background: transparent;
}

.kamechan-busy-badge.is-indeterminate::before {
  background: repeating-conic-gradient(
    var(--busy-color) 0deg 24deg,
    transparent 24deg 46deg
  );
  animation: kamechan-busy-spin 1.1s linear infinite;
}

.kamechan-busy-badge.is-failure::before {
  background: var(--busy-color);
  animation: none;
}

@keyframes kamechan-busy-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 520px) {
  .kamechan-busy-badge {
    left: 78px;
    bottom: 128px;
    width: 27px;
    height: 27px;
  }

  .kamechan-busy-badge.is-minimized {
    left: 30px;
    bottom: 28px;
    width: 22px;
    height: 22px;
  }
}
</style>
