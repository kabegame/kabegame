<template>
  <div :class="[ns.e('item'), ns.e(variant)]">
    <picture-filled v-if="variant === 'image'" />
  </div>
</template>

<script lang="ts" setup>
import { useNamespace } from '@kabegame/element-plus/hooks'
import { PictureFilled } from '@kabegame/element-plus-icons'

import type { SkeletonItemProps } from './skeleton-item.js'

defineOptions({
  name: 'ElSkeletonItem',
})
withDefaults(defineProps<SkeletonItemProps>(), {
  variant: 'text',
})
const ns = useNamespace('skeleton')
</script>
