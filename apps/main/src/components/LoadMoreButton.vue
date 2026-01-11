<template>
  <div class="load-more-container">
    <template v-if="hasMore">
      <el-button type="primary" @click.stop.prevent="$emit('loadMore')" :loading="loading" size="large">
        <el-icon v-if="!loading">
          <Plus />
        </el-icon>
        加载更多
      </el-button>
    </template>
    <template v-else-if="showNextPage">
      <el-button type="primary" @click.stop.prevent="$emit('nextPage')" size="large">
        <el-icon>
          <ArrowRight />
        </el-icon>
        进入下一页
      </el-button>
    </template>
    <template v-else>
      <div class="load-more-placeholder">没有更多了</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { Plus, ArrowRight } from "@element-plus/icons-vue";

interface Props {
  hasMore: boolean;
  loading: boolean;
  showNextPage?: boolean;
}

withDefaults(defineProps<Props>(), {
  showNextPage: false,
});

defineEmits<{
  loadMore: [];
  nextPage: [];
}>();
</script>

<style scoped lang="scss">
.load-more-container {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 32px 0 0;
  margin-top: 24px;
}

.load-more-placeholder {
  height: 40px;
  line-height: 40px;
  color: #999;
  font-size: 14px;
  opacity: 0.7;
}
</style>
