import { withInstall } from '@kabegame/element-plus/utils'
import Autocomplete from './src/autocomplete.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElAutocomplete: SFCWithInstall<typeof Autocomplete> =
  withInstall(Autocomplete)

export default ElAutocomplete

export * from './src/autocomplete.js'
