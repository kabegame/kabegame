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
          按时间正序
        </el-dropdown-item>
        <el-dropdown-item command="desc" :class="{ 'is-active': sortOrder === 'desc' }">
          按时间倒序
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowDown, Sort } from "@element-plus/icons-vue";

const route = useRoute();
const router = useRouter();

const providerRootPath = computed(() => {
  const p = route.params.providerPath;
  const segs = typeof p === "string" ? [p] : Array.isArray(p) ? (p as string[]) : [];
  return segs.map((x) => String(x || "").trim()).filter(Boolean).join("/") || "全部";
});

const sortOrder = computed<"asc" | "desc">(() =>
  providerRootPath.value === "全部/倒序" ? "desc" : "asc"
);

const sortLabel = computed(() =>
  sortOrder.value === "desc" ? "按时间倒序" : "按时间正序"
);

function handleCommand(command: string) {
  if (command === "desc") {
    router.push({ name: "Gallery", params: { providerPath: ["全部", "倒序"] } });
  } else {
    router.push({ name: "Gallery", params: { providerPath: ["全部"] } });
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
