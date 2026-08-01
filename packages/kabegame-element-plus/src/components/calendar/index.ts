import { withInstall } from '@kabegame/element-plus/utils'
import Calendar from './src/calendar.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElCalendar: SFCWithInstall<typeof Calendar> = withInstall(Calendar)
export default ElCalendar

export * from './src/calendar.js'
export type {
  CalendarDateTableInstance,
  DateTableInstance,
  CalendarInstance,
} from './src/instance.js'
