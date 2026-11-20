/**
 * `thisScene.createModelData` / `destroyModelData` 与 `IModelData` 句柄的 `applyData` / `replaceData`（P14 步骤 1，点 2）。
 * 参数整理照 rea-p14-script 第 2–4、6、7 节与步骤 0 的实测（S1–S17），WPE 缺陷 D1–D12 按 `phase-14-model-data.md` 的建议做法实现：
 * 本模块只做 JS 值的整理与句柄的包装，规则与错误在 `ModelDataStore`（字节在那里拷贝）。报错一律是 realm 的 `SyntaxError`。
 */

import type { ModelDataStore } from "../modeldata/store";
import { ModelDataError } from "../modeldata/store";
import type {
  MaterialCheck,
  ModelDataIndexFormat,
  ModelDataInput,
  ModelDataShapeInput,
  ModelDataUpdate,
} from "../modeldata/types";
import { MODEL_DATA_FORMAT_BITS } from "../modeldata/types";

export interface ModelDataInstallContext {
  /** realm 的全局（取 `Object`、`IModelData`） */
  global: Record<string, unknown>;
  store(): ModelDataStore | undefined;
  materialCheck(): MaterialCheck | undefined;
  /** 正在跑的回调名（`ScriptRuntime.activeCallback`） */
  activeCallback(): string | null;
  /** 材质路径经当前脚本的 `__workshopId` 改写（`RP`，键为空；不截断，D12） */
  rewriteMaterial(path: string): string;
  syntaxError(message: string): Error;
  typeError(message: string): Error;
  /** 装一个 `thisScene` 方法（模块顶层调用抛 `SyntaxError`，S1） */
  sceneMethod(name: string, fn: (...args: unknown[]) => unknown): void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** %TypedArray%.prototype 的 `Symbol.toStringTag` getter：按内部槽返回类型名，跨 realm 的类型化数组也认，不是类型化数组返回 undefined。 */
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)
  ?.get as (this: unknown) => string | undefined;

function typedName(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? typedArrayTag.call(value) : undefined;
}

/** 类型化数组的字节视图（不拷贝；数据仓存储时拷贝）。 */
function bytesOf(value: unknown): Uint8Array {
  const array = value as ArrayBufferView;
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/** `vertexFormat`：区分大小写查表，遇第一个非字符串元素停，不认识的跳过；必须严格按表序递增（D2）。不是数组、空、全不认识都是 0。 */
function parseFormat(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let mask = 0;
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const item: unknown = value[i];
    if (typeof item !== "string") break;
    if (!Object.hasOwn(MODEL_DATA_FORMAT_BITS, item)) continue;
    const bit = MODEL_DATA_FORMAT_BITS[item as keyof typeof MODEL_DATA_FORMAT_BITS];
    if (bit <= last) throw new ModelDataError(0, "Vertex format in incorrect order.");
    last = bit;
    mask |= bit;
  }
  return mask;
}

function parseIndex(value: unknown): { format: ModelDataIndexFormat; bytes: Uint8Array } | null {
  const name = typedName(value);
  if (name === "Uint16Array") return { format: "uint16", bytes: bytesOf(value) };
  if (name === "Uint32Array") return { format: "uint32", bytes: bytesOf(value) };
  return null;
}

const component = (value: unknown): number => (typeof value === "number" ? Math.fround(value) : 0);

function readVec3(value: Record<string, unknown>): number[] {
  return [component(value.x), component(value.y), component(value.z)];
}

