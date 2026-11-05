/**
 * 脚本报错归类的纯逻辑：dev 语料（`scriptCorpus`）按根因统计「缺失的 API」，而不是按报错字面量，
 * 这样经变量调用、以及读到 undefined 之后的连带错误都不会把排行冲散。
 */

export type ScriptErrorKind =
  /** 直接点名缺失的 WPE API（`engine.registerAudioBuffers`、`input`…）。 */
  | "api"
  /** 经变量调用缺失的成员（`video.getVideoTexture`、`audioLayer.play`…）：报错没点出接收者的类型。 */
  | "indirect"
  /** 读到 undefined 之后的连带错误（`Cannot read properties of undefined`）。 */
  | "consequential"
  /** 样本自身的错（伪代码里的 `scene`）。 */
  | "sample"
  /** 其它（如给布尔值加属性的样本错误）。 */
  | "other";

export interface ScriptErrorClass {
  kind: ScriptErrorKind;
  /** 归类后的名字：缺失的 API、经变量调用的成员名，或整条报错文本。 */
  name: string;
}

/** 有具名 API 根的全局；`X.y is not a function` 里的 `X` 属于这里时按缺失 API 计。 */
const API_ROOTS = new Set([
  "engine",
  "thisLayer",
  "thisObject",
  "thisScene",
  "input",
  "localStorage",
  "console",
  "shared",
]);

/** 回调前缀（`runtime` 记录错误时加上的）与尾部的 `(line L, col C)`。 */
const CALLBACK_PREFIX = /^(?:eval|init|update|applyUserProperties|destroy|timer):\s*/;
const SOURCE_POSITION = /\s*\(line \d+, col \d+\)\s*$/;

/** 把一条脚本报错按根因归类。 */
export function classifyScriptError(message: string): ScriptErrorClass {
  const text = message.trim().replace(CALLBACK_PREFIX, "").replace(SOURCE_POSITION, "").trim();
  const notDefined = /^([A-Za-z_$][\w$]*) is not defined$/.exec(text);
  if (notDefined) {
    const name = notDefined[1];
    if (name === "scene") return { kind: "sample", name };
    return { kind: API_ROOTS.has(name) ? "api" : "other", name };
  }
  const apiMember =
    /^(engine|thisLayer|thisObject|thisScene|input|localStorage|console)\.([A-Za-z_$][\w$]*) is not a function$/.exec(
      text,
    );
  if (apiMember) {
    const name = `${apiMember[1]}.${apiMember[2]}`;
    // WPE 的 console 只有 log / error，localStorage 没有 remove：样本调用时 WPE 同样报错，不是缺失 API
    const sample = apiMember[1] === "console" || name === "localStorage.remove";
    return { kind: sample ? "sample" : "api", name };
  }
  // 接收者是变量（可能带下标）：报错只知道成员名，归到 indirect
  const indirect = /^(?:[A-Za-z_$][\w$]*(?:\[[^\]]*\])?\.)+([A-Za-z_$][\w$]*) is not a function$/.exec(text);
  if (indirect) return { kind: "indirect", name: indirect[1] };
  const readUndefined = /^Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '([^']*)'\)$/.exec(text);
  if (readUndefined) return { kind: "consequential", name: readUndefined[1] };
  return { kind: "other", name: text };
}
