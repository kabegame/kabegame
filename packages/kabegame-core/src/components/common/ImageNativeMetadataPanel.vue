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
      <span class="native-meta-chip native-meta-chip-primary">{{ mimeLabel }}</span>
    </template>
    <div class="native-meta-body">
      <template v-if="state === 'loading'">
        <template v-if="showLoading">
          <div class="native-meta-loading">
            <el-icon class="is-loading"><Loading /></el-icon>
            <span>{{ t("gallery.nativeMetaLoading") }}</span>
          </div>
          <div
            v-for="index in 6"
            :key="index"
            class="native-meta-skeleton"
            aria-hidden="true"
          />
        </template>
      </template>

      <DetailPanelEmptyState
        v-else-if="state === 'empty'"
        :title="t('gallery.nativeMetaEmptyTitle')"
        :description="t(emptyDescKey)"
      />

      <div v-else-if="state === 'error'" class="native-meta-state" role="alert">
        <div class="native-meta-state-icon native-meta-state-icon-error">
          <el-icon><WarningFilled /></el-icon>
        </div>
        <div class="native-meta-state-title">
          {{ t("gallery.nativeMetaErrorTitle") }}
        </div>
        <div class="native-meta-state-desc">
          {{ t("gallery.nativeMetaErrorDesc") }}
        </div>
        <code class="native-meta-error-detail">{{ errorDetail }}</code>
        <el-button type="primary" :icon="Refresh" @click="load">
          {{ t("gallery.nativeMetaRetry") }}
        </el-button>
      </div>

      <template v-else>
        <div
          v-if="payload?.partial"
          class="native-meta-warning"
          role="status"
        >
          <el-icon><WarningFilled /></el-icon>
          <span>{{ t("gallery.nativeMetaPartialWarning") }}</span>
        </div>

        <section
          v-for="group in displayGroups"
          :key="group.id"
          class="native-meta-group"
          :class="{ 'native-meta-group--stacked': group.id === 'text' }"
        >
          <header class="native-meta-group-header">
            <div class="min-w-0 flex flex-1 flex-col">
              <span class="native-meta-group-title">{{ groupTitle(group.id) }}</span>
              <span class="native-meta-group-subtitle">{{ group.subtitle }}</span>
            </div>
            <span class="native-meta-count">
              {{ t("gallery.nativeMetaEntryCount", { count: group.entries.length }) }}
            </span>
            <el-button
              text
              circle
              size="small"
              class="native-meta-copy-group"
              :title="t('gallery.nativeMetaCopyGroup')"
              :aria-label="t('gallery.nativeMetaCopyGroup')"
              @click="copyText(groupText(group))"
            >
              <el-icon><CopyDocument /></el-icon>
            </el-button>
          </header>

          <div v-if="group.id === 'gps'" class="native-meta-warning native-meta-gps-warning">
            <el-icon><WarningFilled /></el-icon>
            <span>{{ t("gallery.nativeMetaGpsPrivacy") }}</span>
          </div>

          <div class="native-meta-entries">
            <div
              v-for="(entry, index) in group.entries"
              :key="`${entry.tag}-${index}`"
              class="native-meta-entry"
            >
              <div class="native-meta-tag">{{ entry.tag }}</div>
              <div class="native-meta-value-wrap min-w-0 flex-1">
                <div
                  v-if="entry.long"
                  class="native-meta-long-value"
                >{{ entry.value }}</div>
                <div v-else class="native-meta-short-value">
                  <span class="native-meta-value">{{ entry.value }}</span>
                  <span v-if="entry.note" class="native-meta-note">{{ entry.note }}</span>
                  <span
                    v-if="entry.byteLen != null"
                    class="native-meta-note native-meta-byte-len"
                  >{{ byteLengthLabel(entry.byteLen) }}</span>
                </div>
                <div v-if="entry.long && (entry.note || entry.byteLen != null)" class="native-meta-note mt-1">
                  <span v-if="entry.note">{{ entry.note }}</span>
                  <span v-if="entry.note && entry.byteLen != null"> · </span>
                  <span v-if="entry.byteLen != null">{{ byteLengthLabel(entry.byteLen) }}</span>
                </div>
              </div>
              <el-button
                text
                circle
                size="small"
                class="native-meta-copy-entry"
                :title="t('gallery.nativeMetaCopyEntry')"
                :aria-label="t('gallery.nativeMetaCopyEntry')"
                @click="copyText(entryText(entry))"
              >
                <el-icon><CopyDocument /></el-icon>
              </el-button>
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
import {
  CopyDocument,
  Loading,
  Refresh,
  WarningFilled,
} from "@kabegame/element-plus-icons";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { kameMessage as ElMessage } from "../../utils/kameMessage";
import { useNativeMetadataState } from "../../composables/useNativeMetadataState";
import { IS_WEB } from "../../env";
import type {
  NativeEntry,
  NativeGroup,
  NativeMetadataFormat,
} from "../../types/nativeMetadata";
import { displayImageMimeType } from "../../utils/mediaMime";

type NativeMetadataImageLike = {
  id?: string;
  type?: string;
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
const {
  state,
  showLoading,
  payload,
  errorDetail,
  displayGroups,
  load,
} = useNativeMetadataState(imageId);

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
    ElMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制图片原生元数据失败:", error);
    ElMessage.error(t("common.copyFailed"));
  }
}

</script>

<style scoped lang="scss">
/* 外框/标题栏 chrome 由 CollapsibleDrawerPanel 提供；这里只保留容器查询上下文 */
.image-native-metadata-panel {
  container-type: inline-size;
  min-width: 0;
}

