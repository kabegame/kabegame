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
import { useGalleryPathState } from "@/composables/useGalleryPathState";
import { DEFAULT_GALLERY_PATH, galleryPathWithSortOnly } from "@/utils/galleryPath";

const route = useRoute();
const router = useRouter();

const { providerPath: galleryProviderPath } = useGalleryPathState();

/** 与 useProviderPathRoute 一致：无 query.path 时用 root/sort/page 算出的 providerPath */
const effectiveGalleryPath = computed(() => {
  const raw = route.query.path;
  const qp = Array.isArray(raw) ? raw[0] : raw;
  const qpStr = qp != null && qp !== "" ? String(qp) : "";
  if (route.path !== "/gallery") {
    return qpStr || DEFAULT_GALLERY_PATH;
  }
  if (qpStr) return qpStr;
  return galleryProviderPath.value;
});

const currentPath = effectiveGalleryPath;

const sortOrder = computed<"asc" | "desc">(() =>
  currentPath.value.includes("/desc/") ? "desc" : "asc"
);

const { t } = useI18n();
const sortLabel = computed(() =>
  sortOrder.value === "desc" ? t("gallery.byTimeDesc") : t("gallery.byTimeAsc")
);

function handleCommand(command: string) {
  const sort = command === "desc" ? "desc" : "asc";
  const next = galleryPathWithSortOnly(currentPath.value, sort);
  void router.push({ path: "/gallery", query: { path: next } });
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
