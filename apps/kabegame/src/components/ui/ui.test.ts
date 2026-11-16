// @vitest-environment happy-dom
/**
 * 组件的行为测试：对话框的 Esc / Android 返回栈、提示消息门面、确认框门面、加载指令、层级工具、滚轮选择与翻页。
 * 外观在 dev 的 /dev/ui 陈列页里人工对照，这里只测行为。
 */
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, effectScope, h, nextTick, ref, withDirectives } from "vue";

vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
// Android：useModalBack 只在 Android 上接返回栈
vi.mock("@/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/env")>()),
  IS_ANDROID: true,
}));

import Dialog from "./Dialog.vue";
import MessageBoxHost from "./MessageBoxHost.vue";
import PickerSheet, { type PickerOption } from "./PickerSheet.vue";
import Paginator from "./Paginator.vue";
import { useModalStackStore } from "@/stores/modalStack";
import { closeToast, toast, toastEntries } from "./toast";
import { messageBox, messageBoxQueue } from "./messageBox";
import { vLoading } from "./loading";
import { isInAnyLayer, keepOpenOnToast, nextLayerZIndex, topModalLayerZIndex, useLayerZIndex } from "./layer";

const wrappers: { unmount: () => void }[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount());
  for (const e of [...toastEntries]) closeToast(e.id);
  toastEntries.splice(0);
  messageBox.close();
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
  function mountHost() {
    const wrapper = mount(MessageBoxHost, { attachTo: document.body });
    wrappers.push(wrapper);
  }
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("[role=alertdialog] button")];

  it('confirm：确定 resolve "confirm"，取消 reject "cancel"', async () => {
    mountHost();
    const ok = messageBox.confirm("正文", "标题", { confirmButtonText: "好", cancelButtonText: "不" });
    await flushPromises();
    expect(document.querySelector("[role=alertdialog]")!.textContent).toContain("正文");
    buttons()
      .find((b) => b.textContent!.includes("好"))!
      .click();
    await expect(ok).resolves.toBe("confirm");

    await new Promise((r) => setTimeout(r, 200));
    const cancelled = messageBox.confirm("再来");
    await flushPromises();
    buttons()
      .find((b) => b.textContent!.includes("common.cancel"))!
      .click();
    await expect(cancelled).rejects.toBe("cancel");
  });

  it("Esc：默认报 cancel，distinguishCancelAndClose 时报 close", async () => {
    mountHost();
    const plain = messageBox.confirm("正文");
    await flushPromises();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(plain).rejects.toBe("cancel");

    await new Promise((r) => setTimeout(r, 200));
    const distinct = messageBox.confirm("正文", "", { distinguishCancelAndClose: true });
    await flushPromises();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(distinct).rejects.toBe("close");
  });

  it("prompt：校验不过显示错误、留在框里；通过后 resolve { value }", async () => {
    mountHost();
    const result = messageBox.prompt("名称", "改名", {
      inputValue: "旧",
      inputValidator: (v) => (v.trim() ? true : "不能为空"),
    });
    await flushPromises();
    const input = document.querySelector<HTMLInputElement>("[role=alertdialog] input")!;
    expect(input.value).toBe("旧");
    input.value = " ";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    buttons().at(-1)!.click();
    await flushPromises();
    expect(document.querySelector("[role=alertdialog]")!.textContent).toContain("不能为空");
    input.value = "新";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    buttons().at(-1)!.click();
    await expect(result).resolves.toEqual({ value: "新", action: "confirm" });
  });

  it("alert 怎么关都 resolve；排队的请求依次显示；close() 全部结束", async () => {
    mountHost();
    const first = messageBox.alert("一");
    const second = messageBox.confirm("二");
    await flushPromises();
    expect(messageBoxQueue).toHaveLength(2);
    expect(document.querySelector("[role=alertdialog]")!.textContent).toContain("一");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(first).resolves.toBe("confirm");
    await new Promise((r) => setTimeout(r, 200));
    await flushPromises();
    expect(document.querySelector("[role=alertdialog]")!.textContent).toContain("二");
    messageBox.close();
    await expect(second).rejects.toBe("cancel");
    expect(messageBoxQueue).toHaveLength(0);
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

describe("层级工具", () => {
  it("点到提示消息时不关当前层；点到别处照常", () => {
    const toastEl = document.createElement("li");
    toastEl.setAttribute("data-kb-toast", "");
    const inner = document.createElement("span");
    toastEl.appendChild(inner);
    document.body.appendChild(toastEl);
    const fromToast = new CustomEvent("x", { cancelable: true, detail: { originalEvent: { target: inner } } });
    keepOpenOnToast(fromToast as unknown as Event);
    expect(fromToast.defaultPrevented).toBe(true);
    const elsewhere = new CustomEvent("x", { cancelable: true, detail: { originalEvent: { target: document.body } } });
    keepOpenOnToast(elsewhere as unknown as Event);
    expect(elsewhere.defaultPrevented).toBe(false);
  });

  it("点到常驻浮层（data-kb-persistent，看板娘）时也不关当前层", () => {
    const host = document.createElement("div");
    host.setAttribute("data-kb-persistent", "");
    const img = document.createElement("img");
    host.appendChild(img);
    document.body.appendChild(host);
    const fromMascot = new CustomEvent("x", { cancelable: true, detail: { originalEvent: { target: img } } });
    keepOpenOnToast(fromMascot as unknown as Event);
    expect(fromMascot.defaultPrevented).toBe(true);
  });

  it("模态层打开期间登记层级号：topModalLayerZIndex 取最高的、可排除打开方，关掉或卸载后撤销", async () => {
    const before = topModalLayerZIndex();
    const a = ref(false);
    const b = ref(false);
    const menu = ref(false);
    const scope = effectScope();
    const [za, zb] = scope.run(() => [
      useLayerZIndex(a, { modal: true }),
      useLayerZIndex(b, { modal: true, owner: "kamechan" }),
      useLayerZIndex(menu),
    ])!;
    a.value = true;
    await nextTick();
    expect(topModalLayerZIndex()).toBe(za.value);
    b.value = true;
    menu.value = true;
    await nextTick();
    // 非模态的菜单不登记；排除 kamechan 自己的对话框后，最高的是 a
    expect(topModalLayerZIndex()).toBe(zb.value);
    expect(topModalLayerZIndex("kamechan")).toBe(za.value);
    a.value = false;
    await nextTick();
    expect(topModalLayerZIndex("kamechan")).toBe(before);
    scope.stop();
    expect(topModalLayerZIndex()).toBe(before);
  });

  it("isInAnyLayer：对话框、菜单、提示里算层内，页面上不算", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.appendChild(button);
    document.body.appendChild(dialog);
    expect(isInAnyLayer(button)).toBe(true);
    expect(isInAnyLayer(document.body)).toBe(false);
  });
});

describe("PickerSheet", () => {
  const cascade = [
    {
      text: "0",
      value: 0,
      children: [
        { text: "1", value: 1 },
        { text: "2", value: 2 },
      ],
    },
    { text: "1", value: 1, children: [{ text: "0", value: 0 }] },
  ];

  function mountPicker(columns: PickerOption[] | PickerOption[][], values: (string | number)[]) {
    const open = ref(true);
    const model = ref(values);
    const confirmed = vi.fn();
    const Host = defineComponent({
      setup: () => () =>
        h(PickerSheet, {
          open: open.value,
          "onUpdate:open": (v: boolean) => (open.value = v),
          modelValue: model.value,
          "onUpdate:modelValue": (v: (string | number)[]) => (model.value = v),
          columns,
          title: "选",
          onConfirm: confirmed,
        }),
    });
    const wrapper = mount(Host, { attachTo: document.body });
    wrappers.push(wrapper);
    return { open, model, confirmed };
  }

  it("级联：按选中值解出各列；确定发各列的值并关闭", async () => {
    const { open, confirmed } = mountPicker(cascade, [0, 2]);
    await flushPromises();
    const lists = document.querySelectorAll("[role=listbox]");
    expect(lists).toHaveLength(2);
    expect(lists[1].querySelectorAll("[role=option]")).toHaveLength(2);
    [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")]
      .find((b) => b.textContent!.includes("common.confirm"))!
      .click();
    await flushPromises();
    expect(open.value).toBe(false);
    expect(confirmed).toHaveBeenCalledOnce();
    expect(confirmed.mock.calls[0][0].selectedValues).toEqual([0, 2]);
  });

  it("值不在选项里时落到第一项", async () => {
    const { confirmed } = mountPicker(
      [
        { text: "a", value: "a" },
        { text: "b", value: "b" },
      ],
      ["zzz"],
    );
    await flushPromises();
    [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")]
      .find((b) => b.textContent!.includes("common.confirm"))!
      .click();
    await flushPromises();
    expect(confirmed.mock.calls[0][0].selectedValues).toEqual(["a"]);
  });
});

describe("Paginator", () => {
  function mountPaginator(page: number, pageCount: number) {
    const updates: number[] = [];
    const wrapper = mount(Paginator, {
      props: { page, pageCount, "onUpdate:page": (value: number) => updates.push(value) },
      attachTo: document.body,
    });
    wrappers.push(wrapper);
    return { wrapper, updates };
  }

  it("上一页 / 下一页按边界置灰，点了报相邻页", async () => {
    const { wrapper, updates } = mountPaginator(1, 3);
    const [prev, next] = wrapper.findAll("button");
    expect(prev.attributes("disabled")).toBeDefined();
    await next.trigger("click");
    expect(updates).toEqual([2]);
    await wrapper.setProps({ page: 3 });
    expect(wrapper.findAll("button")[1].attributes("disabled")).toBeDefined();
  });

  it("输入的页码收拢到 1～总页数；不是数字就复原、不跳", async () => {
    const { wrapper, updates } = mountPaginator(2, 5);
    const input = wrapper.find("input");
    await input.setValue("99");
    await input.trigger("keydown", { key: "Enter" });
    expect(updates).toEqual([5]);
    expect((input.element as HTMLInputElement).value).toBe("5");
    await input.setValue("abc");
    await input.trigger("blur");
    expect(updates).toEqual([5]);
    expect((input.element as HTMLInputElement).value).toBe("2");
  });
});
