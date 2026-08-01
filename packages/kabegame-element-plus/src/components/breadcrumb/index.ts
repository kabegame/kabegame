import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Breadcrumb from './src/breadcrumb.vue'
import BreadcrumbItem from './src/breadcrumb-item.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElBreadcrumb: SFCWithInstall<typeof Breadcrumb> & {
  BreadcrumbItem: typeof BreadcrumbItem
} = withInstall(Breadcrumb, {
  BreadcrumbItem,
})
export const ElBreadcrumbItem: SFCWithInstall<typeof BreadcrumbItem> =
  withNoopInstall(BreadcrumbItem)
export default ElBreadcrumb

export * from './src/breadcrumb.js'
export * from './src/breadcrumb-item.js'
export * from './src/constants.js'
export type {
  BreadcrumbInstance,
  BreadcrumbItemInstance,
} from './src/instances.js'
