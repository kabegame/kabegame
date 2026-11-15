// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { usePanzoomPreview } from "./usePanzoomPreview";

/** 记录调用的假 Panzoom 实例：只实现 composable 用到的那几个方法 */
interface FakePanzoom {
  el: HTMLElement;
  scale: number;
  handleDown: ReturnType<typeof vi.fn>;
  handleUp: ReturnType<typeof vi.fn>;
}
const created = vi.hoisted(() => [] as FakePanzoom[]);
vi.mock("@panzoom/panzoom", () => ({
  default: (el: HTMLElement, options: Record<string, unknown>) => {
    const fake = {
      el,
      scale: 1,
      handleDown: vi.fn(),
      handleUp: vi.fn(),
      getScale: () => fake.scale,
      getOptions: () => options,
      setOptions: () => {},
      destroy: () => {},
      zoom: (scale: number) => {
        fake.scale = scale;
      },
    };
    created.push(fake);
    return fake;
  },
}));

const wrappers: ReturnType<typeof mount>[] = [];

async function setup() {
  let api!: ReturnType<typeof usePanzoomPreview>;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = usePanzoomPreview(ref(true), ref(true));
        return () => h("div");
      },
    }),
    { attachTo: document.body },
  );
  wrappers.push(wrapper);
  return api;
}

/** 挂一个元素当 Panzoom 层，等实例建好（watch 之后还有一个 nextTick） */
async function attach(api: ReturnType<typeof usePanzoomPreview>) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  api.wrapperRef.value = el;
  await nextTick();
  await nextTick();
  return created[created.length - 1];
}

const down = () => new PointerEvent("pointerdown", { button: 0, pointerId: 1 });

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  created.splice(0);
  document.body.innerHTML = "";
});

describe("usePanzoomPreview 外部平移（壁纸覆盖层）", () => {
  it("没放大时拖不动：startPan 不调 handleDown，返回 false", async () => {
    const api = await setup();
    const fake = await attach(api);
    expect(api.startPan(down())).toBe(false);
    expect(fake.handleDown).not.toHaveBeenCalled();
  });

  it("放大后 startPan 交给 Panzoom 的 handleDown，返回 true；endPan 交给 handleUp", async () => {
    const api = await setup();
    const fake = await attach(api);
    api.zoomTo(2);
    const event = down();
    expect(api.startPan(event)).toBe(true);
    expect(fake.handleDown).toHaveBeenCalledExactlyOnceWith(event);
    const move = new PointerEvent("pointermove", { pointerId: 1, ctrlKey: true });
    api.endPan(move);
    expect(fake.handleUp).toHaveBeenCalledExactlyOnceWith(move);
  });

  it("Panzoom 层换了（切到另一种内容）之后不再调旧实例", async () => {
    const api = await setup();
    const old = await attach(api);
    api.zoomTo(2);
    const fresh = await attach(api);
    expect(fresh).not.toBe(old);
    // 新实例从 1 开始：拖不动
    expect(api.startPan(down())).toBe(false);
    api.zoomTo(3);
    api.startPan(down());
    api.endPan(down());
    expect(old.handleDown).not.toHaveBeenCalled();
    expect(old.handleUp).not.toHaveBeenCalled();
    expect(fresh.handleDown).toHaveBeenCalledOnce();
    expect(fresh.handleUp).toHaveBeenCalledOnce();
  });

  it("Panzoom 层没了（关闭）时 startPan 返回 false", async () => {
    const api = await setup();
    await attach(api);
    api.zoomTo(2);
    api.wrapperRef.value = null;
    await nextTick();
    expect(api.startPan(down())).toBe(false);
  });
});
