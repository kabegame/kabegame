// @vitest-environment happy-dom
import { shallowMount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebpageCollectDialog from "./WebpageCollectDialog.vue";

const env = vi.hoisted(() => ({ android: false }));
const enqueueTask = vi.hoisted(() => vi.fn(async (_params: Record<string, any>) => true));

vi.mock("@kabegame/core/env", () => ({
  get IS_ANDROID() {
    return env.android;
  },
  IS_WEB: false,
}));
vi.mock("@kabegame/core/stores/ui", () => ({ useUiStore: () => ({ isCompact: false }) }));
vi.mock("@kabegame/core/composables/useModal", () => ({
  useModal: () => {
    const isOpen = ref(false);
    return { isOpen, zIndex: ref(2000), open: () => (isOpen.value = true), close: () => (isOpen.value = false) };
  },
}));
vi.mock("@kabegame/i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: { value: "zh" } }),
  usePluginConfigI18n: () => ({
    varDisplayName: (def: { key: string }) => def.key,
    varDescripts: () => "",
  }),
}));
vi.mock("@kabegame/core/utils/kameMessage", () => ({
  kameMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@kabegame/core/track/umami", () => ({ trackEvent: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/utils/desktopOnlyGuard", () => ({ guardDesktopOnly: vi.fn(async () => false) }));
vi.mock("@/composables/useCrawlTaskLauncher", () => ({ enqueueTask }));
vi.mock("@/stores/albums", () => ({
  FAVORITE_ALBUM_ID: "fav",
  HIDDEN_ALBUM_ID: "hidden",
  useAlbumStore: () => ({
    albumCounts: {},
    getAlbumTreeExcluding: () => [],
    loadAlbums: async () => {},
    createAlbum: vi.fn(),
  }),
}));

// 与 Rust builtin `webpage` 下发给前端的 config.vars 同形
const webpageVars = [
  { key: "url", type: "string", name: { default: "Full URL" } },
  {
    key: "backend",
    type: "options",
    default: "v8",
    name: { default: "Backend" },
    options: [
      { variable: "v8", name: { default: "V8" } },
      { variable: "webview", name: { default: "WebView" } },
    ],
  },
  { key: "injectSurfCookie", type: "boolean", default: true, when: { backend: ["v8"] }, name: { default: "Cookie" } },
  { key: "injectCefUserAgent", type: "boolean", default: true, when: { backend: ["v8"] }, name: { default: "UA" } },
];
vi.mock("@/stores/plugins", () => ({
  usePluginStore: () => ({ plugins: [{ id: "webpage", scriptType: "builtin", config: { vars: webpageVars } }] }),
}));

type Exposed = {
  form: { url: string; outputDir: string; vars: Record<string, any> };
  headers: Record<string, string>;
  urlError: string | null;
  visibleVarDefs: Array<{ key: string; options?: Array<{ variable: string }> }>;
  handleSubmit: () => Promise<void>;
};

const wrappers: ReturnType<typeof shallowMount>[] = [];
async function open(): Promise<Exposed> {
  const wrapper = shallowMount(WebpageCollectDialog, {
    props: { modelValue: true },
    global: { plugins: [createPinia()], mocks: { $t: (key: string) => key } },
  });
  wrappers.push(wrapper);
  await nextTick();
  return wrapper.vm as unknown as Exposed;
}

beforeEach(() => {
  enqueueTask.mockClear();
  env.android = false;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WebpageCollectDialog", () => {
  it("submits V8 tasks with headers and the injection switches on by default", async () => {
    const vm = await open();
    expect(vm.form.vars).toMatchObject({ backend: "v8", injectSurfCookie: true, injectCefUserAgent: true });
    vm.form.url = "  https://example.com/gallery?p=2 ";
    vm.headers = { Referer: "https://example.com/" };
    await vm.handleSubmit();

    expect(enqueueTask).toHaveBeenCalledTimes(1);
    expect(enqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "webpage",
        userConfig: {
          url: "https://example.com/gallery?p=2",
          backend: "v8",
          injectSurfCookie: true,
          injectCefUserAgent: true,
        },
        httpHeaders: { Referer: "https://example.com/" },
        triggerSource: "manual",
      }),
    );
  });

  it("forces empty headers and drops V8-only switches for WebView tasks", async () => {
    const vm = await open();
    vm.form.url = "https://example.com/";
    vm.headers = { Cookie: "draft-from-v8" };
    vm.form.vars.backend = "webview";
    await nextTick();
    expect(vm.visibleVarDefs.map((def) => def.key)).toEqual(["backend"]);
    await vm.handleSubmit();

    const params = enqueueTask.mock.calls[0]![0];
    expect(params.httpHeaders).toEqual({});
    expect(params.userConfig).toEqual({ url: "https://example.com/", backend: "webview" });
  });

  it("keeps the dialog and shows the reason for an invalid URL", async () => {
    const vm = await open();
    vm.form.url = "https://user:pw@example.com/";
    await vm.handleSubmit();
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(vm.urlError).toBe("credentials");
  });

  it("offers only the V8 backend on Android", async () => {
    env.android = true;
    const vm = await open();
    expect(vm.visibleVarDefs.map((def) => def.key)).toEqual(["backend"]);
    expect(vm.visibleVarDefs[0]!.options!.map((opt) => opt.variable)).toEqual(["v8"]);
  });
});
