<template>
  <el-badge v-if="failedCount > 0" :value="failedCount" :max="99" class="failed-images-badge">
    <el-tooltip :content="t('header.failedImages')" placement="bottom">
      <el-button @click="openFailedImagesPage" class="failed-images-trigger" circle>
        <el-icon>
          <WarningFilled />
        </el-icon>
      </el-button>
    </el-tooltip>
  </el-badge>
  <el-tooltip v-else :content="t('header.failedImages')" placement="bottom">
    <el-button @click="openFailedImagesPage" class="failed-images-trigger" circle>
      <el-icon>
        <WarningFilled />
      </el-icon>
    </el-button>
  </el-tooltip>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { WarningFilled } from "@element-plus/icons-vue";
import { useI18n } from "@kabegame/i18n";
import { useFailedImagesStore } from "@/stores/failedImages";

const router = useRouter();
const { t } = useI18n();
const failedImagesStore = useFailedImagesStore();
const failedCount = computed(() => failedImagesStore.allFailed.length);

const openFailedImagesPage = () => {
  void router.push({ path: "/failed-images" });
};
</script>

<style scoped lang="scss">
.failed-images-trigger {
  box-shadow: var(--anime-shadow);
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}

.failed-images-badge {
  display: block;
}
</style>
