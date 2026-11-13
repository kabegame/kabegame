// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ColorBucketPanel from "./ColorBucketPanel.vue";
import { MAX_CUSTOM_COLOR_BUCKETS, type ColorBucket } from "@/services/colorBuckets";

const invoke = vi.hoisted(() => vi.fn());
const message = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }));
const ui = vi.hoisted(() => ({ isCompact: false }));
vi.mock("@/api/rpc", () => ({ invoke }));
vi.mock("@/utils/kameMessage", () => ({ kameMessage: message }));
vi.mock("@/utils/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/stores/ui", () => ({ useUiStore: () => ui }));
vi.mock("@/composables/useModalBack", () => ({ useModalBack: vi.fn() }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const BUILTIN: [string, number][] = [
  ["red", 0xff0000],
  ["orange", 0xff8000],
  ["yellow", 0xe6c200],
  ["green", 0x2e9e3f],
  ["cyan", 0x1fb5b5],
  ["blue", 0x0000ff],
  ["purple", 0x8000ff],
  ["pink", 0xff80c0],
  ["brown", 0x804000],
  ["black", 0x000000],
  ["white", 0xffffff],
  ["gray", 0x808080],
];
const bucket = (rgb: number, key: string | null, position: number): ColorBucket => ({
  rgb,
  hex: rgb.toString(16).padStart(6, "0"),
  key,
  position,
});
const builtin = BUILTIN.map(([key, rgb], index) => bucket(rgb, key, index));
const custom = bucket(0x32fe98, null, 12);

// 新组件换成最小的桩：只保留面板用到的 props 与事件（弹层不真的打开）。
const stubs = {
  Button: {
    props: ["disabled", "variant", "size"],
    template: '<button type="button" :disabled="disabled"><slot /></button>',
  },
  Spinner: { template: '<i class="spinner" />' },
  Tooltip: { template: "<span><slot /></span>" },
  Popconfirm: {
    name: "Popconfirm",
    props: ["open", "title"],
    emits: ["confirm", "update:open"],
    template: "<span><slot /></span>",
  },
  ColorPickerPanel: {
    name: "ColorPickerPanel",
    props: ["modelValue", "disabled"],
    emits: ["update:modelValue"],
    template: '<div class="picker" />',
  },
};

const wrappers: ReturnType<typeof mount>[] = [];
function render(props: { selected?: string; buckets?: ColorBucket[] } = {}) {
  const wrapper = mount(ColorBucketPanel, {
    props: { buckets: [...builtin, custom], ...props },
    global: { stubs },
  });
  wrappers.push(wrapper);
  return wrapper;
}
type Wrapper = ReturnType<typeof render>;
const swatch = (wrapper: Wrapper, hex: string) => wrapper.get(`[data-color="${hex}"]`);
const other = (wrapper: Wrapper) => wrapper.get("[data-color-other]");
const picker = (wrapper: Wrapper) => wrapper.findComponent({ name: "ColorPickerPanel" });
const sortButton = (wrapper: Wrapper) => wrapper.get("[data-color-sort]");
const saveButton = (wrapper: Wrapper) => wrapper.get("[data-color-save]");
const hint = (wrapper: Wrapper) => wrapper.get("[data-color-hint]").text();
const isDisabled = (button: ReturnType<Wrapper["get"]>) => button.attributes("disabled") !== undefined;
async function pick(wrapper: Wrapper, value: string | null) {
  picker(wrapper).vm.$emit("update:modelValue", value);
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  invoke.mockReset();
  Object.values(message).forEach((fn) => fn.mockReset());
  ui.isCompact = false;
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe("色块", () => {
  it("按列表顺序渲染：基本色桶、用户保存的色桶，末尾是「其它颜色」", () => {
    const wrapper = render();
    const colors = wrapper.findAll("[data-color]").map((el) => el.attributes("data-color"));
    expect(colors).toEqual([...builtin.map((b) => b.hex), "32fe98"]);
    // 基本色桶显示名字，用户保存的显示 #rrggbb
    expect(swatch(wrapper, "ff0000").attributes("title")).toBe("gallery.colorBucket.red");
    expect(swatch(wrapper, "000000").attributes("title")).toBe("gallery.colorBucket.black");
    expect(swatch(wrapper, "32fe98").attributes("title")).toBe("#32fe98");
    expect(other(wrapper).attributes("title")).toBe("gallery.colorOther");
    // 取色面板默认不展开
    expect(picker(wrapper).exists()).toBe(false);
  });

  it("点色块报出这个颜色，不调用任何命令", async () => {
    const wrapper = render();
    await swatch(wrapper, "0000ff").trigger("click");
    await swatch(wrapper, "32fe98").trigger("click");
    expect(wrapper.emitted("select")).toEqual([["0000ff"], ["32fe98"]]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("当前排序的颜色在色桶里：那一块选中，「其它颜色」是空块", () => {
    const wrapper = render({ selected: "ffffff" });
    expect(swatch(wrapper, "ffffff").attributes("aria-pressed")).toBe("true");
    expect(swatch(wrapper, "ff0000").attributes("aria-pressed")).toBe("false");
    // 浅色块上的对勾用深色
    expect(swatch(wrapper, "ffffff").find("svg").classes()).toContain("text-black/70");
    expect(other(wrapper).attributes("style") ?? "").not.toContain("background-color");
    expect(other(wrapper).attributes("title")).toBe("gallery.colorOther");
  });

  it("当前排序的颜色不在色桶里：「其它颜色」显示成那个颜色并带选中描边", () => {
    const wrapper = render({ selected: "123456" });
    expect(wrapper.findAll('[data-color][aria-pressed="true"]')).toHaveLength(0);
    expect(other(wrapper).attributes("style")).toContain("background-color");
    expect(other(wrapper).attributes("title")).toBe("gallery.colorOther · #123456");
    expect(other(wrapper).classes()).toContain("outline");
  });
});

describe("删除用户保存的色桶", () => {
  it("只有用户保存的色桶带删除角标，确认框默认关着", () => {
    const wrapper = render();
    const badges = wrapper.findAll("[data-delete-color]");
    expect(badges.map((el) => el.attributes("data-delete-color"))).toEqual(["32fe98"]);
    const confirm = wrapper.findComponent({ name: "Popconfirm" });
    expect(confirm.props("open")).toBe(false);
  });

  it("角标悬停才显示；触屏（紧凑）与确认框打开时常显", async () => {
    const wrapper = render();
    expect(wrapper.get("[data-delete-color]").classes()).toContain("opacity-0");
    const confirm = wrapper.findComponent({ name: "Popconfirm" });
    confirm.vm.$emit("update:open", true);
    await wrapper.vm.$nextTick();
    expect(confirm.props("open")).toBe(true);
    expect(wrapper.get("[data-delete-color]").classes()).toContain("opacity-100");
    confirm.vm.$emit("update:open", false);
    await wrapper.vm.$nextTick();
    expect(wrapper.get("[data-delete-color]").classes()).toContain("opacity-0");

    ui.isCompact = true;
    expect(render().get("[data-delete-color]").classes()).toContain("opacity-100");
  });

  it("确认后调删除命令，不报选色；色桶已不在了不提示", async () => {
    invoke.mockResolvedValue(null);
    const wrapper = render({ selected: "32fe98" });
    wrapper.findComponent({ name: "Popconfirm" }).vm.$emit("confirm");
    await flushPromises();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("delete_color_bucket", { rgb: 0x32fe98 });
    expect(wrapper.emitted("select")).toBeUndefined();

    invoke.mockReset().mockRejectedValue("color-bucket:not-found");
    wrapper.findComponent({ name: "Popconfirm" }).vm.$emit("confirm");
    await flushPromises();
    expect(message.error).not.toHaveBeenCalled();
  });

  it("删除失败给提示", async () => {
    invoke.mockRejectedValue("color-bucket:builtin");
    const wrapper = render();
    wrapper.findComponent({ name: "Popconfirm" }).vm.$emit("confirm");
    await flushPromises();
    expect(message.error).toHaveBeenCalledExactlyOnceWith("common.operationFailed");
  });
});

describe("其它颜色", () => {
  it("点开内嵌取色面板，初值是当前排序的颜色；再点收起", async () => {
    const wrapper = render({ selected: "123456" });
    await other(wrapper).trigger("click");
    expect(other(wrapper).attributes("aria-expanded")).toBe("true");
    expect(picker(wrapper).props("modelValue")).toBe("#123456");
    expect(hint(wrapper)).toBe("gallery.colorAnyHint");
    await other(wrapper).trigger("click");
    expect(picker(wrapper).exists()).toBe(false);
  });

  it("没有当前颜色时取色面板也有初值，两个按钮可用", async () => {
    const wrapper = render();
    await other(wrapper).trigger("click");
    expect(picker(wrapper).props("modelValue")).toMatch(/^#[0-9a-f]{6}$/);
    expect(isDisabled(sortButton(wrapper))).toBe(false);
    expect(isDisabled(saveButton(wrapper))).toBe(false);
  });

  it("「按这个颜色排序」报出取到的颜色（小写、不带 #），不保存", async () => {
    const wrapper = render();
    await other(wrapper).trigger("click");
    await pick(wrapper, "#ABCDEF");
    await sortButton(wrapper).trigger("click");
    expect(wrapper.emitted("select")).toEqual([["abcdef"]]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("「保存为色桶」：期间转圈、两个按钮与取色面板都禁用，成功后报出颜色", async () => {
    let resolve!: (row: unknown) => void;
    invoke.mockReturnValue(new Promise((r) => (resolve = r)));
    const wrapper = render();
    await other(wrapper).trigger("click");
    await pick(wrapper, "#abcdef");
    await saveButton(wrapper).trigger("click");

    expect(invoke).toHaveBeenCalledExactlyOnceWith("add_color_bucket", { rgb: 0xabcdef });
    expect(saveButton(wrapper).find(".spinner").exists()).toBe(true);
    expect(isDisabled(saveButton(wrapper))).toBe(true);
    expect(isDisabled(sortButton(wrapper))).toBe(true);
    expect(picker(wrapper).props("disabled")).toBe(true);
    expect(wrapper.emitted("select")).toBeUndefined();

    resolve({ rgb: 0xabcdef, key: null, position: 13 });
    await flushPromises();
    expect(wrapper.emitted("select")).toEqual([["abcdef"]]);
    expect(saveButton(wrapper).find(".spinner").exists()).toBe(false);
    expect(isDisabled(sortButton(wrapper))).toBe(false);
  });

  it("取到的颜色已经是色桶：保存置灰并说明原因，仍可按它排序", async () => {
    const wrapper = render();
    await other(wrapper).trigger("click");
    await pick(wrapper, "#FF0000");
    expect(isDisabled(saveButton(wrapper))).toBe(true);
    expect(hint(wrapper)).toBe("gallery.colorBucketExists");
    expect(isDisabled(sortButton(wrapper))).toBe(false);
    await saveButton(wrapper).trigger("click");
    expect(invoke).not.toHaveBeenCalled();

    // 用户保存的色桶同样算
    await pick(wrapper, "#32fe98");
    expect(isDisabled(saveButton(wrapper))).toBe(true);
    await pick(wrapper, "#32fe99");
    expect(isDisabled(saveButton(wrapper))).toBe(false);
    expect(hint(wrapper)).toBe("gallery.colorAnyHint");
  });

  it("用户色桶到上限：保存置灰并说明原因；差一个时还能存", async () => {
    const customs = (n: number) => Array.from({ length: n }, (_, i) => bucket(0x010000 + i, null, 12 + i));
    const full = render({ buckets: [...builtin, ...customs(MAX_CUSTOM_COLOR_BUCKETS)] });
    await other(full).trigger("click");
    await pick(full, "#abcdef");
    expect(isDisabled(saveButton(full))).toBe(true);
    expect(hint(full)).toBe("gallery.colorBucketLimit");
    expect(isDisabled(sortButton(full))).toBe(false);

    const almost = render({ buckets: [...builtin, ...customs(MAX_CUSTOM_COLOR_BUCKETS - 1)] });
    await other(almost).trigger("click");
    await pick(almost, "#abcdef");
    expect(isDisabled(saveButton(almost))).toBe(false);
  });

  it("取色面板没有颜色时两个按钮都置灰", async () => {
    const wrapper = render();
    await other(wrapper).trigger("click");
    await pick(wrapper, null);
    expect(isDisabled(sortButton(wrapper))).toBe(true);
    expect(isDisabled(saveButton(wrapper))).toBe(true);
  });

  it("保存失败：按错误码提示、不报选色；别处刚存成了色桶则照常按它排序", async () => {
    invoke.mockRejectedValue("color-bucket:limit");
    const wrapper = render();
    await other(wrapper).trigger("click");
    await pick(wrapper, "#abcdef");
    await saveButton(wrapper).trigger("click");
    await flushPromises();
    expect(message.error).toHaveBeenCalledExactlyOnceWith("gallery.colorBucketLimit");
    expect(wrapper.emitted("select")).toBeUndefined();
    expect(isDisabled(saveButton(wrapper))).toBe(false);

    invoke.mockReset().mockRejectedValue(new Error("database is locked"));
    await saveButton(wrapper).trigger("click");
    await flushPromises();
    expect(message.error).toHaveBeenLastCalledWith("common.operationFailed");
    expect(wrapper.emitted("select")).toBeUndefined();

    message.error.mockReset();
    invoke.mockReset().mockRejectedValue("color-bucket:exists");
    await saveButton(wrapper).trigger("click");
    await flushPromises();
    expect(message.error).not.toHaveBeenCalled();
    expect(wrapper.emitted("select")).toEqual([["abcdef"]]);
  });
});
