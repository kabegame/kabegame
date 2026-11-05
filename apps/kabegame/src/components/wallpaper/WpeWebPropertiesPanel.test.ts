// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { ref, shallowRef } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WpeWebPropertiesDialog from "./WpeWebPropertiesDialog.vue";
import WpeWebPropertiesPanel from "./WpeWebPropertiesPanel.vue";

const confirm = vi.hoisted(() => vi.fn());
const success = vi.hoisted(() => vi.fn());
const failure = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@kabegame/element-plus", () => ({
  ElMessage: { success, error: failure },
  ElMessageBox: { confirm },
}));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/api", () => ({ invoke }));
vi.mock("@/composables/useModalBack", () => ({ useModalBack: () => {} }));
// 作者属性为空：控制卡片不依赖它们
vi.mock("@/composables/useWpeWebProperties", () => ({
  useWpeWebProperties: () => ({
    view: shallowRef({ imageId: "7", metadataId: null, items: [] }),
    loading: ref(false),
    error: ref(null),
    valueOf: () => undefined,
    isModified: () => false,
    set: () => {},
    reset: () => {},
    resetAll: () => {},
    reload: () => {},
  }),
}));

const ElSwitchStub = {
  props: { modelValue: Boolean },
  emits: ["update:modelValue"],
  template: `<button class="switch" @click="$emit('update:modelValue', !modelValue)">{{ modelValue }}</button>`,
};
const global = {
  components: {
    ElSwitch: ElSwitchStub,
    ElButton: { template: "<button @click=\"$emit('click')\"><slot /></button>", emits: ["click"] },
    ElIcon: { template: "<i><slot /></i>" },
  },
  stubs: {
    CollapsibleDrawerPanel: { template: '<div><slot name="trailing" /><slot /></div>' },
    WpePropertyField: true,
  },
};

const wrappers: ReturnType<typeof mount>[] = [];

function mountPanel(props: Record<string, unknown>) {
  const wrapper = mount(WpeWebPropertiesPanel, { props: { imageId: "7", ...props } as never, global });
  wrappers.push(wrapper);
  return wrapper;
}

const clearButton = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-testid="wpe-clear-storage"]');
const controls = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-testid="wpe-controls"]');

beforeEach(() => {
  confirm.mockReset().mockResolvedValue("confirm");
  invoke.mockReset().mockResolvedValue(undefined);
  success.mockReset();
  failure.mockReset();
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WpeWebPropertiesPanel 控制卡片", () => {
  it("没传 paused（没有实时实例）时不显示控制项", () => {
    const wrapper = mountPanel({ imageType: "x-wpe/scene" });
    expect(controls(wrapper).exists()).toBe(false);
    expect(clearButton(wrapper).exists()).toBe(false);
  });

  it("显式传 undefined 同样不显示", () => {
    expect(controls(mountPanel({ imageType: "x-wpe/scene", paused: undefined })).exists()).toBe(false);
  });

  it("作者属性为空时也显示；网页壁纸没有清空按钮", () => {
    const wrapper = mountPanel({ imageType: "x-wpe/web", paused: false });
    expect(controls(wrapper).exists()).toBe(true);
    expect(wrapper.text()).toContain("gallery.wpePropsEmpty");
    expect(clearButton(wrapper).exists()).toBe(false);
  });

  it("场景壁纸显示清空按钮", () => {
    expect(clearButton(mountPanel({ imageType: "x-wpe/scene", paused: true })).exists()).toBe(true);
  });

  it("开关发 update:paused，当前值由父组件传入", async () => {
    const wrapper = mountPanel({ imageType: "x-wpe/web", paused: false });
    await wrapper.find(".switch").trigger("click");
    expect(wrapper.emitted("update:paused")).toEqual([[true]]);
    await wrapper.setProps({ paused: true });
    await wrapper.find(".switch").trigger("click");
    expect(wrapper.emitted("update:paused")).toEqual([[true], [false]]);
  });

  it("取消确认时不调命令", async () => {
    confirm.mockRejectedValue("cancel");
    const wrapper = mountPanel({ imageType: "x-wpe/scene", paused: false });
    await clearButton(wrapper).trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it("确认后调命令，成功 toast", async () => {
    const wrapper = mountPanel({ imageType: "x-wpe/scene", paused: false });
    await clearButton(wrapper).trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("wpe_scene_clear_storage", { imageId: "7" });
    expect(success).toHaveBeenCalledWith("gallery.wpeClearStorageDone");
  });

  it("命令失败时报错，不报成功", async () => {
    invoke.mockRejectedValue("not a scene wallpaper in the library");
    const wrapper = mountPanel({ imageType: "x-wpe/scene", paused: false });
    await clearButton(wrapper).trigger("click");
    await flushPromises();
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith("gallery.wpeClearStorageFailed: not a scene wallpaper in the library");
  });
});

describe("WpeWebPropertiesDialog 透传", () => {
  function mountDialog(props: Record<string, unknown>) {
    const wrapper = mount(WpeWebPropertiesDialog, {
      props: { modelValue: true, imageId: "7", imageType: "x-wpe/scene", ...props } as never,
      global: {
        ...global,
        components: { ...global.components, ElDialog: { template: "<div><slot /></div>" } },
      },
    });
    wrappers.push(wrapper);
    return wrapper;
  }

  it("父组件没传 paused 时面板拿到的仍是 undefined", () => {
    expect(controls(mountDialog({})).exists()).toBe(false);
  });

  it("透传 paused 与 update:paused", async () => {
    const wrapper = mountDialog({ paused: false });
    await wrapper.find(".switch").trigger("click");
    expect(wrapper.emitted("update:paused")).toEqual([[true]]);
  });
});
