<!-- 兼容旧路径；逻辑已合并至 `components/album/AlbumPickerField.vue` -->
<script setup lang="ts">
import AlbumPickerField from "../album/AlbumPickerField.vue";
</script>
<template>
  <AlbumPickerField v-bind="$attrs" />
</template>
