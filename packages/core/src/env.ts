export const IS_WINDOWS = __WINDOWS__;
export const IS_LINUX = __LINUX__;
export const IS_MACOS = __MACOS__;
export const IS_ANDROID = __ANDROID__;
export const IS_DEV = __DEV__;
// 从 __DESKTOP__ 常量计算 IS_PLASMA
export const IS_PLASMA = __DESKTOP__ === "plasma";
export const IS_GNOME = __DESKTOP__ === "gnome";
export const IS_LIGHT_MODE = __LIGHT_MODE__;
export const IS_LOCAL_MODE = __LOCAL_MODE__;
