<template>
  <div ref="cardRef" class="album-card" :data-album-id="album.id" @click="handleCardClick">
    <div class="hero">
      <div v-for="(slot, idx) in heroSlots" :key="slot.key" class="hero-img" :class="heroClass(idx, slot.hasContent)">
        <ImageItem
          v-if="slot.image"
          :key="previewImageItemKey(slot.image)"
          :image="slot.image"
          :image-click-action="imageClickAction"
          :window-aspect-ratio="1"
          :grid-columns="3"
          :grid-index="idx"
          class="album-hero-image-item"
          @click="handleHeroImageClick"
        />
      </div>
      <div v-if="actualImageCount === 0 && !isLoading" class="hero-empty">
        <div class="empty-preview">
          <img src="/album-empty.png" alt="空画册" class="empty-image" />
          <p class="empty-text">{{ $t('common.emptyStateTip') }}</p>
        </div>
      </div>
      <div v-if="isLoading && actualImageCount === 0" class="hero-loading-full">
        <el-icon class="loading-icon">
          <Loading />
        </el-icon>
      </div>
    </div>
    <div class="info">
      <div class="title-wrapper">
        <el-input v-if="isRenaming" v-model="renameValue" ref="renameInputRef" size="small" @blur="handleRenameBlur"
          @keyup.enter="handleRenameConfirm" @keyup.esc="handleRenameCancel" class="rename-input" />
        <div v-else class="title" @click.stop @dblclick="handleStartRename">{{ album.name }}</div>
      </div>
      <div class="meta">
        <span>{{ $t('albums.albumCount', { count }) }}</span>
        <span v-if="album.createdAt">{{ $t('albums.createdAtPrefix', { date: formatDate(album.createdAt) }) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onUnmounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElMessage } from "element-plus";
import type { Album } from "@/stores/albums";
import { Loading } from "@element-plus/icons-vue";
import { useAlbumStore } from "@/stores/albums";
import { CONTENT_URI_PROXY_PREFIX, IS_ANDROID } from "@kabegame/core/env";
import ImageItem from "@kabegame/core/components/image/ImageItem.vue";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { thumbnailToUrl } from "@kabegame/core/httpServer";
import { isVideoMediaType } from "@kabegame/core/utils/mediaMime";

interface Props {
  album: Album;
  previewImages: ImageInfo[];
  count: number;
  /** 画册页从 keep-alive 返回时递增，仅用于视频预览 ImageItem 的 key 后缀以强制重建 */
  videoPreviewRemountKey?: number;
  isLoading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  previewImages: () => [],
  videoPreviewRemountKey: 0,
  isLoading: false,
});

const { t } = useI18n();
const albumStore = useAlbumStore();
const settingsStore = useSettingsStore();
const imageClickAction = computed(() => settingsStore.values.imageClickAction || "none");

const isRenaming = ref(false);
const renameValue = ref("");
const renameInputRef = ref<any>(null);
const cardRef = ref<HTMLElement | null>(null);
const hasBeenVisible = ref(false);

const emit = defineEmits<{
  click: [];
  visible: [];
}>();

/** 与 Albums.vue 中 toPreviewUrl 一致，用于判断是否有可展示的预览 */
const toPreviewUrl = (img: ImageInfo): string => {
  const thumbPath = (img.thumbnailPath || img.localPath || "").trim();
  if (!thumbPath) return "";
  if (IS_ANDROID) {
    return thumbPath.startsWith("content://")
      ? thumbPath.replace("content://", CONTENT_URI_PROXY_PREFIX)
      : "";
  }
  return thumbnailToUrl(thumbPath);
};

const hasRenderablePreview = (img: ImageInfo) => !!toPreviewUrl(img);

/** 视频在返回画册页后需换 key 重建，否则桌面 WebView 内 <video> 常不再 autoplay */
const previewImageItemKey = (img: ImageInfo) =>
  isVideoMediaType(img.type) ? `${img.id}-${props.videoPreviewRemountKey}` : img.id;

// Intersection Observer：卡片进入视口时触发 visible 事件
let observer: IntersectionObserver | null = null;

