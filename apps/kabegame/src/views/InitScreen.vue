<template>
  <main class="h-full flex flex-col items-center justify-center gap-5 px-6 text-[var(--anime-text-primary)]">
    <img :src="appLogoUrl" alt="" class="h-16 w-16 rounded-2xl shadow-[var(--anime-shadow)]" />
    <div class="text-lg font-700">Kabegame</div>

    <template v-if="current.phase === 'failed'">
      <div class="w-full max-w-120 flex flex-col items-center gap-3">
        <div class="text-base font-700 text-[var(--anime-danger)]">{{ t("common.startup.failed") }}</div>
        <pre
          class="m-0 max-h-60 w-full overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--anime-bg-card)] p-3 text-xs text-[var(--anime-text-primary)] select-text"
          >{{ current.message }}</pre>
        <button
          type="button"
          class="cursor-pointer rounded-lg border-none bg-[var(--anime-primary)] px-6 py-2 text-sm font-700 text-white hover:bg-[var(--anime-primary-dark)]"
          @click="exitApp"
        >
          {{ t("common.exit") }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="w-full max-w-90 flex flex-col gap-2">
        <div class="min-h-5 truncate text-center text-sm text-[var(--anime-text-secondary)]">{{ label }}</div>
        <el-progress
          :percentage="percent ?? 100"
          :indeterminate="percent === null"
          :duration="2"
          :show-text="false"
          :stroke-width="6"
          color="var(--anime-primary)"
        />
        <div v-if="countText" class="text-center font-mono text-xs text-[var(--anime-text-muted)]">
          {{ countText }}
        </div>
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, type ShallowRef } from "vue";
import { i18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import appLogoUrl from "@/assets/icon-small.png";
import type { StartupPhase } from "@/bootstrap/initScreen";
import { backfillName } from "@/utils/backfillName";

const props = defineProps<{ phase: ShallowRef<StartupPhase> }>();
const current = computed(() => props.phase.value);
// 启动页不安装 i18n（见 bootstrap/initScreen.ts），直接用全局 composer；locale 是响应式的。
const t = (key: string, params?: Record<string, unknown>) => (params ? i18n.global.t(key, params) : i18n.global.t(key));

const label = computed(() => {
  const phase = current.value;
  switch (phase.phase) {
    case "settings":
      return t("common.startup.settings");
    case "plugins":
      return t("common.startup.plugins");
    case "schema":
      return t("common.startup.schema", {
        version: String(phase.version).padStart(3, "0"),
        name: phase.name,
      });
    case "backfill":
      return t("common.startup.backfill", { name: backfillName(phase.id) });
    case "services":
    case "ready":
      return t("common.startup.services");
    default:
      return "";
  }
});

const percent = computed<number | null>(() => {
  const phase = current.value;
  if (phase.phase !== "backfill" || !phase.total) return null;
  return Math.max(0, Math.min(100, Math.round((phase.processed / phase.total) * 100)));
});

const countText = computed(() => {
  const phase = current.value;
  if (phase.phase !== "backfill") return "";
  return phase.total
    ? `${phase.processed.toLocaleString()} / ${phase.total.toLocaleString()}`
    : phase.processed.toLocaleString();
});

function exitApp() {
  void invoke("exit_app");
}
</script>
