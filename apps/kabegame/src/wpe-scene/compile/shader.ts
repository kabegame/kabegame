import { translateWithIncludes, type TranslateResult, type Wpesl2wgsl } from "../wpesl2wgsl";
import type { SceneFs } from "./fs";

export interface ShaderTextureSlot {
  slot: number;
  format?: number;
}
export class ShaderCompiler {
  private readonly cache = new Map<string, Promise<TranslateResult | null>>();
  constructor(
    private fs: SceneFs,
    private translator: Wpesl2wgsl | null,
    private unsupported: Set<string>,
  ) {}

  compile(
    shader: string,
    combos: Record<string, number | boolean> = {},
    textures: ShaderTextureSlot[] = [],
  ): Promise<TranslateResult | null> {
    const key = JSON.stringify([
      shader,
      Object.entries(combos).sort(),
      textures.map((t) => [t.slot, t.format]).sort((a, b) => Number(a[0]) - Number(b[0])),
    ]);
    let task = this.cache.get(key);
    if (!task) {
      task = this.translate(shader, combos, textures);
      this.cache.set(key, task);
    }
    return task;
  }

  private async translate(
    shader: string,
    combos: Record<string, number | boolean>,
    textures: ShaderTextureSlot[],
  ): Promise<TranslateResult | null> {
    if (!this.translator) {
      this.unsupported.add("shader:wasm-missing");
      return null;
    }
    const [vertex, fragment] = await Promise.all([
      this.fs.text(`shaders/${shader}.vert`),
      this.fs.text(`shaders/${shader}.frag`),
    ]);
    if (!vertex || !fragment) {
      this.unsupported.add(`shader:${shader}:missing`);
      if (!this.fs.sceneAssets.length) this.unsupported.add("assets:missing");
      return null;
    }
    const result = await translateWithIncludes(this.translator, { vertex, fragment, combos, textures }, (name) =>
      this.fs.text(`shaders/${name}`),
    );
    if (!result.ok) {
      const detail =
        result.requires?.[0] ?? result.missing?.[0] ?? result.errors?.[0]?.message?.replace(/\s+/g, " ").slice(0, 100);
      this.unsupported.add(`shader:${shader}:${result.phase ?? "unknown"}${detail ? `:${detail}` : ""}`);
      if (!this.fs.sceneAssets.length && result.phase === "include") this.unsupported.add("assets:missing");
    }
    return result;
  }
}
