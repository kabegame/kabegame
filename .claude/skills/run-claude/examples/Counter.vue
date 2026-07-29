<script setup lang="ts">
import { computed, ref } from "vue";

const count = ref(0);
// BUG: 应该是 count * 2
const doubled = computed(() => count.value + 2);
</script>

<template>
  <div class="flex items-center gap-2">
    <span>{{ count }} / {{ doubled }}</span>
    <button @click="count++">+1</button>
  </div>
</template>
