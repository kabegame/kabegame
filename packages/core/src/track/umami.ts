// Why: umami 脚本在 index.html 中以 defer 方式加载并带 data-auto-track="false"，
// 所有埋点改由本模块统一触发，避免 auto-track 与手动 track 双计。
// IS_WEB gate: 如未来需要仅在 web 模式启用，在每个 export 函数首行加 `if (!IS_WEB) return;` 即可。

interface UmamiTrackProps {
  url?: string;
  referrer?: string;
  title?: string;
  hostname?: string;
  language?: string;
  screen?: string;
  name?: string;
  data?: Record<string, unknown>;
}

interface UmamiTracker {
  track(): Promise<string>;
  track(eventName: string, eventData?: Record<string, unknown>): Promise<string>;
  track(props: UmamiTrackProps): Promise<string>;
  track(props: (defaultProps: UmamiTrackProps) => UmamiTrackProps): Promise<string>;
  identify(sessionData?: Record<string, unknown>): Promise<string>;
  identify(id: string, sessionData?: Record<string, unknown>): Promise<string>;
}

declare global {
  interface Window {
    umami?: UmamiTracker;
  }
}

let lastTrackedUrl: string | null = null;

export function trackPage(url?: string, referrer?: string): void {
  const umami = window.umami;
  if (!umami) return;
  const resolvedUrl = url ?? location.pathname + location.search;
  const resolvedReferrer = referrer ?? lastTrackedUrl ?? document.referrer;
  // Why callback form: object form sends payload as-is, skipping the website-id merge.
  // Callback form receives the default payload (website, hostname, etc.) and lets us patch url/referrer.
  void umami.track((props) => ({ ...props, url: resolvedUrl, referrer: resolvedReferrer }));
  lastTrackedUrl = resolvedUrl;
}

export function trackEvent(name: string, data?: Record<string, unknown>): void {
  const umami = window.umami;
  if (!umami) return;
  void umami.track(name, data);
}

export function identify(idOrData: string | Record<string, unknown>, sessionData?: Record<string, unknown>): void {
  const umami = window.umami;
  if (!umami) return;
  if (typeof idOrData === "string") {
    void umami.identify(idOrData, sessionData);
  } else {
    void umami.identify(idOrData);
  }
}
