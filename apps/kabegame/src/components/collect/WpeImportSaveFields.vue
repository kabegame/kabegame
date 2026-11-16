<template>
  <!-- wpe-import 任务的「保存到」：输出画册与试运行（WPE 壁纸与 Steam 两个面板共用） -->
  <SectionTitle class="mt-1">{{ $t("gallery.webpageSectionSaveTo") }}</SectionTitle>
  <Field :label="$t('albums.outputAlbum')">
    <AlbumPicker
      v-model="outputAlbumId"
      :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
      expand-label-dirs
      allow-create
      :placeholder="$t('albums.notSpecifiedAddToGallery')"
      :picker-title="$t('albums.outputAlbum')"
      clearable
    />
  </Field>
  <Field :label="$t('plugins.dryRun')">
    <label class="flex min-h-8 cursor-pointer items-center gap-2.5">
      <Switch v-model="isDryRun" />
      <span class="text-[12.5px] text-kb-fg-muted">{{ $t("plugins.dryRunDesc") }}</span>
    </label>
  </Field>
</template>

<script setup lang="ts">
import { Field, Switch } from "@/components/ui";
import { HIDDEN_ALBUM_ID } from "@/services/albums";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import SectionTitle from "@/components/ui/SectionTitle.vue";

const outputAlbumId = defineModel<string | null>("outputAlbumId", { default: null });
const isDryRun = defineModel<boolean>("isDryRun", { default: false });
</script>
