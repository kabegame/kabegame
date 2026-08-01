import { ElInfiniteScroll } from '@kabegame/element-plus/components/infinite-scroll'
import { ElLoading } from '@kabegame/element-plus/components/loading'
import { ElMessage } from '@kabegame/element-plus/components/message'
import { ElMessageBox } from '@kabegame/element-plus/components/message-box'
import { ElNotification } from '@kabegame/element-plus/components/notification'
import { ElPopoverDirective } from '@kabegame/element-plus/components/popover'

import type { Plugin } from 'vue'

export default [
  ElInfiniteScroll,
  ElLoading,
  ElMessage,
  ElMessageBox,
  ElNotification,
  ElPopoverDirective,
] as Plugin[]
