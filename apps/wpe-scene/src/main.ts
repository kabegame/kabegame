import { SceneHost, type SceneProperty } from "./host";
import { createReporter } from "./report";
import { installSceneDevProbe } from "./dev/install";

declare global {
  interface Window {
    wallpaperPropertyListener?: {
      applyUserProperties(changed: Record<string, SceneProperty>): void;
      setPaused(value: boolean): void;
    };
  }
}

const params = new URLSearchParams(location.search);
const instance = params.get("kbInstance") ?? "";
const canvas = document.querySelector<HTMLCanvasElement>("#scene-canvas");
if (!canvas) throw new Error("场景画布不存在");
const host = new SceneHost(canvas, { imageId: params.get("kbScene"), report: createReporter(instance) });

window.wallpaperPropertyListener = {
  applyUserProperties: (changed) => host.applyUserProperties(changed),
  setPaused: (paused) => host.setPaused(paused),
};

document.addEventListener("pointermove", (event) => {
  host.setPointer(event.clientX / innerWidth, event.clientY / innerHeight);
});
window.addEventListener("pagehide", () => host.dispose(), { once: true });

if (__SCENE_DEV__) installSceneDevProbe();
