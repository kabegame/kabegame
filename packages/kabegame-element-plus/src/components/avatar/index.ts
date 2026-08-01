import { withInstall, withNoopInstall } from '@kabegame/element-plus/utils'
import Avatar from './src/avatar.vue'
import AvatarGroup from './src/avatar-group.jsx'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElAvatar: SFCWithInstall<typeof Avatar> & {
  AvatarGroup: typeof AvatarGroup
} = withInstall(Avatar, {
  AvatarGroup,
})
export const ElAvatarGroup: SFCWithInstall<typeof AvatarGroup> =
  withNoopInstall(AvatarGroup)
export default ElAvatar

export * from './src/avatar.js'
export * from './src/constants.js'
export * from './src/avatar-group-props.js'
export type { AvatarInstance, AvatarGroupInstance } from './src/instance.js'
