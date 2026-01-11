/// <reference types="vite/client" />

declare module "*.vue" {
  const component: import("vue").DefineComponent<{}, {}, any>;
  export default component;
}

// monaco-editor (ESM) workers with Vite `?worker` suffix
declare module "monaco-editor/esm/vs/editor/editor.worker?worker" {
  const worker: {
    new (): Worker;
  };
  export default worker;
}

declare module "monaco-editor/esm/vs/language/json/json.worker?worker" {
  const worker: {
    new (): Worker;
  };
  export default worker;
}

// monaco-themes: JSON themes (Monaco defineTheme-compatible)
declare module "monaco-themes/themes/*.json" {
  const theme: any;
  export default theme;
}