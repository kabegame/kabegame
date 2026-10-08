// @vitest-environment happy-dom

import { shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KbNumber from "@/components/common/form/KbNumber.vue";
import WebServerSettingsPanel from "./WebServerSettingsPanel.vue";

const settings = vi.hoisted(() => ({ enabled: false, port: 7490, lanAccess: false }));
const setPort = vi.hoisted(() => vi.fn(async () => true));
const setLanAccess = vi.hoisted(() => vi.fn(async () => true));

const ElSwitchStub = {
  props: {
    modelValue: Boolean,
    loading: Boolean,
    disabled: Boolean,
    beforeChange: Function,
  },
  template: '<button class="el-switch-stub" :disabled="disabled"></button>',
};

vi.mock("@/composables/useSettingKeyState", () => ({
  useSettingKeyState: (key: string) => {
    if (key === "webServerEnabled") {
      return {
        settingValue: {
          get value() {
            return settings.enabled;
          },
        },
        set: vi.fn(async () => true),
      };
    }
    if (key === "webServerPort") {
      return {
        settingValue: {
          get value() {
            return settings.port;
          },
        },
        set: setPort,
      };
    }
    return {
      settingValue: {
        get value() {
          return settings.lanAccess;
        },
      },
      set: setLanAccess,
    };
  },
}));
vi.mock("@/api/rpc", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));
vi.mock("@/utils/kameMessage", () => ({
  kameMessage: { success: vi.fn(), error: vi.fn() },
}));

const wrappers: ReturnType<typeof shallowMount>[] = [];
function mountPanel() {
  const wrapper = shallowMount(WebServerSettingsPanel, {
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { "el-switch": ElSwitchStub },
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  settings.enabled = false;
  settings.port = 7490;
  settings.lanAccess = false;
  setPort.mockClear();
  setLanAccess.mockClear();
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WebServerSettingsPanel", () => {
  it("服务器关闭时允许修改端口与局域网访问", () => {
    const wrapper = mountPanel();

    expect(wrapper.findComponent(KbNumber).props("disabled")).toBe(false);
    expect(wrapper.findAllComponents(ElSwitchStub)[1]?.props("disabled")).toBe(false);
  });

  it("服务器开启时禁用端口与局域网访问修改", async () => {
    settings.enabled = true;
    const wrapper = mountPanel();
    const input = wrapper.findComponent(KbNumber);
    const lanSwitch = wrapper.findAllComponents(ElSwitchStub)[1]!;

    expect(input.props("disabled")).toBe(true);
    expect(lanSwitch.props("disabled")).toBe(true);
    await input.vm.$emit("change", 7599);
    expect(await (lanSwitch.props("beforeChange") as () => Promise<boolean>)()).toBe(false);
    expect(setPort).not.toHaveBeenCalled();
    expect(setLanAccess).not.toHaveBeenCalled();
  });
});
