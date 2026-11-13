<template>
  <div v-if="screens.length > 0" class="flex min-w-0 flex-col gap-2">
    <!-- 画布：宽度随容器，布局图等比缩进去并水平居中 -->
    <div class="box-border flex w-full flex-col items-center rounded-kb-lg bg-kb-fill-light px-3 py-3">
      <!-- 只用来量可用宽度：高度恒为 0，不随布局图变。直接量画布的话，布局图撑高画布又会触发一次测量
           （在对话框里挂载时初始宽度为 0，浏览器会报 ResizeObserver loop） -->
      <div ref="measureRef" class="h-0 w-full" aria-hidden="true" />
      <div
        class="relative shrink-0"
        role="group"
        :aria-label="t('settings.screenLayout')"
        :style="{ width: `${layout.width}px`, height: `${layout.height}px` }"
      >
        <button
          v-for="item in items"
          :key="item.screen.id"
          type="button"
          class="absolute m-0 box-border flex flex-col appearance-none items-center justify-center overflow-hidden rounded-8px border-[1.5px] border-solid p-0 font-inherit outline-none transition-[background-color,border-color,box-shadow] duration-200 cursor-pointer focus-visible:shadow-[0_0_0_2px_var(--kb-ring)]"
          :class="item.selected ? BOX_SELECTED : BOX_IDLE"
          :style="item.style"
          :aria-pressed="item.selected"
          :title="item.title"
          :data-screen-id="item.screen.id"
          @click="emit('update:selected', item.targetId)"
          @dblclick="emit('confirm', item.targetId)"
          @keydown.enter.prevent="choose(item.targetId)"
        >
          <!-- 角标：主屏、默认屏。块太小就不显示，信息仍在 title 里 -->
          <span
            v-if="item.roomy && item.badges.length"
            class="pointer-events-none absolute right-1 top-1 flex max-w-[calc(100%-8px)] gap-1 overflow-hidden"
          >
            <span
              v-for="badge in item.badges"
              :key="badge.key"
              class="shrink-0 rounded-full px-1.5 text-10px font-600 leading-[16px]"
              :class="badge.strong ? BADGE_STRONG : BADGE_PLAIN"
            >
              {{ badge.label }}
            </span>
          </span>
          <span
            class="font-700 leading-none tabular-nums"
            :class="[item.roomy ? 'text-20px' : 'text-14px', item.selected ? TEXT_SELECTED : TEXT_IDLE]"
          >
            {{ item.index }}
          </span>
          <span v-if="item.roomy" class="mt-1 max-w-full truncate px-2 text-12px font-500 leading-[1.3] text-kb-fg">
            {{ item.name }}
          </span>
          <span
            v-if="item.showResolution"
            class="max-w-full truncate px-2 text-11px leading-[1.3] tabular-nums text-kb-fg-muted"
          >
            {{ item.resolution }}
          </span>
        </button>
        <!-- 跨屏拼接：所有屏是一整块画布，外接矩形描边 -->
        <div
          v-if="displayMode === 'span'"
          class="pointer-events-none absolute inset-0 rounded-10px border-2 border-dashed border-kb-accent"
        />
      </div>
    </div>

    <p v-if="screens.length === 1" class="m-0 text-12px leading-[1.55] text-kb-fg-muted">
      {{ t("settings.screenOnlyOne") }}
    </p>

    <!-- 已断开的屏：配置还留着，接回来就恢复；用不上了可以忘记 -->
    <div
      v-if="showDisconnected && displayMode === 'single' && disconnected.length"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 text-12px leading-[1.55] text-kb-fg-muted"
    >
      <span>{{ t("settings.screenDisconnected") }}</span>
      <span v-for="targetId in disconnected" :key="targetId" class="inline-flex items-center gap-1">
        <code class="kb-selectable text-11px">{{ shortScreenId(targetId) }}</code>
        <Button variant="ghost" size="sm" data-testid="screen-forget" @click="forget(targetId)">
          {{ t("settings.screenForget") }}
        </Button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useElementSize } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import { invoke } from "@/api/rpc";
import Button from "@/components/ui/Button.vue";
import { useSettingsStore } from "@/stores/settings";
import { useWallpaperScreens } from "@/composables/useWallpaperScreens";
import { kameMessage } from "@/utils/kameMessage";
import { logger } from "@/utils/logger";
import { layoutScreens } from "@/utils/wallpaperScreenLayout";
import {
  defaultScreenId,
  disconnectedScreenTargets,
  screenIdOfTarget,
  targetIdOfScreen,
  type WallpaperDisplayMode,
} from "@/utils/wallpaperTargets";

/**
 * 显示器布局图：按系统里的相对位置画出每块在线屏，点一块屏选中它所属的壁纸目标。
 *
 * 设置页（选要改哪个目标）与目标选择弹窗（选把壁纸设到哪块屏）共用。屏列表自己取、自己跟
 * `wallpaper-screens-change`（`useWallpaperScreens`），没有在线屏信息的平台什么都不渲染。
 *
 * 选中的含义随显示器模式变：`multiple` / `span` 下所有屏同属一个目标，点哪块都选中它、所有块一起高亮；
 * `single` 下每块屏各是一个目标。
 */
