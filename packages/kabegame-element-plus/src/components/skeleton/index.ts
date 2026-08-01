import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Skeleton from './src/skeleton.vue'
import SkeletonItem from './src/skeleton-item.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElSkeleton: SFCWithInstall<typeof Skeleton> & {
  SkeletonItem: typeof SkeletonItem
} = withInstall(Skeleton, {
  SkeletonItem,
})
export const ElSkeletonItem: SFCWithInstall<typeof SkeletonItem> =
  withNoopInstall(SkeletonItem)
export default ElSkeleton

export * from './src/skeleton.js'
export * from './src/skeleton-item.js'
