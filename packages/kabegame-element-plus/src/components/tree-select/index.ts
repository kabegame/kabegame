import { withInstall } from '@kabegame/element-plus/utils'
import TreeSelect from './src/tree-select.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElTreeSelect: SFCWithInstall<typeof TreeSelect> =
  withInstall(TreeSelect)

export default ElTreeSelect

export type { TreeSelectInstance } from './src/instance.js'
