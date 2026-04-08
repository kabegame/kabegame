import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { ImageFormat, ImageSupportResult } from "@kabegame/image-type";
import "../vendor/modernizr.js";

function waitModernizr(feature: "webp" | "avif"): Promise<boolean> {
  return new Promise((resolve) => {
    const M = window.Modernizr;
    if (!M) return resolve(false);
    // Async detects: property may already be set, or arrive via .on()
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(!!v);
    };
    try {
      M.on(feature, done);
    } catch {
      // ignore
    }
    // Fallback: if detect ran synchronously already
    if (typeof (M as unknown as Record<string, unknown>)[feature] === "boolean") {
      done((M as unknown as Record<string, boolean>)[feature]);
    }
    // Safety timeout
    setTimeout(() => done(false), 2000);
  });
}

async function detectViaModernizr(): Promise<ImageSupportResult> {
  if (typeof window === "undefined") {
    return { webp: false, avif: false, heic: false };
  }
  const [webp, avif] = await Promise.all([
    waitModernizr("webp"),
    waitModernizr("avif"),
  ]);
  return { webp, avif, heic: false };
}

function toFormats(r: ImageSupportResult): ImageFormat[] {
  const list: ImageFormat[] = [];
  if (r.webp) list.push("webp");
  if (r.avif) list.push("avif");
  return list;
}

export const useImageSupportStore = defineStore("imageSupport", () => {
  const support = ref<ImageSupportResult | null>(null);
  const formats = ref<ImageFormat[]>([]);
  const ready = ref(false);
  const detecting = ref(false);

  let pending: Promise<void> | null = null;

  const webp = computed(() => support.value?.webp ?? false);
  const avif = computed(() => support.value?.avif ?? false);
  const heic = computed(() => support.value?.heic ?? false);

  async function mergeDetect(): Promise<ImageSupportResult> {
    const first = await detectViaModernizr();
    if (first.webp || first.avif) return first;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => setTimeout(() => resolve(), 300));
    });
    const second = await detectViaModernizr();
    return {
      webp: first.webp || second.webp,
      avif: first.avif || second.avif,
      heic: false,
    };
  }

  async function detect(): Promise<void> {
    if (ready.value) return;
    if (pending) return pending;

    const run = (async () => {
      detecting.value = true;
      try {
        const merged = await mergeDetect();
        support.value = merged;
        const list = toFormats(merged);
        formats.value = list;
        console.log("[image-support] detected", merged);
        console.log("[image-support] report formats", list);
        try {
          await invoke("set_supported_image_formats", { formats: list });
          console.log("[image-support] set_supported_image_formats success");
        } catch (e) {
          console.warn("[image-support] set_supported_image_formats failed", e);
        }
        ready.value = true;
      } finally {
        detecting.value = false;
      }
    })();

    pending = run.finally(() => {
      pending = null;
    });

    return pending;
  }

  async function redetect(): Promise<void> {
    if (pending) await pending;
    support.value = null;
    formats.value = [];
    ready.value = false;
    return detect();
  }

  async function ensure(): Promise<void> {
    if (ready.value) return;
    await detect();
  }

  return {
    support,
    formats,
    ready,
    detecting,
    webp,
    avif,
    heic,
    detect,
    redetect,
    ensure,
  };
});
