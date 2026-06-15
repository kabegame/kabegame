import { IS_WEB } from "../env";
import type { ImageInfo } from "../types/image";
import { trackEvent } from "./umami";

export function currentUrl(): string {
  return typeof location === "undefined" ? "" : location.pathname + location.search;
}

export function imageAnalyticsName(image: ImageInfo): string {
  const displayName = image.displayName?.trim();
  if (displayName) return displayName;
  const localName = (image.localPath || "").split(/[\\/]/).pop()?.trim();
  if (localName) return localName;
  const urlName = (image.url || "").split(/[\\/]/).pop()?.trim();
  return urlName || image.id;
}

export function imageAnalyticsItem(image: ImageInfo) {
  return {
    id: image.id,
    name: imageAnalyticsName(image),
    localPath: image.localPath,
  };
}

export function imageAnalyticsPayload(images: ImageInfo[]): Record<string, unknown> {
  const mode = images.length > 1 ? "batch" : "single";
  const base = {
    mode,
    count: images.length,
  };
  if (mode === "single") {
    const image = images[0];
    return {
      ...base,
      image: image
        ? imageAnalyticsItem(image)
        : null,
    };
  }
  return {
    ...base,
    images: images.map(imageAnalyticsItem),
  };
}

export interface ImageAnalytics {
  track(name: string, data?: Record<string, unknown>): void;
  trackAction(command: string, targets: ImageInfo[], data?: Record<string, unknown>): void;
  trackDoubleOpen(payload: { action: "preview" | "open"; image: ImageInfo }): void;
  trackPreviewNavigate(payload: {
    direction: "prev" | "next";
    fromIndex: number;
    toIndex: number;
    wrapped: boolean;
    image: ImageInfo;
  }): void;
  trackPreviewDetailToggle(payload: { open: boolean; image: ImageInfo | null }): void;
  trackPreviewClose(payload: { image: ImageInfo | null }): void;
}

export function createImageAnalytics(getContext: () => Record<string, unknown>): ImageAnalytics {
  function track(name: string, data: Record<string, unknown> = {}) {
    if (!IS_WEB) return;
    trackEvent(name, { ...getContext(), url: currentUrl(), ...data });
  }

  function trackAction(command: string, targets: ImageInfo[], data: Record<string, unknown> = {}) {
    track("image_action", { command, ...imageAnalyticsPayload(targets), ...data });
  }

  return {
    track,
    trackAction,
    trackDoubleOpen: (payload) => {
      track("image_double_open", {
        action: payload.action,
        ...imageAnalyticsPayload([payload.image]),
      });
    },
    trackPreviewNavigate: (payload) => {
      track("image_preview_navigate", {
        direction: payload.direction,
        fromIndex: payload.fromIndex,
        toIndex: payload.toIndex,
        wrapped: payload.wrapped,
        ...imageAnalyticsPayload([payload.image]),
      });
    },
    trackPreviewDetailToggle: (payload) => {
      track("image_preview_detail_toggle", {
        open: payload.open,
        ...imageAnalyticsPayload(payload.image ? [payload.image] : []),
      });
    },
    trackPreviewClose: (payload) => {
      track("image_preview_close", {
        ...imageAnalyticsPayload(payload.image ? [payload.image] : []),
      });
    },
  };
}
