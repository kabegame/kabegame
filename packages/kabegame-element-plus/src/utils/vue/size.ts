import { componentSizeMap } from '@kabegame/element-plus/constants'

import type { ComponentSize } from '@kabegame/element-plus/constants'

export const getComponentSize = (size?: ComponentSize) => {
  return componentSizeMap[size || 'default']
}
