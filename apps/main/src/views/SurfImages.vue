<template>
  <div class="surf-images-page">
    <ImageGrid
      class="surf-grid"
      :images="images"
      :enable-virtual-scroll="!IS_ANDROID"
      :enable-ctrl-wheel-adjust-columns="!IS_ANDROID"
      :enable-ctrl-key-adjust-columns="!IS_ANDROID"
    />
    <div class="load-more">
      <el-button v-if="hasMore" :loading="loading" @click="loadMore">加载更多</el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { ElMessage } from "element-plus";
import ImageGrid from "@/components/ImageGrid.vue";
import type { ImageInfo } from "@kabegame/core/types/image";
import { useSurfStore } from "@/stores/surf";
import { IS_ANDROID } from "@kabegame/core/env";

const route = useRoute();
const surfStore = useSurfStore();
const images = ref<ImageInfo[]>([]);
const total = ref(0);
const offset = ref(0);
const limit = 50;
const loading = ref(false);

const hasMore = ref(false);

const loadMore = async () => {
  if (loading.value || !hasMore.value) return;
  loading.value = true;
  try {
    const id = String(route.params.id || "");
    const result = await surfStore.getRecordImages(id, offset.value, limit);
    images.value.push(...result.images);
    total.value = result.total;
    offset.value = images.value.length;
    hasMore.value = images.value.length < total.value;
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || "加载图片失败");
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  images.value = [];
  offset.value = 0;
  hasMore.value = true;
  await loadMore();
});
</script>

<style scoped lang="scss">
.surf-images-page {
  height: 100%;
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.surf-grid {
  flex: 1;
  min-height: 0;
}

.load-more {
  margin-top: 12px;
  text-align: center;
}
</style>
