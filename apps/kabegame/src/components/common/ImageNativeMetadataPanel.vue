<template>
  <CollapsibleDrawerPanel
    class="image-native-metadata-panel"
    storage-key="kabegame-image-detail-native-metadata-open"
    :collapsible="collapsible"
    :fill-when-expanded="fillWhenExpanded"
    :toggle-aria-label="t('gallery.nativeMetaTitle')"
  >
    <template #title>
      {{ t("gallery.nativeMetaTitle") }}
    </template>
    <template #trailing>
      <Tag size="sm" class="font-mono">{{ mimeLabel }}</Tag>
    </template>
    <div class="native-meta-body kb-selectable">
      <template v-if="state === 'loading'">
        <template v-if="showLoading">
          <div class="flex items-center gap-2.5 px-0.5 pb-1.5 pt-0.5 text-[13px] text-kb-fg-muted">
            <Spinner :size="16" />
            <span>{{ t("gallery.nativeMetaLoading") }}</span>
          </div>
          <Skeleton v-for="index in 6" :key="index" class="h-[38px] flex-none" />
        </template>
      </template>

      <DetailPanelEmptyState
        v-else-if="state === 'empty'"
        :title="t('gallery.nativeMetaEmptyTitle')"
        :description="t(emptyDescKey)"
      />

      <div v-else-if="state === 'error'" class="flex flex-col items-center gap-3 px-6 py-10 text-center" role="alert">
        <div
          class="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--kb-danger)_10%,transparent)] text-kb-danger"
        >
          <TriangleAlert class="size-6" />
        </div>
        <div class="text-[14px] font-600 text-kb-fg">
          {{ t("gallery.nativeMetaErrorTitle") }}
        </div>
        <div class="max-w-[380px] text-[12.5px] leading-[1.65] text-kb-fg-muted">
          {{ t("gallery.nativeMetaErrorDesc") }}
        </div>
        <code
          class="max-w-[420px] break-all rounded-kb-sm bg-kb-fill-light px-2.5 py-1.5 font-mono text-[11px] text-kb-danger"
        >
          {{ errorDetail }}
        </code>
        <Button variant="primary" size="sm" @click="load">
          <RefreshCw />
          {{ t("gallery.nativeMetaRetry") }}
        </Button>
      </div>

      <template v-else>
        <Alert v-if="payload?.partial" tone="warning" class="flex-none">
          {{ t("gallery.nativeMetaPartialWarning") }}
        </Alert>

        <section
          v-for="group in displayGroups"
          :key="group.id"
          class="native-meta-group"
          :class="{ 'native-meta-group--stacked': group.id === 'text' }"
        >
          <header class="native-meta-group-header">
            <div class="flex min-w-0 flex-1 flex-col">
              <span class="text-[13px] font-600 leading-5 text-kb-fg">{{ groupTitle(group.id) }}</span>
              <span class="native-meta-group-subtitle">{{ group.subtitle }}</span>
            </div>
            <span class="shrink-0 whitespace-nowrap text-[11.5px] text-kb-fg-subtle tabular-nums">
              {{ t("gallery.nativeMetaEntryCount", { count: group.entries.length }) }}
            </span>
            <Tooltip :content="t('gallery.nativeMetaCopyGroup')">
              <Button
                variant="ghost"
                size="icon-sm"
                :aria-label="t('gallery.nativeMetaCopyGroup')"
                @click="copyText(groupText(group))"
              >
                <Copy />
              </Button>
            </Tooltip>
          </header>

          <Alert v-if="group.id === 'gps'" tone="warning" class="mx-2.5 mt-2 text-[12px]">
            {{ t("gallery.nativeMetaGpsPrivacy") }}
          </Alert>

          <div class="flex flex-col p-1">
            <div v-for="(entry, index) in group.entries" :key="`${entry.tag}-${index}`" class="native-meta-entry group">
              <div class="native-meta-tag">{{ entry.tag }}</div>
              <div class="native-meta-value-wrap min-w-0 flex-1">
                <div v-if="entry.long" class="native-meta-long-value">{{ entry.value }}</div>
                <div v-else class="flex flex-wrap items-baseline gap-1.5">
                  <span class="native-meta-value">{{ entry.value }}</span>
                  <span v-if="entry.note" :class="NOTE_CLASS">{{ entry.note }}</span>
                  <span v-if="entry.byteLen != null" :class="[NOTE_CLASS, 'whitespace-nowrap']">
                    {{ byteLengthLabel(entry.byteLen) }}
                  </span>
                </div>
                <div v-if="entry.long && (entry.note || entry.byteLen != null)" :class="[NOTE_CLASS, 'mt-1']">
                  <span v-if="entry.note">{{ entry.note }}</span>
                  <span v-if="entry.note && entry.byteLen != null">·</span>
                  <span v-if="entry.byteLen != null">{{ byteLengthLabel(entry.byteLen) }}</span>
                </div>
              </div>
              <!-- 外层 span 承载窄栏 / 堆叠排布时的绝对定位（scoped 类不挂在组件上） -->
              <span class="native-meta-copy-entry flex shrink-0">
                <Tooltip :content="t('gallery.nativeMetaCopyEntry')">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    :aria-label="t('gallery.nativeMetaCopyEntry')"
                    @click="copyText(entryText(entry))"
                  >
                    <Copy />
                  </Button>
                </Tooltip>
              </span>
            </div>
          </div>
        </section>
      </template>
    </div>
  </CollapsibleDrawerPanel>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import CollapsibleDrawerPanel from "./CollapsibleDrawerPanel.vue";