export function installModelData(context: ModelDataInstallContext): { isHandle(value: unknown): boolean } {
  const tokens = new WeakMap<object, number>();
  let prototype: object | undefined;

  const raise = (error: unknown): never => {
    if (error instanceof ModelDataError) throw context.syntaxError(error.message);
    throw error;
  };

  /** 创建时的形状（dll 的 `S`，创建模式）：形状不是对象（含 `null`、`undefined`）按缺 `vertexBuffer` 报错（D10）。 */
  const createShape = (shape: unknown): ModelDataShapeInput => {
    if (!isObject(shape)) throw new ModelDataError(0, "Vertex buffer missing.");
    if (typedName(shape.vertexBuffer) !== "Float32Array") throw new ModelDataError(0, "Vertex buffer missing.");
    const vertices = bytesOf(shape.vertexBuffer);
    const index = parseIndex(shape.indexBuffer);
    const format = parseFormat(shape.vertexFormat);
    if (format === 0) throw new ModelDataError(0, "Vertex format missing.");
    const material = shape.material;
    if (typeof material !== "string") throw new ModelDataError(0, "Material missing.");
    return {
      vertices,
      index,
      format,
      material: material === "" ? "" : context.rewriteMaterial(material),
      dynamicVertex: shape.isVertexBufferDynamic === true,
      dynamicIndex: shape.isIndexBufferDynamic === true,
    };
  };

  const createInput = (arg: Record<string, unknown>): ModelDataInput => {
    const list = Array.isArray(arg.shapes) ? arg.shapes : [arg];
    const shapes: ModelDataShapeInput[] = [];
    for (let i = 0; i < list.length; i++) {
      let item: unknown;
      try {
        item = list[i];
      } catch {
        break; // 取元素抛错：静默停在那里，前面的照收
      }
      shapes.push(createShape(item));
    }
    if (shapes.length === 0) throw new ModelDataError(0, "Shapes missing.");
    const lo = arg.boundingBoxMins;
    let bounds: number[] | null = null;
    if (isObject(lo)) {
      const hi = arg.boundingBoxMaxs;
      if (isObject(hi)) bounds = [...readVec3(lo), ...readVec3(hi)];
    }
    return { shapes, bounds };
  };

  /** 更新时的形状：`null` 是删形状标志，别的非对象是全零形状（什么都不改）；缺的键不改。 */
  const updateShape = (shape: unknown): ModelDataUpdate => {
    if (shape === null) return { deleteShape: true };
    if (!isObject(shape)) return {};
    const update: ModelDataUpdate = {};
    if (typedName(shape.vertexBuffer) === "Float32Array") update.vertices = bytesOf(shape.vertexBuffer);
    const indexBuffer = shape.indexBuffer;
    if (indexBuffer === null) update.dropIndex = true;
    else {
      const index = parseIndex(indexBuffer);
      if (index) update.index = index;
    }
    const format = parseFormat(shape.vertexFormat);
    if (format !== 0) update.format = format;
    if (typeof shape.material === "string" && shape.material !== "")
      update.material = context.rewriteMaterial(shape.material);
    if (typeof shape.isVertexBufferDynamic === "boolean") update.dynamicVertex = shape.isVertexBufferDynamic;
    if (typeof shape.isIndexBufferDynamic === "boolean") update.dynamicIndex = shape.isIndexBufferDynamic;
    return update;
  };

  const updateList = (arg: unknown): ModelDataUpdate[] => {
    // S17：`applyData()` / `replaceData()` 留给脚本的是 V8 读 undefined 的 TypeError
    if (arg === undefined) throw context.typeError("Cannot read properties of undefined (reading 'boundingBoxMins')");
    let list: unknown[];
    if (Array.isArray(arg)) list = arg;
    else if (isObject(arg)) list = Array.isArray(arg.shapes) ? arg.shapes : [arg];
    else list = [arg]; // null 是一个 null 形状，数字等是全零形状
    const updates: ModelDataUpdate[] = [];
    for (let i = 0; i < list.length; i++) {
      let item: unknown;
      try {
        item = list[i];
      } catch {
        break;
      }
      updates.push(updateShape(item));
    }
    if (updates.length === 0) throw new ModelDataError(0, "Shapes missing.");
    return updates;
  };

  const method = (replace: boolean) =>
    function (this: unknown, ...args: unknown[]): undefined {
      const token = typeof this === "object" && this !== null ? tokens.get(this) : undefined;
      if (token === undefined) return undefined;
      // S13：只看当前回调是不是 `update`（含字段脚本的 `update`），`applyData` 不限
      if (replace && context.activeCallback() === "update")
        throw context.syntaxError("IModelData.replace cannot be called in update.");
      const store = context.store();
      if (!store) return undefined;
      try {
        const updates = updateList(args[0]);
        if (replace) store.replace(token, updates, context.materialCheck() ?? (() => 0));
        else store.apply(token, updates);
      } catch (error) {
        raise(error);
      }
      return undefined;
    };
  // S12：所有句柄共用同一个函数对象
  const applyData = method(false);
  const replaceData = method(true);

  const handleOf = (token: number): object => {
    const Obj = context.global.Object as ObjectConstructor;
    const ctor = context.global.IModelData as { prototype?: object } | undefined;
    prototype ??= ctor?.prototype;
    const handle = Obj.create(prototype ?? Obj.prototype);
    Obj.defineProperty(handle, "__modelDataToken", {
      value: token,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    for (const [name, fn] of [
      ["applyData", applyData],
      ["replaceData", replaceData],
    ] as const)
      Obj.defineProperty(handle, name, { value: fn, writable: true, enumerable: true, configurable: true });
    tokens.set(handle, token);
    return handle;
  };

  context.sceneMethod("createModelData", (...args) => {
    const store = context.store();
    const check = context.materialCheck();
    if (!store || !check) return null;
    const arg = args[0];
    if (!isObject(arg)) return null; // S2
    let token: number;
    try {
      token = store.create(createInput(arg), check);
    } catch (error) {
      return raise(error);
    }
    return handleOf(token);
  });

  context.sceneMethod("destroyModelData", (...args) => {
    const arg = args[0];
    let token: number | undefined;
    // D1：`IModelData` 句柄与 Uint32 数字 token 都收（WPE 只收数字）
    if (typeof arg === "object" && arg !== null) token = tokens.get(arg);
    else if (typeof arg === "number" && Number.isInteger(arg) && arg >= 0 && arg <= 0xffffffff) token = arg;
    if (token !== undefined) context.store()?.releaseScript(token);
    return undefined;
  });

  return { isHandle: (value) => typeof value === "object" && value !== null && tokens.has(value) };
}