const props = withDefaults(
  defineProps<{
    /** 选中的目标 id（`multiple` / `span` / `screen:<id>`） */
    selected?: string | null;
    /** 生效的显示器模式 */
    displayMode: WallpaperDisplayMode;
    /** 逐屏独立下的默认屏（屏幕持久标识）；不在线或为空时按主屏 */
    defaultScreen?: string | null;
    /** 逐屏独立下是否列出已断开的屏及「忘记」入口 */
    showDisconnected?: boolean;
  }>(),
  { selected: null, defaultScreen: null, showDisconnected: false },
);

const emit = defineEmits<{
  (e: "update:selected", targetId: string): void;
  /** 双击一块屏、或焦点在它上面时按回车：选中并确认（目标选择弹窗用，设置页不监听） */
  (e: "confirm", targetId: string): void;
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const screens = useWallpaperScreens();

/** 布局图最高这么高；宽度不够时按宽度缩，实际高度更小 */
const MAX_HEIGHT = 132;
/** 相邻两块屏之间留的缝（各自内缩一半） */
const GAP = 4;
/** 块的宽、高都不小于这个数才放得下名字与角标 */
const ROOMY_WIDTH = 92;
const ROOMY_HEIGHT = 62;
/** 分辨率一行另需的高度 */
const RESOLUTION_HEIGHT = 80;

// 中性外框，选中的那块用强调色描边与淡底（强调色只给「选中」）
const BOX_SELECTED =
  "border-kb-accent bg-[color-mix(in_srgb,var(--kb-accent)_8%,var(--kb-surface-raised))] shadow-kb-sm";
const BOX_IDLE = "border-kb-line-strong bg-kb-surface-raised hover:border-kb-fg-subtle";
const TEXT_SELECTED = "text-kb-accent";
const TEXT_IDLE = "text-kb-fg-muted";
const BADGE_STRONG = "bg-kb-primary text-kb-primary-fg";
const BADGE_PLAIN = "bg-kb-fill text-kb-fg-muted";

const measureRef = ref<HTMLElement | null>(null);
// 画布内容区宽度（不含内边距）：布局图能用的宽度
const { width: canvasWidth } = useElementSize(measureRef);

const layout = computed(() => layoutScreens(screens.value, canvasWidth.value, MAX_HEIGHT));
const defaultId = computed(() => defaultScreenId(screens.value, props.defaultScreen));

const items = computed(() => {
  const boxes = new Map(layout.value.boxes.map((box) => [box.id, box]));
  return screens.value.flatMap((screen, position) => {
    const box = boxes.get(screen.id);
    if (!box) return [];
    const width = box.width - GAP;
    const height = box.height - GAP;
    const index = position + 1;
    const name = screen.name || t("settings.screenNumbered", { n: index });
    const resolution = `${screen.pixelWidth}×${screen.pixelHeight}`;
    const targetId = targetIdOfScreen(props.displayMode, screen.id);
    const badges = [
      ...(screen.primary ? [{ key: "primary", label: t("settings.screenPrimary"), strong: false }] : []),
      // 默认屏只在逐屏独立下有意义
      ...(props.displayMode === "single" && screen.id === defaultId.value
        ? [{ key: "default", label: t("settings.screenDefault"), strong: true }]
        : []),
    ];
    const roomy = width >= ROOMY_WIDTH && height >= ROOMY_HEIGHT;
    return [
      {
        screen,
        index,
        name,
        resolution,
        targetId,
        badges,
        roomy,
        showResolution: roomy && height >= RESOLUTION_HEIGHT,
        selected: !!props.selected && targetId === props.selected,
        // 块放不下的信息都在这里
        title: [`${index} · ${name}`, resolution, ...badges.map((badge) => badge.label)].join(" · "),
        style: {
          left: `${box.left + GAP / 2}px`,
          top: `${box.top + GAP / 2}px`,
          width: `${Math.max(width, 0)}px`,
          height: `${Math.max(height, 0)}px`,
        },
      },
    ];
  });
});

/** 回车：选中这块屏并确认（拦掉默认行为，免得再触发一次 click） */
function choose(targetId: string) {
  emit("update:selected", targetId);
  emit("confirm", targetId);
}

const disconnected = computed(() => disconnectedScreenTargets(settingsStore.values.wallpaperTargets, screens.value));

/** 断开的屏没有名字可显示（名字不存盘），给出标识的前 8 位以便区分 */
function shortScreenId(targetId: string): string {
  return (screenIdOfTarget(targetId) ?? targetId).slice(0, 8);
}

async function forget(targetId: string) {
  try {
    // 成功后后端发 setting-change { wallpaperTargets }，这一项随之消失
    await invoke<void>("forget_wallpaper_target", { targetId });
  } catch (error) {
    logger.warn("忘记显示器失败:", error);
    kameMessage.error(error instanceof Error ? error.message : String(error));
  }
}
</script>
