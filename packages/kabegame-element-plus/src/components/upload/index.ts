import { withInstall } from '@kabegame/element-plus/utils'
import Upload from './src/upload.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElUpload: SFCWithInstall<typeof Upload> = withInstall(Upload)
export default ElUpload

export * from './src/upload.js'
export * from './src/upload-content.js'
export * from './src/upload-list.js'
export * from './src/upload-dragger.js'
export * from './src/constants.js'
