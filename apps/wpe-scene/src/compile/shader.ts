import { translateWithIncludes, type TranslateResult, type UniformLayout, type Wpesl2wgsl } from "../wpesl2wgsl";
import { userBindingOf, type BindingCollector, type BindingTarget, type TargetKey } from "./bindings";
import type { ResourceScope, SceneFs } from "./fs";
import {
  constantTargetFields,
  MATERIAL_SLOT_FLOATS,
  materialDefault,
  materialSetter,
  materialSlots,
  memberValue,
  unwrapValue,
  type MaterialMember,
} from "./materialValues";
import { staticCombos, type MaterialPass, type SceneScalar, type SceneValue } from "./model";

export interface ShaderTextureSlot {
  slot: number;
  format?: number;
}

/**
 * 一个材质 pass 的材质常量（带 `meta.material` 的 uniform），按 uniform 名给出。取值照 WPE（`materialValues.ts`，
 * vector-constant-REPORT.md 2.3–2.5）：加载时写 `constantshadervalues` 的值（缺键插注解缺省，`usershadervalues` 改写成
 * `{value, user}`），再以属性当前值走一次运行时路径；setter 只收 WPE 收的类型，数字进向量铺满，字符串进向量先清零再按空格切。
 *
 * `key` / `bindings` 给出时把每处用户绑定登记成 `constant` 目标（P3a，就地刷新 uniform 块）：目标带整组名字与各格的取值方式
 * （`members`），就地写用同一个 setter 整体重写（`render/state.ts`），单测核对与整场重编译一致。
 * 复刻不了的情况写进 `issues`（`constant:mixed-type:<键>`、单个 pass 被读的键超过 48 个 float 的 `constant:slots`；没被读的键
 * 由翻译器反射标 `unused`，WPE 不给它分配槽位）。
 */
export function shaderUniforms(
  result: TranslateResult | null,
  pass: MaterialPass,
  properties: Record<string, SceneScalar>,
  key?: TargetKey,
  bindings?: BindingCollector,
  issues?: Set<string>,
): Record<string, number[]> {
  const values: Record<string, number[]> = {};
  if (!result?.ok) return values;
  const users = Object.entries(pass.usershadervalues ?? {});
  let floats = 0;
  for (const slot of materialSlots(result.uniforms ?? [])) {
    for (const issue of slot.issues) issues?.add(issue);
    const target: BindingTarget = {
      kind: "constant",
      pass: key ?? "",
      material: slot.material,
      ...constantTargetFields(slot),
    };
    const property = users.find(([, material]) => material === slot.material)?.[0];
    const source = pass.constantshadervalues?.[slot.material];
    // `usershadervalues` 把整项改写成 `{value, user: 属性}`，原来的 `{user}` 绑定随之没了（报告 2.3 第 3 步）
    const user = property === undefined ? userBindingOf(source) : null;
    if (key && bindings) {
      if (property !== undefined && properties[property] !== undefined) bindings.list.push({ property, target });
      else if (user) bindings.list.push({ ...user, target });
    }
    for (const member of slot.members)
      values[member.name] = memberValue(member, materialStorage(member, source, property, user, properties));
    // WPE 每个键一份存储（拆开的两半共用主格那一半的），只给被使用的键分配槽位（p7-REPORT「P7d 的实测」`kbslot`）
    if (slot.used) floats += slot.members[0]?.components ?? 0;
  }
  if (floats > MATERIAL_SLOT_FLOATS) issues?.add("constant:slots");
  return values;
}

/**
 * 一格的存储：加载时用 setter 写 JSON 值（缺键插注解缺省；`usershadervalues` 写原值或缺省），再把属性当前值交给同一个 setter
 * （报告 2.3 / 2.5）。带 condition 的属性值在 WPE 里换成布尔，材质 setter 不收（第 6 节 `u-cond-f`），所以不再写。
 */
