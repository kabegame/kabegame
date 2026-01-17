/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare const __DEV__: boolean;
declare const __WINDOWS__: boolean;
declare const __DESKTOP__: string;