import DetailPanelEmptyState from "./DetailPanelEmptyState.vue";
import { Copy, RefreshCw, TriangleAlert } from "@lucide/vue";
import { Alert, Button, Skeleton, Spinner, Tag, Tooltip } from "@/components/ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { kameMessage } from "../../utils/kameMessage";
import { useNativeMetadataState } from "../../composables/useNativeMetadataState";
import { IS_WEB } from "../../env";
import type { NativeEntry, NativeGroup, NativeMetadataFormat } from "../../types/nativeMetadata";
import { displayImageMimeType } from "../../utils/mediaMime";

type NativeMetadataImageLike = {
  id?: string;
  type?: string;
  imageMetadataId?: number;
};

const props = withDefaults(
  defineProps<{
    image: NativeMetadataImageLike | null;
    /** 是否允许收拢（详情弹窗桌面端并排三栏时关闭） */
    collapsible?: boolean;
    /** 展开时是否 flex:1 争夺容器剩余空间（preview 侧栏多面板共存时为 true） */
    fillWhenExpanded?: boolean;
  }>(),
  {
    collapsible: true,
    fillWhenExpanded: false,
  },
);

const { t } = useI18n();
const imageId = computed(() => props.image?.id);
const imageMetadataId = computed(() => props.image?.imageMetadataId);
const { state, showLoading, payload, errorDetail, displayGroups, load } = useNativeMetadataState(
  imageId,
  imageMetadataId,
);

/** 条目的附注（单位换算、字节数） */
const NOTE_CLASS = "text-[11.5px] leading-normal text-kb-fg-subtle";

const mimeLabel = computed(() => displayImageMimeType(props.image?.type));

/** 空态文案按格式区分；后端没返回 format 时（例如解析前）退回按 MIME 猜。 */
const emptyDescKeys: Record<NativeMetadataFormat, string> = {
  jpeg: "gallery.nativeMetaEmptyJpeg",
  png: "gallery.nativeMetaEmptyPng",
  webp: "gallery.nativeMetaEmptyWebp",
  gif: "gallery.nativeMetaEmptyGif",
};

