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
const setCoverButton = (wrapper: ReturnType<typeof mount>) => wrapper.find('[data-testid="wpe-set-cover"]');
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

describe("WpeWebPropertiesPanel 封面", () => {
  const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.5 };
  /** 预览传的两个 prop：画面确定在实时渲染 */
  const preview = {
    coverSource: (run: (value: typeof region) => Promise<unknown>) => run(region),
    coverReady: true,
  };

  it("coverSource 为 undefined（没有实时实例）时不显示", () => {
    const wrapper = mountPanel({ imageType: "x-wpe/scene", paused: false });
    expect(setCoverButton(wrapper).exists()).toBe(false);
    cover.custom = true;
    expect(restoreCoverButton(mountPanel({ imageType: "x-wpe/scene", paused: false })).exists()).toBe(false);
  });

  it("只在网页与场景上显示", () => {
    for (const imageType of ["x-wpe/web", "x-wpe/scene"]) {
      expect(setCoverButton(mountPanel({ imageType, ...preview })).exists()).toBe(true);
    }
    for (const imageType of ["x-wpe/video", "image/jpg", null]) {
      expect(setCoverButton(mountPanel({ imageType, ...preview })).exists()).toBe(false);
    }
  });

  it("coverReady 为假（还没出首帧或退回预览图）时不显示设为封面，已设的封面仍可恢复", () => {
    const props = { imageType: "x-wpe/scene", ...preview, coverReady: false };
    expect(setCoverButton(mountPanel(props)).exists()).toBe(false);
    expect(restoreCoverButton(mountPanel(props)).exists()).toBe(false);
    cover.custom = true;
    expect(setCoverButton(mountPanel(props)).exists()).toBe(false);
    expect(restoreCoverButton(mountPanel(props)).exists()).toBe(true);
  });

  it("没传 paused 时封面按钮单独显示，不带暂停与清空", () => {
    const wrapper = mountPanel({ imageType: "x-wpe/scene", ...preview });
    expect(controls(wrapper).exists()).toBe(true);
    expect(wrapper.find(".switch").exists()).toBe(false);
    expect(clearButton(wrapper).exists()).toBe(false);
  });

  it("customCover 决定恢复按钮", () => {
    const props = { imageType: "x-wpe/web", ...preview };
    expect(restoreCoverButton(mountPanel(props)).exists()).toBe(false);
    cover.custom = true;
    expect(restoreCoverButton(mountPanel(props)).exists()).toBe(true);
  });

  it("成功后 toast 并显示恢复按钮", async () => {
    const wrapper = mountPanel({ imageType: "x-wpe/scene", ...preview });
    invoke.mockImplementation(async () => {
      cover.custom = true;
      return "D:/data/thumbnails/a.jpg";
    });
    await setCoverButton(wrapper).trigger("click");
    await flushPromises();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("capture_wallpaper_cover", { imageId: "7", region });
    expect(success).toHaveBeenCalledWith("gallery.wpeSetCoverDone");
    expect(restoreCoverButton(wrapper).exists()).toBe(true);
  });

  it("预览由传入的函数包住命令，命令在回调里发出", async () => {
    const events: string[] = [];
    const coverSource = vi.fn(async (run: (value: typeof region) => Promise<unknown>) => {
      events.push("hide");
      const result = await run(region);
      events.push("restore");
      return result;
    });
    invoke.mockImplementation(async () => {
      events.push("invoke");
    });
    const wrapper = mountPanel({ imageType: "x-wpe/web", coverSource, coverReady: true });
    await setCoverButton(wrapper).trigger("click");
    await flushPromises();
    expect(events).toEqual(["hide", "invoke", "restore"]);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("capture_wallpaper_cover", { imageId: "7", region });
  });

  it("命令进行中不重复触发", async () => {
    let finish = () => {};
    invoke.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const wrapper = mountPanel({ imageType: "x-wpe/web", ...preview });
    await setCoverButton(wrapper).trigger("click");
    await setCoverButton(wrapper).trigger("click");
    expect(invoke).toHaveBeenCalledOnce();
    finish();
    await flushPromises();
    await setCoverButton(wrapper).trigger("click");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("设为封面失败时提示错误，恢复按钮不变", async () => {
    invoke.mockRejectedValue("CEF webview not found: main");
    const wrapper = mountPanel({ imageType: "x-wpe/web", ...preview });
    await setCoverButton(wrapper).trigger("click");
    await flushPromises();
    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith("gallery.wpeSetCoverFailed: CEF webview not found: main");
    expect(restoreCoverButton(wrapper).exists()).toBe(false);
  });

  it("量不到区域时提示错误，不发命令", async () => {
    const coverSource = () => Promise.reject(new Error("wallpaper canvas is not visible"));
    const wrapper = mountPanel({ imageType: "x-wpe/web", coverSource, coverReady: true });
    await setCoverButton(wrapper).trigger("click");
    await flushPromises();
    expect(invoke).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith("gallery.wpeSetCoverFailed: Error: wallpaper canvas is not visible");
  });

  it("恢复默认封面成功后隐藏恢复按钮", async () => {
    cover.custom = true;
    const wrapper = mountPanel({ imageType: "x-wpe/scene", ...preview });
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

  it("恢复失败时提示错误，恢复按钮还在", async () => {
    cover.custom = true;
    invoke.mockRejectedValue("image not found");
    const wrapper = mountPanel({ imageType: "x-wpe/scene", ...preview });
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

  it("父组件没传 paused 时面板拿到的仍是 undefined", () => {
    expect(controls(mountDialog({})).exists()).toBe(false);
  });

  it("透传 paused 与 update:paused", async () => {
    const wrapper = mountDialog({ paused: false });
    await wrapper.find(".switch").trigger("click");
    expect(wrapper.emitted("update:paused")).toEqual([[true]]);
  });

  it("设置页的弹窗没有封面按钮", () => {
    cover.custom = true;
    const wrapper = mountDialog({ paused: false });
    expect(setCoverButton(wrapper).exists()).toBe(false);
    expect(restoreCoverButton(wrapper).exists()).toBe(false);
    expect(clearButton(wrapper).exists()).toBe(true);
  });
});
