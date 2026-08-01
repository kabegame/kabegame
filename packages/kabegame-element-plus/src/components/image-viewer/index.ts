import { withInstall } from '@kabegame/element-plus/utils'
import ImageViewer from './src/image-viewer.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElImageViewer: SFCWithInstall<typeof ImageViewer> =
  withInstall(ImageViewer)
export default ElImageViewer

export * from './src/image-viewer.js'