const mimeToFormat: Record<string, NativeMetadataFormat> = {
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

const emptyFormat = computed<NativeMetadataFormat>(() => {
  if (payload.value?.format) return payload.value.format;
  return mimeToFormat[mimeLabel.value.trim().toLowerCase()] ?? "jpeg";
});

const emptyDescKey = computed(() => emptyDescKeys[emptyFormat.value]);

const groupKeys: Record<string, string> = {
  image: "nativeMetaGroupImage",
  capture: "nativeMetaGroupCapture",
  gps: "nativeMetaGroupGps",
  thumbnail: "nativeMetaGroupThumbnail",
  misc: "nativeMetaGroupMisc",
  ihdr: "nativeMetaGroupIhdr",
  vp8x: "nativeMetaGroupVp8x",
  screen: "nativeMetaGroupScreen",
  anim: "nativeMetaGroupAnim",
  text: "nativeMetaGroupText",
  color: "nativeMetaGroupColor",
  phys: "nativeMetaGroupPhys",
  other: "nativeMetaGroupOther",
};

function groupTitle(groupId: string): string {
  const key = groupKeys[groupId];
  return key ? t(`gallery.${key}`) : groupId;
}

function byteLengthLabel(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  return `${Math.floor(value).toLocaleString()} B`;
}

function entryText(entry: NativeEntry): string {
  const note = entry.note ? ` ${entry.note}` : "";
  const byteLen = entry.byteLen != null ? ` (${byteLengthLabel(entry.byteLen)})` : "";
  return `${entry.tag}: ${entry.value}${note}${byteLen}`;
}

function groupText(group: NativeGroup): string {
  const header = `[${groupTitle(group.id)}]${group.subtitle ? ` (${group.subtitle})` : ""}`;
  return [header, ...group.entries.map(entryText)].join("\n");
}

async function copyText(text: string): Promise<void> {
  try {
    if (IS_WEB) {
      await navigator.clipboard.writeText(text);
    } else {
      await writeText(text);
    }
    kameMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制图片原生元数据失败:", error);
    kameMessage.error(t("common.copyFailed"));
  }
}
</script>

<style scoped>
/* 外框/标题栏由 CollapsibleDrawerPanel 提供；这里是容器查询上下文与条目的两种排布（窄栏、文本块改成上下堆叠） */
.image-native-metadata-panel {
  container-type: inline-size;
  min-width: 0;
}

.native-meta-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding: 2px 12px 12px;
}

.native-meta-group {
  flex: 0 0 auto;
  overflow: hidden;
  border: 1px solid var(--kb-line);
  border-radius: var(--kb-radius-md);
}

.native-meta-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 6px 8px 12px;
  border-bottom: 1px solid var(--kb-line);
  background: var(--kb-fill-lighter);
}

.native-meta-group-subtitle {
  overflow: hidden;
  color: var(--kb-fg-subtle);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.native-meta-entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border-radius: var(--kb-radius-sm);
  padding: 6px 4px 6px 8px;
}

.native-meta-entry:hover {
  background: var(--kb-hover);
}

.native-meta-tag {
  flex: 0 0 clamp(96px, 28%, 168px);
  padding-top: 1px;
  color: var(--kb-fg-muted);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}

.native-meta-value,
.native-meta-long-value {
  color: var(--kb-fg);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.native-meta-long-value {
  max-height: 128px;
  overflow: auto;
  border: 1px solid var(--kb-line);
  border-radius: var(--kb-radius-sm);
  padding: 8px 10px;
  background: var(--kb-fill-lighter);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.native-meta-group--stacked .native-meta-entry {
  position: relative;
  flex-direction: column;
  gap: 5px;
  padding-right: 34px;
}

.native-meta-group--stacked .native-meta-tag {
  width: 100%;
  flex-basis: auto;
}

.native-meta-group--stacked .native-meta-value-wrap {
  box-sizing: border-box;
  width: 100%;
}

.native-meta-group--stacked .native-meta-long-value {
  max-height: 200px;
}

.native-meta-group--stacked .native-meta-copy-entry {
  position: absolute;
  top: 2px;
  right: 2px;
}

@container (max-width: 300px) {
  .native-meta-entry {
    position: relative;
    flex-direction: column;
    gap: 5px;
    padding-right: 34px;
  }

  .native-meta-tag {
    flex-basis: auto;
    width: 100%;
  }

  .native-meta-value-wrap {
    box-sizing: border-box;
    width: 100%;
  }

  .native-meta-copy-entry {
    position: absolute;
    top: 2px;
    right: 2px;
  }
}
</style>
