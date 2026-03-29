/** Vite `?raw`：将资源以字符串导入（core 不依赖 vite 包时由此处提供类型） */
declare module "*?raw" {
  const src: string;
  export default src;
}

declare const __WINDOWS__: boolean;
declare const __LINUX__: boolean;
declare const __MACOS__: boolean;
declare const __ANDROID__: boolean;
declare const __DEV__: boolean;
declare const __LIGHT_MODE__: boolean;

