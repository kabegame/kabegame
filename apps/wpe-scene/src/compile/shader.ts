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

/** 一次翻译的结果与它的不支持项：两者一起缓存，命中时重新上报。 */
interface TranslateOutcome {
  result: TranslateResult | null;
  issues: string[];
}

export class ShaderCompiler {
  private readonly cache = new Map<string, Promise<TranslateOutcome>>();
  constructor(
    private fs: SceneFs,
    private translator: Wpesl2wgsl | null,
    private unsupported: Set<string>,
    /** 只在最终 `LIGHTING` 非 0 时生效的宏（`lights.ts`）。整场一份，不进缓存键。 */
    private litDefines: Record<string, string> = {},
    /** 整场全局的引擎宏（`lights.ts` 的 `engineDefines`）。`ShaderCompiler` 每次编译新建，不进缓存键。 */
    private defines: Record<string, string> = {},
  ) {}

  /**
   * `scope` 是 effect 的资源范围：effect 的着色器按 `SceneFs.readScoped` 的顺序查找；头文件都在 `shaders/` 根，不按 effect 查。
   * `unsupported` 是本次调用的上报目标，缺省为场景级。不支持项每次调用都写一遍：关着的 effect 先翻译、启用的 effect 再命中
   * 缓存时，场景级才收得到（3c）。结果仍是同一个对象，`addProgram` 按它去重。
   */
  async compile(
    shader: string,
    combos: Record<string, number | boolean> = {},
    textures: ShaderTextureSlot[] = [],
    scope: ResourceScope | null = null,
    unsupported: Set<string> = this.unsupported,
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
    const { result, issues } = await task;
    for (const issue of issues) unsupported.add(issue);
    return result;
  }

  private async translate(
    shader: string,
    combos: Record<string, number | boolean>,
    textures: ShaderTextureSlot[],
    scope: ResourceScope | null,
  ): Promise<TranslateOutcome> {
    if (!this.translator) return { result: null, issues: ["shader:wasm-missing"] };
    const issues: string[] = [];
    const [vertex, fragment] = await Promise.all([
      this.fs.text(`shaders/${shader}.vert`, scope),
      this.fs.text(`shaders/${shader}.frag`, scope),
    ]);
    if (!vertex || !fragment) {
      issues.push(`shader:${shader}:missing`);
      if (!this.fs.sceneAssets.length) issues.push("assets:missing");
      return { result: null, issues };
    }
    const result = await translateWithIncludes(
      this.translator,
      { vertex, fragment, combos, textures, defines: this.defines, litDefines: this.litDefines },
      (name) => this.fs.text(`shaders/${name}`),
    );
    if (!result.ok) {
      const detail =
        result.requires?.[0] ?? result.missing?.[0] ?? result.errors?.[0]?.message?.replace(/\s+/g, " ").slice(0, 100);
      issues.push(`shader:${shader}:${result.phase ?? "unknown"}${detail ? `:${detail}` : ""}`);
      if (!this.fs.sceneAssets.length && result.phase === "include") issues.push("assets:missing");
    }
    return { result, issues };
  }
}
