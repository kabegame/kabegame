<template>
  <div class="load-more-container flex items-center justify-center pt-8 mt-6">
    <Button v-if="hasMore" :disabled="loading" @click.stop.prevent="$emit('loadMore')">
      <Spinner v-if="loading" :size="14" />
      <Plus v-else />
      {{ $t("common.loadMore") }}
    </Button>
    <Button v-else-if="showNextPage" @click.stop.prevent="$emit('nextPage')">
      {{ $t("common.enterNextPage") }}
      <ArrowRight />
    </Button>
    <div v-else class="h-10 text-[13px] leading-10 text-kb-fg-subtle">{{ $t("common.noMore") }}</div>
  </div>
</template>

<script setup lang="ts">
import { ArrowRight, Plus } from "@lucide/vue";
import { Button, Spinner } from "@/components/ui";

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
