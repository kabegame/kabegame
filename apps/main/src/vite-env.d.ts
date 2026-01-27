/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare const __DEV__: boolean;
declare const __WINDOWS__: boolean;
declare const __LINUX__: boolean;
declare const __DESKTOP__: string;
declare const __LIGHT_MODE__: boolean;
declare const __LOCAL_MODE__: boolean;
