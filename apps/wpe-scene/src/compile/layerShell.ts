/**
 * 图层壳的取值（P6d3b）：`compileScene` 建 `SceneLayer` 时只取值的那一段，抽成纯函数。
 * 运行时 `createLayer` 要当场按配置建待编对象的 `LayerState`，取值规则必须和编译期同一份。
 *
 * 绑定对象（`{ user, value }` / `{ script, value }` / `{ animation, value }`）缺省取它的 `value`；编译期传 `bind` 把「解析属性 + 登记
 * 就地目标」接进来（返回解析后的值），所以编译产物与改前逐字节相同。
 */
import { layerVectorValue, isUserBinding, type LayerVectorField } from "./bindings";
import { alignmentIndex } from "./alignment";
import { unwrapValue } from "./materialValues";
import { boolFieldValue, numbers, type SceneObject, type SceneScalar, type SceneValue } from "./model";

/** 取不到有限数字时用 `fallback`（null / undefined 同）。 */
export const asNumber = (value: SceneScalar | undefined, fallback: number): number => {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** 图层壳里会经 `bind` 的字段（`size` 编译期登记成重编译目标，别的是就地目标）。 */
export type LayerShellField = LayerVectorField | "angles" | "size" | "alpha" | "brightness" | "visible" | "solid";

/** 解析一个字段的原始值（属性、条件换算），可选；缺省取绑定对象的 `value`。 */
export type LayerShellBind = (field: LayerShellField, raw: SceneValue | undefined) => SceneScalar | undefined;

export interface LayerShellValues {
  /** JSON 里的数字 `id`；没有是 null（编译期缺省取图层个数，运行时按现有最大 id 发号） */
  id: number | null;
  name: string;
  origin: number[];
  scale: number[];
  angles: number[];
  /** 没写（或写不出数字）是空数组，调用方按模型 / 纹理补 */
  size: number[];
  alpha: number;
  color: number[];
  brightness: number;
  visible: boolean;
  visibleBound: boolean;
  parallaxDepth: number[];
  solid: boolean;
  /** `compile/alignment.ts` 的下标（缺省 0） */
  alignment: number;
}

const unwrapBind: LayerShellBind = (_field, raw) => unwrapValue(raw) as SceneScalar | undefined;

export function layerShellValues(object: SceneObject, bind: LayerShellBind = unwrapBind): LayerShellValues {
  // 向量字段照 WPE 的向量 setter（`layerVectorValue`）：绑定值写不进时留 JSON 的 `value`，那个也写不进是构造缺省
  const vector = (field: LayerVectorField, fallback: number[]): number[] => {
    const raw = object[field] as SceneValue | undefined;
    return layerVectorValue(field, bind(field, raw)) ?? layerVectorValue(field, unwrapValue(raw)) ?? [...fallback];
  };
  // alpha / brightness 照 float setter：不收布尔，写不进就留 `value`，那个也是布尔就是缺省 1
  const scalar = (field: "alpha" | "brightness"): number => {
    const raw = object[field] as SceneValue | undefined;
    const bound = bind(field, raw);
    if (typeof bound !== "boolean") return asNumber(bound, 1);
    const own = unwrapValue(raw);
    return typeof own === "boolean" ? 1 : asNumber(own as SceneScalar | undefined, 1);
  };
  return {
    id: typeof object.id === "number" ? object.id : null,
    name: object.name ?? "",
    origin: vector("origin", [0, 0, 0]),
    scale: vector("scale", [1, 1, 1]),
    angles: numbers(bind("angles", object.angles), [0, 0, 0]),
    size: numbers(bind("size", object.size)),
    alpha: scalar("alpha"),
    // 灯对象的 `color` 是灯的颜色，构造缺省黑（P13f2，`FUN_14018ff60`；灯光记录读图层状态的这个字段）
    color: vector("color", typeof object.light === "string" ? [0, 0, 0] : [1, 1, 1]),
    brightness: scalar("brightness"),
    visible: boolFieldValue(object.visible, bind("visible", object.visible)),
    visibleBound: isUserBinding(object.visible),
    parallaxDepth: vector("parallaxDepth", [1, 1]),
    solid: bind("solid", object.solid as SceneValue | undefined) !== false,
    alignment: alignmentIndex(object.alignment),
  };
}
