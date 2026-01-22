declare const __WINDOWS__: boolean;
declare const __DEV__: boolean;
declare const __DESKTOP__: string;
declare const __LIGHT_MODE__: boolean;
declare const __LOCAL_MODE__: boolean;

export const IS_WINDOWS = __WINDOWS__;
export const IS_DEV = __DEV__;
// 从 __DESKTOP__ 常量计算 IS_PLASMA
export const IS_PLASMA = __DESKTOP__ === "plasma";
export const IS_LIGHT_MODE = __LIGHT_MODE__;
export const IS_LOCAL_MODE = __LOCAL_MODE__;
