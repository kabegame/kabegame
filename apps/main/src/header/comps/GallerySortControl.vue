<template>
  <el-dropdown trigger="click" @command="handleCommand">
    <el-button class="gallery-sort-btn">
      <el-icon class="gallery-sort-icon">
        <Sort />
      </el-icon>
      <span class="gallery-sort-label">{{ sortLabel }}</span>
      <el-icon class="el-icon--right">
        <ArrowDown />
      </el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="asc" :class="{ 'is-active': sortOrder === 'asc' }">
          {{ t('gallery.byTimeAsc') }}
        </el-dropdown-item>
        <el-dropdown-item command="desc" :class="{ 'is-active': sortOrder === 'desc' }">
          {{ t('gallery.byTimeDesc') }}
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { ArrowDown, Sort } from "@element-plus/icons-vue";

const route = useRoute();
const router = useRouter();

const currentPath = computed(() => (route.query.path as string) || "all/1");

const sortOrder = computed<"asc" | "desc">(() =>
  currentPath.value.includes("/desc/") ? "desc" : "asc"
);

const { t } = useI18n();
const sortLabel = computed(() =>
  sortOrder.value === "desc" ? t("gallery.byTimeDesc") : t("gallery.byTimeAsc")
);

/** 从 path 得到不含页码、不含 desc 的根路径，如 all/desc/1 → all，date/2024-01/2 → date/2024-01 */
function getRootPath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  let i = segs.length - 1;
  while (i >= 0) {
    const seg = segs[i];
    if (/^\d+$/.test(seg)) {
      i--;
    } else if (seg === "desc") {
      i--;
    } else {
      break;
    }
  }
  return segs.slice(0, i + 1).join("/") || "all";
}

function handleCommand(command: string) {
  const rootPath = getRootPath(currentPath.value);
  if (command === "desc") {
    router.push({ path: "/gallery", query: { path: `${rootPath}/desc/1` } });
  } else {
    router.push({ path: "/gallery", query: { path: `${rootPath}/1` } });
  }
}
</script>

<style scoped lang="scss">
.gallery-sort-btn {
  .gallery-sort-icon {
    margin-right: 6px;
    font-size: 14px;
  }
  .gallery-sort-label {
    margin-right: 4px;
  }
}
</style>
