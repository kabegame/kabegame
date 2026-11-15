// @vitest-environment happy-dom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WpeShortcutField from "./WpeShortcutField.vue";

const invoke = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
const success = vi.hoisted(() => vi.fn());
const warning = vi.hoisted(() => vi.fn());
const failure = vi.hoisted(() => vi.fn());

vi.mock("@/api", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
vi.mock("@/components/ui/toast", () => ({ toast: { success, warning, error: failure } }));
vi.mock("@kabegame/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const KbSelectStub = {
  props: { modelValue: String, options: Array },
  emits: ["update:modelValue"],
  template: `<select class="kind" :value="modelValue" @change="$emit('update:modelValue', $event.target.value)">
    <option v-for="o in options" :key="o.variable" :value="o.variable">{{ o.name }}</option></select>`,
};
const KbTextStub = {
  props: { modelValue: String, placeholder: String },
  emits: ["update:modelValue"],
  template: `<input :placeholder="placeholder" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
};

const wrappers: ReturnType<typeof mount>[] = [];

function mountField(modelValue: unknown, extra: Record<string, unknown> = {}) {
  const wrapper = mount(WpeShortcutField, {
    props: { name: "Chrome", modelValue, imageId: "7", ...extra } as never,
    global: { stubs: { KbSelect: KbSelectStub, KbText: KbTextStub } },
  });
  wrappers.push(wrapper);
  return wrapper;
}

const pathInput = (w: ReturnType<typeof mount>) => w.find('[data-testid="wpe-shortcut-path"]');
const argsInput = (w: ReturnType<typeof mount>) => w.find('[data-testid="wpe-shortcut-args"]');
const kindSelect = (w: ReturnType<typeof mount>) => w.find('[data-testid="wpe-shortcut-kind"]');
const testButton = (w: ReturnType<typeof mount>) => w.find('[data-testid="wpe-shortcut-test"]');
const lastEmitted = (w: ReturnType<typeof mount>) => w.emitted("update:modelValue")!.at(-1)![0];

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(true);
  open.mockReset();
  success.mockReset();
  warning.mockReset();
  failure.mockReset();
});
afterEach(() => wrappers.splice(0).forEach((w) => w.unmount()));

describe("WpeShortcutField：值与各字段", () => {
  it("读回时把原值拆回各字段", async () => {
    const w = mountField("file:C:\\a.exe|-x");
    expect((kindSelect(w).element as HTMLSelectElement).value).toBe("file");
    expect((pathInput(w).element as HTMLInputElement).value).toBe("C:\\a.exe");
    expect((argsInput(w).element as HTMLInputElement).value).toBe("-x");
    await w.setProps({ modelValue: "cmd:calc /x" });
    expect((kindSelect(w).element as HTMLSelectElement).value).toBe("cmd");
    expect((pathInput(w).element as HTMLInputElement).value).toBe("calc /x");
    expect(argsInput(w).exists()).toBe(false);
  });

  it("编辑路径、参数、类型都发拼好的原值；路径为空发空串（清空）", async () => {
    const w = mountField("");
    await pathInput(w).setValue("C:\\a.exe");
    expect(lastEmitted(w)).toBe("file:C:\\a.exe");
    await argsInput(w).setValue("-x");
    expect(lastEmitted(w)).toBe("file:C:\\a.exe|-x");
    await kindSelect(w).setValue("cmd");
    expect(lastEmitted(w)).toBe("cmd:C:\\a.exe");
    expect(argsInput(w).exists()).toBe(false);
    await pathInput(w).setValue("");
    expect(lastEmitted(w)).toBe("");
  });

  it("自己发出的值回灌时不重新拆：路径为空时选好的类型保留", async () => {
    const w = mountField("");
    await kindSelect(w).setValue("web");
    expect(lastEmitted(w)).toBe("");
    await w.setProps({ modelValue: "" });
    expect((kindSelect(w).element as HTMLSelectElement).value).toBe("web");
    // 保存后后端补了网址前缀：外部的值变了，路径跟着更新
    await pathInput(w).setValue("example.com");
    await w.setProps({ modelValue: "web:https://example.com" });
    expect((pathInput(w).element as HTMLInputElement).value).toBe("https://example.com");
  });

  it("清空按钮：值为空时不出现；点了发空串并清掉路径与参数", async () => {
    const empty = mountField("");
    expect(empty.find('[data-testid="wpe-shortcut-clear"]').exists()).toBe(false);
    const w = mountField("file:C:\\a.exe|-x");
    await w.find('[data-testid="wpe-shortcut-clear"]').trigger("click");
    expect(lastEmitted(w)).toBe("");
    expect((pathInput(w).element as HTMLInputElement).value).toBe("");
    expect((argsInput(w).element as HTMLInputElement).value).toBe("");
  });
});

describe("WpeShortcutField：浏览", () => {
  it("文件与文件夹有浏览按钮（文件不按扩展名过滤），网址与命令没有", async () => {
    const w = mountField("file:C:\\a.exe");
    expect(w.find('[data-testid="wpe-shortcut-browse"]').exists()).toBe(true);
    open.mockResolvedValue("D:\\apps\\b.exe");
    await w.find('[data-testid="wpe-shortcut-browse"]').trigger("click");
    await flushPromises();
    expect(open).toHaveBeenCalledWith({ directory: false, multiple: false });
    expect(lastEmitted(w)).toBe("file:D:\\apps\\b.exe");

    await kindSelect(w).setValue("directory");
    open.mockResolvedValue("D:\\apps");
    await w.find('[data-testid="wpe-shortcut-browse"]').trigger("click");
    await flushPromises();
    expect(open).toHaveBeenLastCalledWith({ directory: true, multiple: false });
    expect(lastEmitted(w)).toBe("directory:D:\\apps");

    for (const kind of ["web", "cmd"]) {
      await kindSelect(w).setValue(kind);
      expect(w.find('[data-testid="wpe-shortcut-browse"]').exists(), kind).toBe(false);
    }
  });

  it("取消选择（返回 null）不改值", async () => {
    const w = mountField("file:C:\\a.exe");
    open.mockResolvedValue(null);
    await w.find('[data-testid="wpe-shortcut-browse"]').trigger("click");
    await flushPromises();
    expect(w.emitted("update:modelValue")).toBeUndefined();
  });
});

describe("WpeShortcutField：测试按钮", () => {
  it("值为空时禁用", () => {
    expect(testButton(mountField("")).attributes("disabled")).toBeDefined();
    expect(testButton(mountField("file:C:\\a.exe")).attributes("disabled")).toBeUndefined();
  });

  it("先等草稿写完（save），再以本壁纸的图片 id 与属性名调 wpe_open_user_shortcut；成功提示", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => void order.push("save"));
    invoke.mockImplementation(async () => {
      order.push("invoke");
      return true;
    });
    const w = mountField("file:C:\\a.exe", { save });
    await testButton(w).trigger("click");
    await flushPromises();
    expect(order).toEqual(["save", "invoke"]);
    expect(invoke).toHaveBeenCalledWith("wpe_open_user_shortcut", { imageId: "7", name: "Chrome" });
    expect(success).toHaveBeenCalledWith("gallery.wpeShortcutTestStarted");
  });

  it("命令返回 false 提示无法启动；抛错提示失败原因；都不抛出", async () => {
    invoke.mockResolvedValueOnce(false);
    const w = mountField("file:C:\\a.exe");
    await testButton(w).trigger("click");
    await flushPromises();
    expect(warning).toHaveBeenCalledWith("gallery.wpeShortcutTestRejected");
    invoke.mockRejectedValueOnce(new Error("拒绝"));
    await testButton(w).trigger("click");
    await flushPromises();
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("gallery.wpeShortcutTestFailed"));
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("拒绝"));
  });

  it("没有图片 id 时不调命令", async () => {
    const w = mountField("file:C:\\a.exe", { imageId: undefined });
    await testButton(w).trigger("click");
    await flushPromises();
    expect(invoke).not.toHaveBeenCalled();
  });
});
