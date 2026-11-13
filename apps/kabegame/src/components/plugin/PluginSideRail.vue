<template>
  <KbResizable
    v-model="width"
    side="left"
    class="flex min-h-0 border-l border-l-solid border-kb-line bg-kb-fill-lighter"
    :default-size="defaultWidth"
    :handle-title="t('plugins.detail.prerequisites')"
  >
    <!-- 滚动放在内层：把手是相对本组件根定位的，根一起滚会让它跟着内容跑掉 -->
    <div class="flex-1 min-w-0 flex flex-col gap-3.5 py-3 px-3 overflow-y-auto [scrollbar-width:none]">
      <div v-if="tagChips.length">
        <div :class="SECTION_TITLE">{{ t("plugins.detail.tags") }}</div>
        <div class="flex flex-wrap items-center gap-1">
          <Tag v-for="chip in tagChips" :key="chip.key" size="sm" :tone="chip.tone">{{ chip.text }}</Tag>
          <PluginLabelTags v-if="plugin?.labels?.length" :labels="plugin.labels" />
        </div>
      </div>

      <div v-if="prereqItems.length">
        <div :class="SECTION_TITLE">{{ t("plugins.detail.prerequisites") }}</div>
        <div class="flex flex-col gap-2 text-[13px] leading-[1.5] text-kb-fg-regular">
          <div v-for="item in prereqItems" :key="item.key" class="flex items-start gap-2">
            <component :is="TONE_ICON[item.tone]" class="mt-[2px] size-4 flex-none" :class="TONE_COLOR[item.tone]" />
            <span>
              {{ item.text }}
              <a v-if="item.action" href="#" class="text-kb-fg underline" @click.prevent="item.action">
                {{ item.actionText }}
              </a>
            </span>
          </div>
        </div>
      </div>
    </div>
  </KbResizable>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { CircleCheck, CircleX, TriangleAlert } from "@lucide/vue";
import { Tag } from "@/components/ui";
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

const SECTION_TITLE = "mb-2 text-[11.5px] font-600 uppercase tracking-[0.06em] text-kb-fg-subtle";

/** 前置条件三档：满足 / 需要留意 / 不满足（中性外框，颜色只在图标上） */
type Tone = "success" | "warning" | "danger";
const TONE_ICON = { success: CircleCheck, warning: TriangleAlert, danger: CircleX } as const;
const TONE_COLOR: Record<Tone, string> = {
  success: "text-kb-success",
  warning: "text-kb-warning",
  danger: "text-kb-danger",
};

const tagChips = computed(() => {
  const chips: Array<{ key: string; text: string; tone: "neutral" | "success" | "danger" }> = [];
  const scriptType = props.plugin?.scriptType;
  if (scriptType === "v8") {
    chips.push({
      key: "script-v8",
      text: t("plugins.detail.scriptTypeV8"),
      tone: "neutral",
    });
  } else if (scriptType === "js") {
    chips.push({
      key: "script-js",
      text: t("plugins.detail.scriptTypeJs"),
      tone: "neutral",
    });
  }
  const minAppVersion = (props.plugin?.minAppVersion ?? "").trim();
  if (minAppVersion) {
    const incompatible = !!props.plugin?.minAppIncompatible;
    chips.push({
      key: "min-app-version",
      text: t("plugins.detail.requireAppVersion", { version: minAppVersion }),
      tone: incompatible ? "danger" : "success",
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
    tone: Tone;
    action?: () => void;
    actionText?: string;
  }> = [];

  const minAppVersion = (props.plugin?.minAppVersion ?? "").trim();
  if (minAppVersion) {
    const incompatible = !!props.plugin?.minAppIncompatible;
    items.push({
      key: "app-version",
      tone: incompatible ? "danger" : "success",
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
        tone: "danger",
        text: t("plugins.detail.surfNoCookie"),
        actionText: t("plugins.detail.goSurfLogin"),
        action: () => void openExternalLink(`https://${hostOf(props.plugin?.baseUrl)}`),
      });
    } else {
      const days = Math.floor((Date.now() - record.lastVisitAt * 1000) / 86_400_000);
      if (days > SURF_COOKIE_FRESH_DAYS) {
        items.push({
          key: "surf-cookie",
          tone: "warning",
          text: t("plugins.detail.surfCookieStale", { days }),
        });
      } else {
        items.push({
          key: "surf-cookie",
          tone: "success",
          text: t("plugins.detail.surfCookieFresh"),
        });
      }
    }
  }

  if (hasLabel("auth.needProxy")) {
    items.push({
      key: "proxy",
      tone: "warning",
      text: t("plugins.detail.needProxyHint"),
    });
  }

  return items;
});
</script>
