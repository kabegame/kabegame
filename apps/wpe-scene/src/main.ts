import { SceneHost, type SceneProperty } from "./host";
import { createReporter } from "./report";
import { listenSceneParent, scenePointerFeed } from "./sceneStyle";
import { installSceneDevProbe } from "./dev/install";

declare global {
  interface Window {
    wallpaperPropertyListener?: {
      applyUserProperties(changed: Record<string, SceneProperty>): void;
      setPaused(value: boolean): void;
    };
    /** 垫片放的宿主音量（只读，0…1；收到父页面第一次回复之前为 0），变化时派发 `kabegame-host-volume`（P6a 步骤 1）。 */
    readonly __kabegameHostVolume?: number;
  }
}

const params = new URLSearchParams(location.search);
const instance = params.get("kbInstance") ?? "";
const canvas = document.querySelector<HTMLCanvasElement>("#scene-canvas");
if (!canvas) throw new Error("场景画布不存在");
const host = new SceneHost(canvas, { imageId: params.get("kbScene"), report: createReporter(instance) });
// 指针：父页面交来的开场初值只在还没收到真实 pointermove 时生效（P5a 收尾）
const pointer = scenePointerFeed((x, y) => host.setPointer(x, y));
listenSceneParent({
  style: (style) => host.setStyle(style),
  displayScale: (scale) => host.setDisplayScale(scale),
  pointer: pointer.initial,
});

window.wallpaperPropertyListener = {
  applyUserProperties: (changed) => host.applyUserProperties(changed),
  setPaused: (paused) => host.setPaused(paused),
};

// 宿主音量（P6a 步骤 1）：垫片在 window 上放只读值，变化时派发事件；事件可以伪造，所以只当通知、值总从只读属性读。
// 垫片的回复可能早于本模块执行，先读一次初值
const syncHostVolume = () => host.setHostVolume(window.__kabegameHostVolume ?? 0);
window.addEventListener("kabegame-host-volume", syncHostVolume);
syncHostVolume();
// 文档隐藏时渲染循环停转，声音同样按暂停处理
const syncHidden = () => host.setHidden(document.hidden);
document.addEventListener("visibilitychange", syncHidden);
syncHidden();

document.addEventListener("pointermove", (event) => {
  pointer.move(event.clientX / innerWidth, event.clientY / innerHeight);
});
// 左键（P6c）：只认主键（WPE 只有 `GetKeyState(VK_LBUTTON)`；声明里 `button` 总是 0）。`pointercancel` 当抬起，页面失焦 / 隐藏时松开，免得按下状态卡住
document.addEventListener("pointerdown", (event) => {
  if (event.button === 0) host.setButton(true);
});
document.addEventListener("pointerup", (event) => {
  if (event.button === 0) host.setButton(false);
});
document.addEventListener("pointercancel", () => host.setButton(false));
window.addEventListener("blur", () => host.setButton(false));
window.addEventListener("pagehide", () => host.dispose(), { once: true });

if (__SCENE_DEV__) installSceneDevProbe(host);