onMounted(() => {
  if (!cardRef.value) return;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !hasBeenVisible.value) {
          hasBeenVisible.value = true;
          emit("visible");
          observer?.disconnect();
        }
      }
    },
    {
      rootMargin: "100px",
      threshold: 0,
    }
  );

  observer.observe(cardRef.value);
});

onUnmounted(() => {
  observer?.disconnect();
});

defineExpose({
  startRename: () => {
    handleStartRename();
  },
});

const handleCardClick = () => {
  if (isRenaming.value) return;
  emit("click");
};

/** ImageItem 内部 @click.stop，需单独转发以打开画册 */
const handleHeroImageClick = () => {
  if (isRenaming.value) return;
  emit("click");
};

const handleStartRename = (event?: MouseEvent) => {
  if (event) {
    event.stopPropagation();
  }
  isRenaming.value = true;
  renameValue.value = props.album.name;
  nextTick(() => {
    const inputEl = renameInputRef.value?.$el?.querySelector("input") as HTMLInputElement | null;
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });
};

const handleRenameConfirm = async () => {
  if (!renameValue.value.trim()) {
    ElMessage.warning(t("albums.albumNameCannotBeEmpty"));
    return;
  }
  if (renameValue.value.trim() === props.album.name) {
    isRenaming.value = false;
    return;
  }
  try {
    await albumStore.renameAlbum(props.album.id, renameValue.value.trim());
    isRenaming.value = false;
    ElMessage.success(t("albums.renameSuccess"));
  } catch (error: any) {
    console.error("重命名失败:", error);
    const errorMessage =
      typeof error === "string" ? error : error?.message || String(error) || "未知错误";
    ElMessage.error(errorMessage);
    renameValue.value = props.album.name;
  }
};

const handleRenameBlur = () => {
  handleRenameConfirm();
};

const handleRenameCancel = () => {
  renameValue.value = props.album.name;
  isRenaming.value = false;
};

const heroIndex = ref(0);
const heroMaxSlots = IS_ANDROID ? 1 : 3;

const heroSlots = computed(() => {
  const out: { key: string; image: ImageInfo | null; hasContent: boolean }[] = [];
  for (let idx = 0; idx < heroMaxSlots; idx++) {
    const img = props.previewImages[idx];
    const hasContent = !!(img && hasRenderablePreview(img));
    out.push({
      key: img?.id ?? `empty-${idx}`,
      image: hasContent && img ? img : null,
      hasContent,
    });
  }
  return out;
});

const actualImageCount = computed(() => heroSlots.value.filter((s) => s.hasContent).length);

const heroDisplayCount = computed(() => {
  const actualCount = actualImageCount.value;
  if (actualCount > 0) return actualCount;
  if (props.isLoading) return heroMaxSlots;
  return 0;
});

const heroClass = (idx: number, hasContent: boolean) => {
  const displayCount = heroDisplayCount.value;

  if (displayCount === 1) {
    const pos = idx === 0 ? "is-center" : "is-hidden";
    const state = hasContent ? "has-url" : "is-empty-url";
    return `${pos} ${state}`;
  }

  if (displayCount === 2) {
    const pos = idx === 0 ? "is-center" : idx === 1 ? "is-right" : "is-hidden";
    const state = hasContent ? "has-url" : "is-empty-url";
    return `${pos} ${state}`;
  }

  if (displayCount <= 0) {
    return "is-hidden is-empty-url";
  }

  const total = displayCount;
  const center = heroIndex.value % total;
  const left = (center - 1 + total) % total;
  const right = (center + 1) % total;

  let pos = "is-hidden";
  if (idx === center) pos = "is-center";
  else if (idx === left) pos = "is-left";
  else if (idx === right) pos = "is-right";

  const state = hasContent ? "has-url" : "is-empty-url";
  return `${pos} ${state}`;
};

const formatDate = (ts?: number) => {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};

</script>

