<template>
  <KbResizable
    v-model="width"
    side="left"
    class="flex min-h-0 bg-[color-mix(in_srgb,white_35%,transparent)] border-l border-l-solid border-[var(--anime-border)]"
    :default-size="defaultWidth"
    :handle-title="t('plugins.detail.prerequisites')"
  >
    <!-- 滚动放在内层：把手是相对本组件根定位的，根一起滚会让它跟着内容跑掉 -->
    <div class="flex-1 min-w-0 flex flex-col gap-3.5 py-3 px-3 overflow-y-auto [scrollbar-width:none]">
      <div v-if="tagChips.length">
        <div class="text-12px font-700 tracking-[0.08em] text-[var(--anime-text-muted)] mb-1.5">{{ t("plugins.detail.tags") }}</div>
        <div class="flex flex-wrap gap-1">
          <span v-for="chip in tagChips" :key="chip.key" class="kb-chip text-white" :style="{ background: chip.bg }">{{ chip.text }}</span>
          <PluginLabelTags v-if="plugin?.labels?.length" :labels="plugin.labels" />
        </div>
      </div>

      <div v-if="prereqItems.length">
        <div class="text-12px font-700 tracking-[0.08em] text-[var(--anime-text-muted)] mb-1.5">{{ t("plugins.detail.prerequisites") }}</div>
        <div class="flex flex-col gap-1.5 text-13.5px">
          <div v-for="item in prereqItems" :key="item.key" class="flex items-center gap-2">
            <span
              class="w-4 h-4 rounded-6px flex items-center justify-center flex-none text-white"
              :style="{ background: item.color }"
            >
              <el-icon :size="11"><component :is="item.icon" /></el-icon>
            </span>
            <span>
              {{ item.text }}
              <a v-if="item.action" href="#" class="underline" @click.prevent="item.action">{{ item.actionText }}</a>
            </span>
          </div>
        </div>
      </div>
    </div>
  </KbResizable>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { ElIcon } from "@kabegame/element-plus";
import { CircleCheckFilled, WarningFilled } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import type { Plugin } from "../../stores/plugins";
import { useSurfStore } from "../../stores/surf";
import { openExternalLink } from "../../utils/openExternalLink";
import KbResizable from "../common/KbResizable.vue";
import PluginLabelTags from "./PluginLabelTags.vue";

const props = defineProps<{
  plugin: Plugin | null;
  appVersion?: string | null;
  /** 双击把手复位到的宽度；上下限由 kb-side-pane 的 CSS 变量给 */
  defaultWidth?: number;
}>();

/** 右栏宽度（px），由宿主持久化 */
const width = defineModel<number>("width");

const { t } = useI18n();
const surfStore = useSurfStore();
onMounted(() => {
  void surfStore.init();
});

const SURF_COOKIE_FRESH_DAYS = 30;

const tagChips = computed(() => {
  const chips: Array<{ key: string; text: string; bg: string }> = [];
  const scriptType = props.plugin?.scriptType;
  if (scriptType === "v8") {
    chips.push({ key: "script-v8", text: t("plugins.detail.scriptTypeV8"), bg: "linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)" });
  } else if (scriptType === "js") {
    chips.push({ key: "script-js", text: t("plugins.detail.scriptTypeJs"), bg: "linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)" });
  }
  const minAppVersion = (props.plugin?.minAppVersion ?? "").trim();
  if (minAppVersion) {
    const incompatible = !!props.plugin?.minAppIncompatible;
    chips.push({
      key: "min-app-version",
      text: t("plugins.detail.requireAppVersion", { version: minAppVersion }),
      bg: incompatible
        ? "linear-gradient(135deg, #ef4444 0%, #f87171 100%)"
        : "linear-gradient(135deg, #10b981 0%, #34d399 100%)",
    });
  }
  return chips;
});

function hostOf(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const hasLabel = (id: string) => (props.plugin?.labels ?? []).some((l) => l.id === id);

const surfRecord = computed(() => {
  const host = hostOf(props.plugin?.baseUrl);
  return host ? surfStore.recordByHost(host) : undefined;
});

const prereqItems = computed(() => {
  const items: Array<{
    key: string;
    text: string;
    color: string;
    icon: typeof CircleCheckFilled;
    action?: () => void;
    actionText?: string;
  }> = [];

  const minAppVersion = (props.plugin?.minAppVersion ?? "").trim();
  if (minAppVersion) {
    const incompatible = !!props.plugin?.minAppIncompatible;
    items.push({
      key: "app-version",
      color: incompatible ? "linear-gradient(135deg, #ef4444 0%, #f87171 100%)" : "linear-gradient(135deg, #10b981 0%, #34d399 100%)",
      icon: incompatible ? WarningFilled : CircleCheckFilled,
      text: incompatible
        ? t("plugins.detail.appVersionBad", { app: props.appVersion ?? "?", min: minAppVersion })
        : t("plugins.detail.appVersionOk", { app: props.appVersion ?? "?", min: minAppVersion }),
    });
  }

  if (hasLabel("auth.needCookie")) {
    // lastVisitAt 是 unix 秒（与 Surf.vue 的 formatRelative 同口径），乘 1000 换算成毫秒
    const record = surfRecord.value;
    if (!record || !record.cookie.trim()) {
      items.push({
        key: "surf-cookie",
        color: "linear-gradient(135deg, #ef4444 0%, #f87171 100%)",
        icon: WarningFilled,
        text: t("plugins.detail.surfNoCookie"),
        actionText: t("plugins.detail.goSurfLogin"),
        action: () => void openExternalLink(`https://${hostOf(props.plugin?.baseUrl)}`),
      });
    } else {
      const days = Math.floor((Date.now() - record.lastVisitAt * 1000) / 86_400_000);
      if (days > SURF_COOKIE_FRESH_DAYS) {
        items.push({
          key: "surf-cookie",
          color: "linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)",
          icon: WarningFilled,
          text: t("plugins.detail.surfCookieStale", { days }),
        });
      } else {
        items.push({
          key: "surf-cookie",
          color: "linear-gradient(135deg, #10b981 0%, #34d399 100%)",
          icon: CircleCheckFilled,
          text: t("plugins.detail.surfCookieFresh"),
        });
      }
    }
  }

  if (hasLabel("auth.needProxy")) {
    items.push({
      key: "proxy",
      color: "linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)",
      icon: WarningFilled,
      text: t("plugins.detail.needProxyHint"),
    });
  }

  return items;
});
</script>