function materialStorage(
  member: MaterialMember,
  source: SceneValue | undefined,
  property: string | undefined,
  user: { property: string; condition?: string } | null,
  properties: Record<string, SceneScalar>,
): number[] {
  const n = member.components;
  let storage = new Array<number>(n).fill(0);
  const write = (value: unknown) => {
    const written = materialSetter(n, value);
    if (written) storage = written;
  };
  const fallback = materialDefault(n, member.default);
  if (property !== undefined) {
    write(source !== undefined ? unwrapValue(source) : fallback);
    if (properties[property] !== undefined) write(properties[property]);
  } else if (source !== undefined) {
    write(source);
    if (user && user.condition === undefined && properties[user.property] !== undefined)
      write(properties[user.property]);
  } else write(fallback);
  return storage;
}

/**
 * `ShaderCompiler` 的缓存键。`defines` 是调用方按 pass 给的宏（粒子材质槽 0 格式为 8–11 时的 `TEX0FORMAT`）：同一着色器、
 * 同样 COMBO，宏不同就不能命中同一条；没有时键与加宏之前逐字相同（图层材质、以及不写宏的粒子材质同一条规则）。
 * `geometry`（P4d 步骤 1，rope 带 `.geom` 的翻译）另进键；为假时键与加这一项之前逐字相同。
 */
export function shaderCacheKey(
  shader: string,
  combos: Record<string, number | boolean>,
  textures: ShaderTextureSlot[],
  scope: ResourceScope | null,
  defines: Record<string, string> = {},
  geometry = false,
): string {
  const parts: unknown[] = [
    shader,
    scope?.dir ?? null,
    scope?.first ?? null,
    Object.entries(combos)
      .map(([name, value]) => [name.toUpperCase(), Number(value)])
      .sort(),
    textures.map((t) => [t.slot, t.format]).sort((a, b) => Number(a[0]) - Number(b[0])),
  ];
  const extra = Object.entries(defines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (extra.length) parts.push(extra);
  if (geometry) parts.push("geometry");
  return JSON.stringify(parts);
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
   * `defines` 是本 pass 的宏（粒子材质槽 0 格式为 8–11 时的 `TEX0FORMAT`），在整场的 `defines` 之后应用，进缓存键。
   * `geometry`（P4d 步骤 1）：为真时另读 `shaders/<名>.geom`（WPE 按同名另行加载，rea-p4d-rope.md 第 6 节，`0x140162cb7`），放进请求的
   * `geometry`，翻译器把几何着色器展开进顶点着色器（`src-tauri/wpesl2wgsl/README.md`「几何着色器展开」）；进缓存键。
   */
  async compile(
    shader: string,
    combos: Record<string, number | boolean> = {},
    textures: ShaderTextureSlot[] = [],
    scope: ResourceScope | null = null,
    unsupported: Set<string> = this.unsupported,
    defines: Record<string, string> = {},
    geometry = false,
  ): Promise<TranslateResult | null> {
    // COMBO 只能是数值 / 布尔（WPE 按整数读，写成 `{user, value}` 会断言中止，I3）；对象由能力表报 `combo:user-binding`
    const usable = staticCombos(combos);
    const key = shaderCacheKey(shader, usable, textures, scope, defines, geometry);
    let task = this.cache.get(key);
    if (!task) {
      task = this.translate(shader, usable, textures, scope, defines, geometry);
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
    defines: Record<string, string>,
    geometry: boolean,
  ): Promise<TranslateOutcome> {
    if (!this.translator) return { result: null, issues: ["shader:wasm-missing"] };
    const issues: string[] = [];
    const [vertex, fragment, geom] = await Promise.all([
      this.fs.text(`shaders/${shader}.vert`, scope),
      this.fs.text(`shaders/${shader}.frag`, scope),
      geometry ? this.fs.text(`shaders/${shader}.geom`, scope) : null,
    ]);
    if (!vertex || !fragment || (geometry && !geom)) {
      issues.push(`shader:${shader}:missing`);
      if (!this.fs.sceneAssets.length) issues.push("assets:missing");
      return { result: null, issues };
    }
    const result = await translateWithIncludes(
      this.translator,
      {
        vertex,
        fragment,
        ...(geom ? { geometry: geom } : {}),
        combos,
        textures,
        defines: { ...this.defines, ...defines },
        litDefines: this.litDefines,
      },
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
