import { translateWithIncludes, type TranslateResult, type Wpesl2wgsl } from "../wpesl2wgsl";
import { valueTypeOf, type BindingCollector, type TargetKey, type ValueType } from "./bindings";
import type { ResourceScope, SceneFs } from "./fs";
import { numbers, resolveValue, staticCombos, type MaterialPass, type SceneScalar } from "./model";

export interface ShaderTextureSlot {
  slot: number;
  format?: number;
}

/** 一个材质常量名对应的全部 uniform（标量 / 向量可能分别声明成多个成员）。 */
interface ConstantGroup {
  uniforms: string[];
  /** 成员名 → 着色器注解 `default`。 */
  defaults: Map<string, SceneScalar | undefined>;
  type: ValueType;
}

/**
 * 一个材质 pass 的材质常量（带 `meta.material` 的 uniform）：用户属性（`usershadervalues`）→ 材质
 * `constantshadervalues` → 着色器注解 `default`，按 uniform 名给出。
 *
 * `key` / `bindings` 给出时把每处 `{user}` 登记成 `constant` 目标（P3a，就地刷新 uniform 块）；
 * 编译期与运行时共用 `bindingValue` / `numbers` 的换算规则，单测核对两边一致。
 */
export function shaderUniforms(
  result: TranslateResult | null,
  pass: MaterialPass,
  properties: Record<string, SceneScalar>,
  key?: TargetKey,
  bindings?: BindingCollector,
): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  if (!result?.ok) return values;
  // 同一个材质常量名可能对应多个 uniform：先按 meta.material 分组，一条绑定登记整组名字
  const groups = new Map<string, ConstantGroup>();
  for (const uniform of result.uniforms ?? []) {
    const material = uniform.meta?.material;
    if (typeof material !== "string") continue;
    let group = groups.get(material);
    if (!group) groups.set(material, (group = { uniforms: [], defaults: new Map(), type: valueTypeOf(uniform) }));
    group.uniforms.push(uniform.name);
    group.defaults.set(uniform.name, uniform.meta?.default as SceneScalar | undefined);
  }
  const users = Object.entries(pass.usershadervalues ?? {});
  for (const [material, group] of groups) {
    const constant = {
      kind: "constant",
      pass: key ?? "",
      material,
      uniforms: group.uniforms,
      type: group.type,
    } as const;
    const property = users.find(([, target]) => target === material)?.[0];
    let raw: SceneScalar | undefined;
    if (property !== undefined && properties[property] !== undefined) {
      // `usershadervalues` 优先于 `constantshadervalues`：两者都在时只登记前者
      raw = properties[property];
      if (key && bindings) bindings.list.push({ property, target: constant });
    } else {
      const source = pass.constantshadervalues?.[material];
      raw = bindings && key ? bindings.bind(source, properties, constant) : resolveValue(source, properties);
    }
    for (const [name, fallback] of group.defaults) {
      const value = raw ?? fallback;
      if (value !== undefined) values[name] = numbers(value);
    }
  }
  return values;
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
    // COMBO 只能是数值 / 布尔（WPE 按整数读，写成 `{user, value}` 会断言中止，I3）；对象由能力表报 `combo:user-binding`
    const usable = staticCombos(combos);
    const key = JSON.stringify([
      shader,
      scope?.dir ?? null,
      scope?.first ?? null,
      Object.entries(usable)
        .map(([name, value]) => [name.toUpperCase(), Number(value)])
        .sort(),
      textures.map((t) => [t.slot, t.format]).sort((a, b) => Number(a[0]) - Number(b[0])),
    ]);
    let task = this.cache.get(key);
    if (!task) {
      task = this.translate(shader, usable, textures, scope);
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
