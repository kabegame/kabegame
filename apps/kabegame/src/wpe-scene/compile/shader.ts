import { translateWithIncludes, type TranslateResult, type Wpesl2wgsl } from "../wpesl2wgsl";
import type { ResourceScope, SceneFs } from "./fs";

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

  /** `scope` 是 effect 的资源范围：effect 的着色器按 `SceneFs.readScoped` 的顺序查找；头文件都在 `shaders/` 根，不按 effect 查。 */
  compile(
    shader: string,
    combos: Record<string, number | boolean> = {},
    textures: ShaderTextureSlot[] = [],
    scope: ResourceScope | null = null,
  ): Promise<TranslateResult | null> {
    const key = JSON.stringify([
      shader,
      scope?.dir ?? null,
      scope?.first ?? null,
      Object.entries(combos)
        .map(([name, value]) => [name.toUpperCase(), Number(value)])
        .sort(),
      textures.map((t) => [t.slot, t.format]).sort((a, b) => Number(a[0]) - Number(b[0])),
    ]);
    let task = this.cache.get(key);
    if (!task) {
      task = this.translate(shader, combos, textures, scope);
      this.cache.set(key, task);
    }
    return task;
  }

  private async translate(
    shader: string,
    combos: Record<string, number | boolean>,
    textures: ShaderTextureSlot[],
    scope: ResourceScope | null,
  ): Promise<TranslateResult | null> {
    if (!this.translator) {
      this.unsupported.add("shader:wasm-missing");
      return null;
    }
    const [vertex, fragment] = await Promise.all([
      this.fs.text(`shaders/${shader}.vert`, scope),
      this.fs.text(`shaders/${shader}.frag`, scope),
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
