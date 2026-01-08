<template>
  <div ref="cardRef" class="album-card" :data-album-id="album.id" @click="handleCardClick">
    <div class="hero">
      <div v-for="(url, idx) in heroAll" :key="idx" class="hero-img" :class="heroClass(idx, url)" :style="heroStyle(url)">
        <div v-if="!url && loadingStates[idx]" class="hero-loading">
          <el-icon class="loading-icon">
            <Loading />
          </el-icon>
        </div>
      </div>
      <div v-if="actualImageCount === 0 && !isLoading" class="hero-empty">
        <div class="empty-preview">
          <img src="/album-empty.png" alt="空画册" class="empty-image" />
          <p class="empty-text">まだ空っぽだけど、これから色々お友達を作っていくのだ！</p>
        </div>
      </div>
      <div v-if="isLoading && actualImageCount === 0" class="hero-loading-full">
        <el-icon class="loading-icon">
          <Loading />
        </el-icon>
      </div>
      <div class="hero-btn left" v-if="actualImageCount >= 3" @click.stop="prevHero">
        <el-icon>
          <ArrowLeft />
        </el-icon>
      </div>
      <div class="hero-btn right" v-if="actualImageCount >= 3" @click.stop="nextHero">
        <el-icon>
          <ArrowRight />
        </el-icon>
      </div>
    </div>
    <div class="info">
      <div class="title-wrapper">
        <el-input v-if="isRenaming" v-model="renameValue" ref="renameInputRef" size="small" @blur="handleRenameBlur"
          @keyup.enter="handleRenameConfirm" @keyup.esc="handleRenameCancel" class="rename-input" />
        <div v-else class="title" @dblclick="handleStartRename">{{ album.name }}</div>
      </div>
      <div class="meta">
        <span>{{ count }} 张</span>
        <span v-if="album.createdAt">· 创建 {{ formatDate(album.createdAt) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onUnmounted } from "vue";
import { ElMessage } from "element-plus";
import type { Album } from "@/stores/albums";
import { ArrowLeft, ArrowRight, Loading } from "@element-plus/icons-vue";
import { useAlbumStore } from "@/stores/albums";

interface Props {
  album: Album;
  previewUrls: string[];
  count: number;
  loadingStates?: boolean[];
  isLoading?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  loadingStates: () => [],
  isLoading: false,
});

const albumStore = useAlbumStore();
const isRenaming = ref(false);
const renameValue = ref("");
const renameInputRef = ref<any>(null);
const cardRef = ref<HTMLElement | null>(null);
const hasBeenVisible = ref(false);

const emit = defineEmits<{
  click: [];
  visible: [];
}>();

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
          // 触发一次后就不再需要观察了
          observer?.disconnect();
        }
      }
    },
    {
      rootMargin: "100px", // 提前100px开始加载
      threshold: 0,
    }
  );
  
  observer.observe(cardRef.value);
});

onUnmounted(() => {
  observer?.disconnect();
});

// 暴露方法供外部调用
defineExpose({
  startRename: () => {
    handleStartRename();
  },
});

const handleCardClick = () => {
  // 如果正在重命名，不触发点击
  if (isRenaming.value) {
    return;
  }
  emit('click');
};

const handleStartRename = (event?: MouseEvent) => {
  if (event) {
    event.stopPropagation(); // 阻止事件冒泡
  }
  isRenaming.value = true;
  renameValue.value = props.album.name;
  nextTick(() => {
    const inputEl = renameInputRef.value?.$el?.querySelector('input') as HTMLInputElement | null;
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
    }
  });
};

