import { withInstall } from '@kabegame/element-plus/utils'
import InputOtp from './src/input-otp.vue'

import type { SFCWithInstall } from '@kabegame/element-plus/utils'

export const ElInputOtp: SFCWithInstall<typeof InputOtp> = withInstall(InputOtp)
export default ElInputOtp

export * from './src/input-otp.js'
export type { InputOtpInstance } from './src/instance.js'
