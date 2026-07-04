// Custom Modernizr build (webp + avif). Side-effect import attaches
// `Modernizr` to window. Async detects require `.on(feature, cb)`.
interface ModernizrStatic {
  webp: boolean;
  avif: boolean;
  on(feature: "webp" | "avif", cb: (result: boolean) => void): void;
}

declare global {
  interface Window {
    Modernizr: ModernizrStatic;
  }
}

export {};