.native-meta-chip {
  border-radius: 7px;
  padding: 3px 9px;
  color: var(--anime-text-secondary);
  background: color-mix(in srgb, var(--anime-secondary) 14%, transparent);
  font-size: 11px;
  line-height: 1.4;
}

.native-meta-chip-primary {
  color: var(--anime-primary-dark);
  background: color-mix(in srgb, var(--anime-primary) 14%, transparent);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}

.native-meta-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
  padding: 14px 16px;
  user-select: text;
  -webkit-user-select: text;
}

.native-meta-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 2px 6px;
  color: var(--anime-text-secondary);
  font-size: 13px;

  .el-icon {
    color: var(--anime-primary);
  }
}

.native-meta-skeleton {
  height: 38px;
  flex: 0 0 38px;
  border-radius: 8px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--anime-secondary) 10%, transparent) 25%,
    color-mix(in srgb, var(--anime-primary) 14%, transparent) 37%,
    color-mix(in srgb, var(--anime-secondary) 10%, transparent) 63%
  );
  background-size: 800px 100%;
  animation: native-meta-shimmer 1.4s linear infinite;
}

.native-meta-state {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 12px;
  padding: 42px 24px;
  text-align: center;
}

.native-meta-state-icon {
  display: flex;
  width: 60px;
  height: 60px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 28px;
}

.native-meta-state-icon-error {
  color: var(--anime-danger);
  background: color-mix(in srgb, var(--anime-danger) 12%, transparent);
}

.native-meta-state-title {
  color: var(--anime-text-primary);
  font-size: 14.5px;
  font-weight: 600;
}

.native-meta-state-desc {
  max-width: 380px;
  color: var(--anime-text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
}

.native-meta-error-detail {
  max-width: 420px;
  border: 1px solid color-mix(in srgb, var(--anime-danger) 25%, transparent);
  border-radius: 7px;
  padding: 6px 10px;
  color: var(--anime-danger);
  background: color-mix(in srgb, var(--anime-danger) 8%, transparent);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 11px;
  word-break: break-all;
}

.native-meta-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--anime-warning) 35%, transparent);
  border-radius: 9px;
  padding: 9px 11px;
  color: var(--anime-warning);
  background: color-mix(in srgb, var(--anime-warning) 10%, transparent);
  font-size: 12px;
  line-height: 1.55;

  .el-icon {
    flex-shrink: 0;
    margin-top: 1px;
  }
}

.native-meta-group {
  flex: 0 0 auto;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--anime-primary) 28%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--anime-bg-card) 50%, transparent);
}

.native-meta-group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--anime-primary) 9%, transparent),
    color-mix(in srgb, var(--anime-secondary) 9%, transparent)
  );
}

.native-meta-group-title {
  color: var(--anime-text-primary);
  font-size: 13.5px;
  font-weight: 600;
}

.native-meta-group-subtitle {
  overflow: hidden;
  color: var(--anime-text-muted);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.native-meta-count {
  flex-shrink: 0;
  border-radius: 7px;
  padding: 2px 9px;
  color: var(--anime-primary-dark);
  background: color-mix(in srgb, var(--anime-primary) 16%, transparent);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.native-meta-copy-group {
  flex-shrink: 0;
  color: var(--anime-text-secondary);

  &:hover {
    color: var(--anime-primary-dark);
    background: color-mix(in srgb, var(--anime-primary) 16%, transparent);
  }
}

.native-meta-gps-warning {
  margin: 8px 10px 2px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 11.5px;
}

.native-meta-entries {
  display: flex;
  flex-direction: column;
  padding: 5px;
}

.native-meta-entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border-radius: 8px;
  padding: 8px 9px;

  &:hover {
    background: color-mix(in srgb, var(--anime-secondary) 7%, transparent);

    .native-meta-copy-entry {
      opacity: 1;
    }
  }
}

.native-meta-tag {
  flex: 0 0 clamp(96px, 28%, 168px);
  padding-top: 1px;
  color: var(--anime-text-secondary);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
}

.native-meta-short-value {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}

.native-meta-value,
.native-meta-long-value {
  color: var(--anime-text-primary);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.native-meta-long-value {
  max-height: 128px;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--anime-primary) 20%, transparent);
  border-radius: 6px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--anime-secondary) 8%, transparent);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.native-meta-note {
  color: var(--anime-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.native-meta-byte-len {
  white-space: nowrap;
}

.native-meta-copy-entry {
  flex-shrink: 0;
  color: var(--anime-secondary-light);
  opacity: 0;

  &:hover {
    color: var(--anime-primary);
    background: color-mix(in srgb, var(--anime-primary) 12%, transparent);
  }

  &:focus-visible {
    opacity: 1;
  }
}

.native-meta-group--stacked {
  .native-meta-entry {
    position: relative;
    flex-direction: column;
    gap: 5px;
    padding-right: 34px;
  }

  .native-meta-tag {
    width: 100%;
    flex-basis: auto;
  }

  .native-meta-value-wrap {
    box-sizing: border-box;
    width: 100%;
  }

  .native-meta-long-value {
    max-height: 200px;
  }

  .native-meta-copy-entry {
    position: absolute;
    top: 4px;
    right: 4px;
  }
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
    top: 4px;
    right: 4px;
  }
}

@keyframes native-meta-shimmer {
  from {
    background-position: -400px 0;
  }

  to {
    background-position: 400px 0;
  }
}
</style>
