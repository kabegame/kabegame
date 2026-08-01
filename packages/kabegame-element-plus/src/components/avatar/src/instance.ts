import type Avatar from './avatar.vue'
import type AvatarGroup from './avatar-group.tsx'

export type AvatarInstance = InstanceType<typeof Avatar> & unknown
export type AvatarGroupInstance = InstanceType<typeof AvatarGroup> & unknown
