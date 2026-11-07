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
/** 后端的 `customCover`：面板挂载时与 `reload` 时读取 */
const cover = vi.hoisted(() => ({ custom: false }));

vi.mock("@kabegame/element-plus", () => ({
  ElMessage: { success, error: failure },
  ElMessageBox: { confirm },
}));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/api", () => ({ invoke }));
vi.mock("@/composables/useModalBack", () => ({ useModalBack: () => {} }));
// 作者属性为空：控制卡片不依赖它们
vi.mock("@/composables/useWpeWebProperties", () => ({
  useWpeWebProperties: () => {
    const read = () => ({ imageId: "7", metadataId: null, customCover: cover.custom, items: [] });
    const view = shallowRef(read());
    return {
      view,
      loading: ref(false),
      error: ref(null),
      valueOf: () => undefined,
      isModified: () => false,
      set: () => {},
      reset: () => {},
      resetAll: () => {},
      reload: () => {
        view.value = read();
      },
    };
  },
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
const restoreCoverButton = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-testid="wpe-restore-cover"]');

beforeEach(() => {
  confirm.mockReset().mockResolvedValue("confirm");
  invoke.mockReset().mockResolvedValue(undefined);
  success.mockReset();
  failure.mockReset();
  cover.custom = false;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("WpeWebPropertiesPanel 只管作者属性", () => {
  it("没有暂停开关与清空脚本存储；没设过封面时不出控制卡片", () => {
    for (const imageType of ["x-wpe/web", "x-wpe/scene"]) {
      const wrapper = mountPanel({ imageType, restorableCover: true });
      expect(controls(wrapper).exists()).toBe(false);
      expect(wrapper.find(".switch").exists()).toBe(false);
      expect(clearButton(wrapper).exists()).toBe(false);
      expect(wrapper.text()).toContain("gallery.wpePropsEmpty");
    }
  });
});

describe("WpeWebPropertiesPanel 恢复默认封面", () => {
  it("没传 restorableCover（设置页、没有实时实例）时不显示", () => {
    cover.custom = true;
    expect(restoreCoverButton(mountPanel({ imageType: "x-wpe/scene" })).exists()).toBe(false);
  });

  it("只在网页与场景上、设过封面时显示", () => {
    cover.custom = true;
    for (const imageType of ["x-wpe/web", "x-wpe/scene"]) {
      expect(restoreCoverButton(mountPanel({ imageType, restorableCover: true })).exists()).toBe(true);
    }
    for (const imageType of ["x-wpe/video", "image/jpg", null]) {
      expect(restoreCoverButton(mountPanel({ imageType, restorableCover: true })).exists()).toBe(false);
    }
  });

  it("customCover 决定恢复按钮；没有时整张控制卡片不出现", () => {
    const wrapper = mountPanel({ imageType: "x-wpe/web", restorableCover: true });
    expect(restoreCoverButton(wrapper).exists()).toBe(false);
    expect(controls(wrapper).exists()).toBe(false);
    cover.custom = true;
    expect(restoreCoverButton(mountPanel({ imageType: "x-wpe/web", restorableCover: true })).exists()).toBe(true);
  });

  it("恢复默认封面成功后隐藏恢复按钮", async () => {
    cover.custom = true;
    const wrapper = mountPanel({ imageType: "x-wpe/scene", restorableCover: true });
    invoke.mockImplementation(async () => {
      cover.custom = false;
      return "D:/workshop/1/preview.gif";
    });
    await restoreCoverButton(wrapper).trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("restore_wallpaper_cover", { imageId: "7" });
    expect(success).toHaveBeenCalledWith("gallery.wpeRestoreCoverDone");
    expect(restoreCoverButton(wrapper).exists()).toBe(false);
  });

  it("恢复进行中不重复触发", async () => {
    cover.custom = true;
    let finish = () => {};
    invoke.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const wrapper = mountPanel({ imageType: "x-wpe/web", restorableCover: true });
    await restoreCoverButton(wrapper).trigger("click");
    await restoreCoverButton(wrapper).trigger("click");
    expect(invoke).toHaveBeenCalledOnce();
    finish();
    await flushPromises();
  });

  it("恢复失败时提示错误，恢复按钮还在", async () => {
    cover.custom = true;
    invoke.mockRejectedValue("image not found");
    const wrapper = mountPanel({ imageType: "x-wpe/scene", restorableCover: true });
    await restoreCoverButton(wrapper).trigger("click");
    await flushPromises();
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith("gallery.wpeRestoreCoverFailed: image not found");
    expect(restoreCoverButton(wrapper).exists()).toBe(true);
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

  it("设置页的弹窗只有作者属性：没有暂停、清空脚本存储和封面按钮", () => {
    cover.custom = true;
    const wrapper = mountDialog({});
    expect(controls(wrapper).exists()).toBe(false);
    expect(wrapper.find(".switch").exists()).toBe(false);
    expect(clearButton(wrapper).exists()).toBe(false);
    expect(restoreCoverButton(wrapper).exists()).toBe(false);
  });
});
