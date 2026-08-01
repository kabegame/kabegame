import { withInstall } from '@kabegame/element-plus/utils'
import Image from './src/image.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElImage: SFCWithInstall<typeof Image> = withInstall(Image)
export default ElImage

export * from './src/image.js'