<style scoped lang="scss">
.album-card {
  position: relative;
  height: 200px;
  border-radius: 14px;
  background: linear-gradient(135deg, #fef7ff, #f0f7ff);
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 8px 20px rgba(80, 90, 120, 0.18);
  transition: transform 0.25s ease, box-shadow 0.25s ease;
  border: 1px solid rgba(120, 140, 180, 0.18);

  &:hover {
    box-shadow: 0 14px 30px rgba(80, 90, 120, 0.28), 0 0 18px rgba(255, 170, 200, 0.35);
    border-color: rgba(255, 170, 200, 0.35);
  }

  .hero {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .hero-img {
    position: absolute;
    width: 70%;
    height: 70%;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    overflow: hidden;
    isolation: isolate;
    transition: transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.45s ease, filter 0.45s ease;
    opacity: 0;
    display: flex;
    align-items: stretch;
    justify-content: stretch;

    /* ImageItem 填满 hero 格，并弱化画廊默认边框/阴影 */
    :deep(.album-hero-image-item.image-item) {
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      border: none;
      box-shadow: none;
      outline: none;
      background: transparent;
      border-radius: 14px;
    }

    html:not(.platform-android) &:deep(.album-hero-image-item.image-item:hover) {
      outline: none;
    }

    :deep(.image-wrapper) {
      border-radius: 14px;
    }

    :deep(.thumbnail) {
      object-fit: cover;
    }

    &.is-empty-url {
      opacity: 0 !important;
      filter: blur(2px);
    }

    &.is-center {
      transform: translateX(0) scale(1);
      opacity: 1;
      z-index: 3;
    }

    &.is-left {
      transform: translateX(-45%) scale(0.9);
      opacity: 0.7;
      z-index: 2;
      filter: brightness(0.75);
    }

    &.is-right {
      transform: translateX(45%) scale(0.9);
      opacity: 0.7;
      z-index: 2;
      filter: brightness(0.75);
    }

    &.is-hidden {
      opacity: 0;
      transform: translateX(0) scale(0.8);
      z-index: 1;
    }
  }

  .hero-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.35);
    border-radius: 14px;
    padding: 16px;
    overflow: hidden;

    .empty-preview {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 24px;
      width: 100%;
      height: 100%;

      .empty-image {
        width: 120px;
        max-width: 45%;
        height: auto;
        opacity: 0.85;
        user-select: none;
        pointer-events: none;
        flex-shrink: 0;
      }

      .empty-text {
        writing-mode: vertical-rl;
        color: rgba(31, 42, 68, 0.7);
        font-size: 13px;
        line-height: 1.8;
        margin: 0;
        padding: 8px 0;
        flex-shrink: 0;
        letter-spacing: 0.1em;
      }
    }

    html.platform-android & {
      padding: 8px;

      .empty-preview {
        gap: 8px;

        .empty-image {
          width: 80px;
          max-width: 40%;
        }

        .empty-text {
          font-size: 11px;
          line-height: 1.5;
          padding: 4px 0;
          flex-shrink: 1;
          overflow: hidden;
        }
      }
    }
  }

  .hero-loading-full {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.5);
    border-radius: 14px;
    z-index: 10;
  }

  .loading-icon {
    font-size: 24px;
    color: var(--anime-primary);
    animation: rotate 1s linear infinite;
  }

  @keyframes rotate {
    from {
      transform: rotate(0deg);
    }

    to {
      transform: rotate(360deg);
    }
  }

  .info {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 12px 14px;
    background: linear-gradient(to top, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.65));
    color: #1f2a44;
    z-index: 5;
  }

  .title-wrapper {
    margin-bottom: 4px;
  }

  .title {
    font-size: 15px;
    font-weight: 700;
    text-shadow: 0 1px 3px rgba(255, 255, 255, 0.6);
    cursor: text;
    user-select: none;

    &:hover {
      opacity: 0.8;
    }
  }

  .rename-input {
    :deep(.el-input__wrapper) {
      padding: 2px 8px;
      box-shadow: 0 0 0 1px var(--el-color-primary) inset;
    }

    :deep(.el-input__inner) {
      font-size: 15px;
      font-weight: 700;
      padding: 0;
      height: auto;
    }
  }

  .meta {
    font-size: 12px;
    color: rgba(31, 42, 68, 0.8);
  }
}
</style>
