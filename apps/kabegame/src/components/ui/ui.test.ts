// @vitest-environment happy-dom
/**
 * 新界面组件的行为测试：对话框的 Esc / Android 返回栈、提示消息门面、确认框门面、加载指令与混用期垫片。
 * 外观在 dev 的 /dev/ui 陈列页里人工对照，这里只测行为。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref, withDirectives } from "vue";

const epConfirm = vi.hoisted(() => vi.fn());
vi.mock("@kabegame/element-plus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kabegame/element-plus")>()),
  ElMessageBox: { confirm: epConfirm },
}));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// Android：useModalBack 只在 Android 上接返回栈
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/env")>()),
  IS_ANDROID: true,
}));

import Dialog from "./Dialog.vue";
import { useModalStackStore } from "@/stores/modalStack";
import { closeToast, toast, toastEntries } from "./toast";
import { messageBox } from "./messageBox";
import { vLoading } from "./loading";
import { foreignPortalTarget, keepOpenOnForeign, nextLayerZIndex } from "./compat";

const wrappers: { unmount: () => void }[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  for (const e of [...toastEntries]) closeToast(e.id);
  toastEntries.splice(0);
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function mountDialog() {
  const open = ref(false);
  const Host = defineComponent({
    setup: () => () =>
      h(
        Dialog,
        { open: open.value, "onUpdate:open": (v: boolean) => (open.value = v), title: "标题" },
        { default: () => h("input", { class: "body-input" }) },
      ),
  });
  const wrapper = mount(Host, { attachTo: document.body });
  wrappers.push(wrapper);
  return { open, wrapper };
}

describe("Dialog", () => {
  it("打开时渲染到 body、聚焦正文里的第一个输入框，Esc 关闭", async () => {
    const { open } = mountDialog();
    open.value = true;
    await flushPromises();
    await nextTick();
    const content = document.querySelector<HTMLElement>("[data-kb-trap]");
    expect(content).not.toBeNull();
    expect(content!.textContent).toContain("标题");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(open.value).toBe(false);
  });

  it("Android：打开占一个返回栈位，返回键（closeTop）关闭并释放", async () => {
    const { open } = mountDialog();
    const stack = useModalStackStore();
    open.value = true;
    await flushPromises();
    expect(stack.slots).toHaveLength(1);
    await stack.closeTop();
    await flushPromises();
    expect(open.value).toBe(false);
    expect(stack.slots).toHaveLength(0);
  });

  it("每次打开都向全局计数器取一个更高的层级", async () => {
    const { open } = mountDialog();
    open.value = true;
    await flushPromises();
    const first = Number(document.querySelector<HTMLElement>("[data-kb-trap]")!.style.zIndex);
    expect(first).toBeGreaterThan(3000);
    expect(nextLayerZIndex()).toBeGreaterThan(first);
  });
});

describe("toast", () => {
  it("签名与 ElMessage 相同：字符串、对象、各类型；duration 0 不自动关", () => {
    toast("普通");
    toast.success("成功");
    toast({ type: "warning", message: "警告", duration: 0 });
    toast.error(new Error("出错了"));
    expect(toastEntries.map((e) => [e.type, e.text])).toEqual([
      ["info", "普通"],
      ["success", "成功"],
      ["warning", "警告"],
      ["error", "出错了"],
    ]);
    expect(toastEntries[2].duration).toBe(Number.POSITIVE_INFINITY);
    expect(toastEntries[0].duration).toBe(3000);
  });

  it("同类型同文字只留最新一条；最多同时 4 条；closeAll 全关", () => {
    toast.info("同一条");
    toast.info("同一条");
    expect(toastEntries.filter((e) => e.open && e.text === "同一条")).toHaveLength(1);
    for (let i = 0; i < 5; i++) toast.info(`第 ${i} 条`);
    expect(toastEntries.filter((e) => e.open)).toHaveLength(4);
    toast.closeAll();
    expect(toastEntries.filter((e) => e.open)).toHaveLength(0);
  });

  it("关闭的条目在动画后移出列表", () => {
    vi.useFakeTimers();
    const handle = toast.success("x");
    handle.close();
    expect(toastEntries).toHaveLength(1);
    vi.advanceTimersByTime(400);
    expect(toastEntries).toHaveLength(0);
  });
});

describe("messageBox", () => {
  it("参数原样转给 ElMessageBox，结果原样返回", async () => {
    epConfirm.mockReset().mockResolvedValue("confirm");
    await expect(messageBox.confirm("正文", "标题", { type: "warning" })).resolves.toBe("confirm");
    expect(epConfirm).toHaveBeenCalledExactlyOnceWith("正文", "标题", { type: "warning" });
    epConfirm.mockRejectedValue("cancel");
    await expect(messageBox.confirm("正文")).rejects.toBe("cancel");
  });

  it("有新模态层时，确认框存在期间暂停 Reka 的焦点陷阱，结束后撤掉", async () => {
    const marker = document.createElement("div");
    marker.setAttribute("data-kb-trap", "");
    document.body.appendChild(marker);
    let pausedDuringCall = false;
    epConfirm.mockReset().mockImplementation(async () => {
      pausedDuringCall = !!document.querySelector("[data-kb-focus-pause]");
      return "confirm";
    });
    await messageBox.confirm("正文");
    expect(pausedDuringCall).toBe(true);
    expect(document.querySelector("[data-kb-focus-pause]")).toBeNull();
  });
});

describe("v-loading", () => {
  it("开时挂遮罩、static 宿主临时改成 relative；关时遮罩消失，卸载还原", async () => {
    const busy = ref(false);
    const Root = defineComponent({
      setup: () => () => withDirectives(h("div", { class: "host" }, [h("span", "内容")]), [[vLoading, busy.value]]),
    });
    const wrapper = mount(Root, { attachTo: document.body });
    wrappers.push(wrapper);
    const host = wrapper.element as HTMLElement;
    expect(host.querySelector("[data-kb-loading]")).toBeNull();
    busy.value = true;
    await nextTick();
    expect(host.querySelector("[data-kb-loading] svg[role=status]")).not.toBeNull();
    expect(host.style.position).toBe("relative");
    busy.value = false;
    await nextTick();
    await new Promise((r) => setTimeout(r, 200));
    expect(host.querySelector("[data-kb-loading] svg")).toBeNull();
  });
});

describe("混用期垫片", () => {
  it("点到 EP 浮层或提示消息时不关新层；点到别处照常", () => {
    const popper = document.createElement("div");
    popper.className = "el-popper";
    const inner = document.createElement("span");
    popper.appendChild(inner);
    document.body.appendChild(popper);
    const fromPopper = new CustomEvent("x", { cancelable: true, detail: { originalEvent: { target: inner } } });
    keepOpenOnForeign(fromPopper as unknown as Event);
    expect(fromPopper.defaultPrevented).toBe(true);
    const elsewhere = new CustomEvent("x", { cancelable: true, detail: { originalEvent: { target: document.body } } });
    keepOpenOnForeign(elsewhere as unknown as Event);
    expect(elsewhere.defaultPrevented).toBe(false);
  });

  it("触发器在 EP 对话框里时浮层挂进那个对话框", () => {
    const dialog = document.createElement("div");
    dialog.className = "el-dialog";
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    expect(foreignPortalTarget(button)).toBe(dialog);
    expect(foreignPortalTarget(document.body)).toBeUndefined();
  });
});
