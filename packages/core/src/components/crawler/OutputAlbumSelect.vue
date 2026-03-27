<template>
  <el-select
    :model-value="modelValue ?? null"
    :placeholder="placeholder || $t('plugins.defaultGalleryOnly')"
    clearable
    style="width: 100%"
    @update:model-value="(v) => emit('update:modelValue', (v as string) || null)"
  >
    <el-option v-for="album in albums" :key="album.id" :label="album.name" :value="album.id" />
    <el-option v-if="allowCreate" value="__create_new__" :label="$t('albums.createNewAlbum')">
      <span style="color: var(--el-color-primary); font-weight: 500;">
        {{ $t("albums.createNewAlbum") }}
      </span>
    </el-option>
  </el-select>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: string | null;
  albums: Array<{ id: string; name: string }>;
  allowCreate?: boolean;
  placeholder?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
}>();
</script>