const handleRenameConfirm = async () => {
  if (!renameValue.value.trim()) {
    ElMessage.warning("画册名称不能为空");
    return;
  }
  if (renameValue.value.trim() === props.album.name) {
    isRenaming.value = false;
    return;
  }
  try {
    await albumStore.renameAlbum(props.album.id, renameValue.value.trim());
    isRenaming.value = false;
    ElMessage.success("重命名成功");
  } catch (error) {
    console.error("重命名失败:", error);
    ElMessage.error("重命名失败: " + (error as Error).message);
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
const heroAll = computed(() => {
  // 确保至少有6个位置，即使URL为空也保留位置用于显示加载状态
  const urls = props.previewUrls.slice(0, 6);
  while (urls.length < 6) {
    urls.push("");
  }
  return urls;
});

// 计算实际有效图片数量（非空 URL）
const actualImageCount = computed(() => {
  return props.previewUrls.slice(0, 6).filter(url => url).length;
});

// 轮播展示数量：
// - 有有效预览时，用实际预览数
// - 预览还在加载但还没 URL 时：用 3，让占位/转圈可见（体验对齐画廊的“加载中”）
const heroDisplayCount = computed(() => {
  const actualCount = actualImageCount.value;
  if (actualCount > 0) return actualCount;
  if (props.isLoading) return 3;
  return 0;
});

const heroClass = (idx: number, url: string) => {
  const displayCount = heroDisplayCount.value;

  // 如果只有1张图，只显示第一张居中
  if (displayCount === 1) {
    const pos = idx === 0 ? "is-center" : "is-hidden";
    const state = url ? "has-url" : (props.loadingStates?.[idx] ? "is-placeholder" : "is-empty-url");
    return `${pos} ${state}`;
  }

  // 如果只有2张图，显示第一张居中，第二张在右边，不轮转
  if (displayCount === 2) {
    const pos = idx === 0 ? "is-center" : idx === 1 ? "is-right" : "is-hidden";
    const state = url ? "has-url" : (props.loadingStates?.[idx] ? "is-placeholder" : "is-empty-url");
    return `${pos} ${state}`;
  }

  // 3张及以上，正常轮转，但只在有效图片范围内轮转
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

  const state = url ? "has-url" : (props.loadingStates?.[idx] ? "is-placeholder" : "is-empty-url");
  return `${pos} ${state}`;
};

const heroStyle = (url: string) => ({
  backgroundImage: `url(${url})`,
});

const nextHero = () => {
  const actualCount = actualImageCount.value;
  if (actualCount < 3) return; // 少于3张不轮转
  heroIndex.value = (heroIndex.value + 1) % actualCount;
};

const prevHero = () => {
  const actualCount = actualImageCount.value;
  if (actualCount < 3) return; // 少于3张不轮转
  heroIndex.value = (heroIndex.value - 1 + actualCount) % actualCount;
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
    transform: translateY(-6px) scale(1.02);
    box-shadow: 0 14px 30px rgba(80, 90, 120, 0.28), 0 0 18px rgba(255, 170, 200, 0.35);
    border-color: rgba(255, 170, 200, 0.35);

    .hero-btn {
      opacity: 1;
    }
  }

  .hero {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .hero-img {
    position: absolute;
    width: 70%;
    height: 70%;
    background-size: cover;
    background-position: center;
    border-radius: 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    overflow: hidden;
    isolation: isolate;
    transition: transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.45s ease, filter 0.35s ease;
    opacity: 0;

    /* 加载占位（体验对齐画廊图片骨架屏）：先盖一层 shimmer，URL 到了再淡出 */
    &::before {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0.08),
        rgba(255, 255, 255, 0.45),
        rgba(255, 255, 255, 0.08)
      );
      background-size: 200% 100%;
      opacity: 0;
      transition: opacity 0.25s ease;
      z-index: 1;
    }

    &.is-placeholder::before {
      opacity: 1;
      animation: heroShimmer 1.1s ease-in-out infinite;
    }

    /* 没有 URL 且也不是加载中的占位：直接隐藏，避免空白块闪一下 */
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
  }

  .hero-loading {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.5);
    border-radius: 14px;
    z-index: 2;
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

  @keyframes heroShimmer {
    0% {
      background-position: 0% 0%;
    }
    100% {
      background-position: 200% 0%;
    }
  }

  .hero-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.14);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.2s ease, background 0.2s ease;
    pointer-events: auto;

    &.left {
      left: 8px;
    }

    &.right {
      right: 8px;
    }

    &:hover {
      background: rgba(0, 0, 0, 0.25);
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
