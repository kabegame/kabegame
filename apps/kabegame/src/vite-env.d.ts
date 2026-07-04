/// <reference types="vite/client" />
/// <reference path="../../../packages/kabegame-core/src/env.d.ts" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "element-plus/dist/locale/*.mjs" {
  const locale: any;
  export default locale;
}
