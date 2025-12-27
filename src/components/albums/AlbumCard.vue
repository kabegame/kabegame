<template>
  <div class="album-card" @click="$emit('click')" @mouseenter="$emit('mouseenter')">
    <div class="hero">
      <div v-for="(url, idx) in heroAll" :key="idx" class="hero-img" :class="heroClass(idx)"
        :style="heroStyle(url)">
        <div v-if="!url && loadingStates[idx]" class="hero-loading">
          <el-icon class="loading-icon"><Loading /></el-icon>
        </div>
      </div>
      <div v-if="heroAll.length === 0 && !isLoading" class="hero-empty">No Preview</div>
      <div v-if="isLoading && heroAll.length === 0" class="hero-loading-full">
        <el-icon class="loading-icon"><Loading /></el-icon>
      </div>
      <div class="hero-btn left" v-if="heroAll.length > 1" @click.stop="prevHero">
        <el-icon><ArrowLeft /></el-icon>
      </div>
      <div class="hero-btn right" v-if="heroAll.length > 1" @click.stop="nextHero">
        <el-icon><ArrowRight /></el-icon>
      </div>
    </div>
    <div class="info">
      <div class="title">{{ album.name }}</div>
      <div class="meta">
        <span>{{ count }} 张</span>
        <span v-if="album.createdAt">· 创建 {{ formatDate(album.createdAt) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Album } from "@/stores/albums";
import type { ImageInfo } from "@/stores/crawler";
import { ArrowLeft, ArrowRight, Loading } from "@element-plus/icons-vue";

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

const previewThumbs = computed(() => props.previewUrls.slice(0, 6));
const heroIndex = ref(0);
const heroAll = computed(() => {
  // 确保至少有6个位置，即使URL为空也保留位置用于显示加载状态
  const urls = props.previewUrls.slice(0, 6);
  while (urls.length < 6) {
    urls.push("");
  }
  return urls;
});

const heroClass = (idx: number) => {
  const total = heroAll.value.length;
  if (total === 0) return "is-hidden";
  const center = heroIndex.value % total;
  const left = (center - 1 + total) % total;
  const right = (center + 1) % total;
  if (idx === center) return "is-center";
  if (idx === left) return "is-left";
  if (idx === right) return "is-right";
  return "is-hidden";
};

const heroStyle = (url: string) => ({
  backgroundImage: `url(${url})`,
});

const nextHero = () => {
  if (heroAll.value.length === 0) return;
  heroIndex.value = (heroIndex.value + 1) % heroAll.value.length;
};

const prevHero = () => {
  if (heroAll.value.length === 0) return;
  heroIndex.value = (heroIndex.value - 1 + heroAll.value.length) % heroAll.value.length;
};

const thumbStyle = (url: string, idx: number) => ({
  backgroundImage: `url(${url})`,
  zIndex: 6 - idx,
});

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
  transition: transform 0.45s cubic-bezier(0.22, 0.61, 0.36, 1), opacity 0.45s ease;
  opacity: 0;

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
  color: rgba(31, 42, 68, 0.6);
  font-size: 12px;
  background: rgba(255, 255, 255, 0.35);
  border-radius: 14px;
}

.hero-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.5);
  border-radius: 14px;
  z-index: 10;
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

.title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 4px;
  text-shadow: 0 1px 3px rgba(255, 255, 255, 0.6);
}

.meta {
  font-size: 12px;
  color: rgba(31, 42, 68, 0.8);
}
}
</style>

