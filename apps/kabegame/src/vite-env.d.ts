/// <reference types="vite/client" />
/// <reference path="./env.d.ts" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
