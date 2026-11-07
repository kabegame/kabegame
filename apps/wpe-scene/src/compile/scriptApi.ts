/**
 * 场景脚本用到「WPE 有、我们还没实现」的 API 时，整张场景报不支持、退回预览图（用户定，2026-11-07）。
 *
 * 起因：工坊 3304642534 的可视化脚本在 `init` 里调 `thisScene.createLayer` 造另外 63 根音频条；我们没实现它，`init` 报错被禁用，
 * `update` 每帧抛错又被脚本自己的 `try/catch` 吞掉，画面静默缺了整组条。所以改成编译期静态拒绝：扫描每段会执行的脚本源码，
 * 找出对下表成员的调用或访问，报 `script:api:<分组>.<成员>`。脚本运行期的普通错误仍只进脚本诊断（3b 约定不变）。
 *
 * **表的来源**：WPE 2.8.42 自带的编辑器补全声明 `ui/dist/monaco/autocomplete/lib.sceneScript.d.ts`（文件头
 * 「OFFICIAL SCENESCRIPT TYPE DECLARATION - VERSION 2.8」，SHA-256 前缀 `7451b433`），以及逆向报告
 * `.claude/plans/wpe-import/3-scene/phase3/p3-script-REPORT.md` 的 C 节（全局与 `engine`）、L1 / L14 节（`thisScene` 的 47 个字段
 * 与 14 个方法）。逐项减去 `script/api.ts`、`script/environment.ts` 与 `baseclasses.js` 实际提供的成员。图层成员名在
 * `wallpaper64.exe`、场景与 engine 成员名在 `scenescript64.dll` 里都能找到字符串（2026-11-07 核对）。
 * 声明里的 `renderContext` 两个二进制里都没有，不是 2.8.42 的 API，不收。
 *
 * **实现了某个 API，就把它从表里删掉**。`script/api.test.ts` 双向核对：表里的成员确实不在 `ScriptApi` 的对象上，那些对象上
 * 已有的成员也不在表里；`scriptApi.test.ts` 核对表里的名字都出自上述声明或报告（本机测试）。
 *
 * **分组**（键里的 `<分组>`）：
 * - `thisScene` / `engine` / `input` / `localStorage` / `console`：全局对象，按「根对象.成员」匹配。`localStorage`、`console`
 *   目前没有缺口（`console` 在 WPE 里只有 `log` / `error`，`localStorage` 没有 `remove`，这两个不是 WPE 的 API）；`shared`、
 *   `Vec*` / `Mat*` 来自 `baseclasses.js`，已有。
 * - `layer`（`ILayer` 及它合并的 `IImageLayer` / `ISoundLayer` / `IEffectLayer` / `ITextLayer` / `IParticleSystem` / `IModelLayer` /
 *   `ICamera`）、`effect`（`IEffect`）、`object`（`IObject`，所有对象都有的 `getAnimation`）：按类型分组，不按接收者变量分组。
 *   同一个成员可能经 `thisLayer`、`thisObject` 或任意变量（`let bar = thisScene.getLayer(…)`）访问，一个表项对应一个键。
 * - `thisObject` 不是单独的分组，按脚本挂在哪里解析（3b，与 `ScriptApi.owner` 一致）：图层 → `layer`，effect → `effect`，
 *   材质常量 → 材质（成员是 pass 的材质常量，编译期查不到全表，只认 `object`），general → 场景字段（L14：只有字段没有方法），
 *   键写 `thisScene.<字段>`。`thisLayer` 在 general 上的脚本里就是 `thisObject`，其余情况是所在图层。
 *
 * **匹配方式**（`match`）：
 * - `root`：只认根对象直接访问。全局对象的成员都用它；图层等类型里名字通用的（`play`、`stop`、`text`、`volume` 这类，
 *   会和普通 JS 或脚本自己的对象撞名）只认 `thisLayer.` / `thisObject.`。
 * - `any`：任意接收者上的 `.成员` / `?.成员` / `["成员"]` 都算，只收名字足够独特的，每项写一句理由。
 * 子对象（`ITextureAnimation`、`IVideoTexture`、`IAnimationLayer`、`IAnimation`、`IModelData`、`IAssetHandle`）只能经表里的入口方法拿到，
 * 入口已经会报，它们自己的成员（`setFrame`、`play`、`applyData` …）不收。
 */

export type ScriptApiGroup =
  "thisScene" | "engine" | "input" | "localStorage" | "console" | "layer" | "effect" | "object";

export interface MissingScriptApi {
  readonly name: string;
  /** general 上的 `thisObject` 只有字段（L14），在那里只匹配 `field`。 */
  readonly kind: "method" | "field";
  readonly match: "root" | "any";
  /** `any` 必填：为什么这个名字不会和普通代码撞名。 */
  readonly why?: string;
}

const UNIQUE = "WPE 专有名字，JS 内置与 `baseclasses.js` / jsmodules 里都没有";

function methods(match: "root" | "any", names: readonly string[], why?: string): MissingScriptApi[] {
  return names.map((name) => ({ name, kind: "method", match, ...(why ? { why } : {}) }));
}
function fields(names: readonly string[]): MissingScriptApi[] {
  return names.map((name) => ({ name, kind: "field", match: "root" }));
}

/** WPE 有、我们没实现的脚本 API。 */
export const MISSING_SCRIPT_API: Readonly<Record<ScriptApiGroup, readonly MissingScriptApi[]>> = {
  /** `IScene` 14 个方法里实现了 `getLayer` / `getLayerCount` / `getLayerIndex` / `enumerateLayers`（3b）。 */
  thisScene: [
    // 建层删层与排序、模型数据 → P6；相机变换本机语料 0 处（L15）
    ...methods("root", [
      "getLayerByID",
      "createLayer",
      "destroyLayer",
      "sortLayer",
      "getInitialLayerConfig",
      "getCameraTransforms",
      "setCameraTransforms",
      "getAnimation",
      "createModelData",
      "destroyModelData",
    ]),
    // L1 的 47 个字段里 `general` 还没接的 21 个（已接的见 `GENERAL_FIELDS`、`BLOOM_FIELDS` 与 `bloom` / `hdr`）。
    // 重力与风渲染器不读（能力表把它们当中性），但脚本读到 undefined 会算出 NaN，照收
    ...fields([
      "fogdistance",
      "fogheight",
      "fogdistancecolor",
      "fogheightcolor",
      "fogdistancestart",
      "fogdistanceend",
      "fogdistancestartdensity",
      "fogdistanceenddensity",
      "fogheightstart",
      "fogheightend",
      "fogheightstartdensity",
      "fogheightenddensity",
      "perspectiveoverridefov",
      "zoom",
      "transparentsorting",
      "customsortorder",
      "gravitydirection",
      "gravitystrength",
      "windenabled",
      "winddirection",
      "windstrength",
    ]),
  ],
  /** `requestFeatures` 声明里没有，DLL 有（报告 C）；`isObjectValid`、`clearTimeout` 已实现。 */
  engine: methods("root", ["registerAsset", "openUserShortcut", "requestFeatures"]),
  /** 整个 `input` 都没有（W4）。 */
  input: fields(["cursorWorldPosition", "cursorScreenPosition", "cursorLeftDown"]),
  localStorage: [],
  console: [],
  /** 已实现：`name`、`id`、`size`（只读）、`origin`、`scale`、`angles`、`alpha`、`color`、`visible`、`brightness`。 */
  layer: [
    // 层级与变换（W1 / W5）
    ...methods("any", ["getTransformMatrix", "rotateObjectSpace", "lookAtYaw"], UNIQUE),
    ...methods("any", ["setParent", "getParent", "getChildren"], `${UNIQUE}；DOM 用的是 \`parentNode\` / \`children\``),
    ...methods(
      "any",
      ["getAttachmentIndex", "getAttachmentMatrix", "getAttachmentOrigin", "getAttachmentAngles"],
      UNIQUE,
    ),
    // `Mat4.lookAt` 是 `baseclasses.js` 的静态方法（1112 行），只按名字会误报
    ...methods("root", ["lookAt"]),
    // 纹理动画、视频、动画层、骨骼与混合形状（W5 / P6）
    ...methods(
      "any",
      [
        "getTextureAnimation",
        "getVideoTexture",
        "getAnimationLayerCount",
        "getAnimationLayer",
        "createAnimationLayer",
        "playSingleAnimation",
        "destroyAnimationLayer",
      ],
      UNIQUE,
    ),
    ...methods(
      "any",
      [
        "getBoneCount",
        "getBoneTransform",
        "setBoneTransform",
        "getLocalBoneTransform",
        "setLocalBoneTransform",
        "getLocalBoneAngles",
        "setLocalBoneAngles",
        "getLocalBoneOrigin",
        "setLocalBoneOrigin",
        "getBoneIndex",
        "getBoneParentIndex",
        "applyBonePhysicsImpulse",
        "resetBonePhysicsSimulation",
        "getBlendShapeIndex",
        "getBlendShapeWeight",
        "setBlendShapeWeight",
      ],
      UNIQUE,
    ),
    // effect 访问（3c 待定 3）
    ...methods("any", ["getEffect", "getEffectCount", "transformAttachmentToTexture"], UNIQUE),
    // 粒子（P4f）
    ...methods("any", ["emitParticles"], UNIQUE),
    // 声音 / 粒子 / 动画共用的播放控制：名字通用（`isPlaying` 也常是脚本自己记播放状态的字段），只认根对象
    ...methods("root", ["play", "pause", "stop", "isPlaying"]),
    // 字段：写入在我们这边落成普通属性、不报错也不生效。名字大多通用，只认根对象
    ...fields([
      "parallaxDepth",
      "alignment",
      "volume",
      "perspective",
      "solid",
      "rootmotion",
      "fov",
      "zoom",
      "instance",
      "text",
      "opaquebackground",
      "backgroundcolor",
      "pointsize",
      "font",
      "padding",
      "horizontalalign",
      "verticalalign",
      "anchor",
      "limitrows",
      "maxrows",
      "limitwidth",
      "maxwidth",
    ]),
  ],
  /** `IEffect`：已实现 `visible`。 */
  effect: [
    ...methods(
      "any",
      ["getMaterial", "getMaterialCount", "setMaterialProperty", "executeMaterialFunction"],
      `${UNIQUE}；材质常量在我们这边是材质对象上的字段，不经这些方法`,
    ),
    ...fields(["name"]),
  ],
  /** `IObject`：所有对象（图层、effect、材质、动画层、模型数据）都有。`thisScene.getAnimation` 另在 `thisScene` 组。 */
  object: methods("any", ["getAnimation"], UNIQUE),
};

// ---------------------------------------------------------------------------------------------------------------------
// 词法：只为找成员访问，不是完整的 JS 解析器。注释、字符串、模板字面量的文字部分、正则字面量都不产出名字；
// 模板里的 `${…}` 照常分词。

type Token =
  | { type: "name"; value: string }
  | { type: "punct"; value: string }
  /** 字符串字面量；`value` 是原文去掉引号（不处理转义，只用于 `obj["成员"]`）。 */
  | { type: "string"; value: string }
  /** 数字、正则、模板字面量：只占位，后面的 `/` 是除号。 */
  | { type: "literal" };

/** 这些关键字后面的 `/` 开始正则字面量（其余名字后面是除号）。 */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
/** 标识符字符：ASCII 字母数字、`_`、`$`，非 ASCII 字符一律算（宽松，只用来切词）。 */
function identStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c) || c.charCodeAt(0) >= 0x80;
}
function identPart(c: string): boolean {
  return /[\w$]/.test(c) || c.charCodeAt(0) >= 0x80;
}

/** 把脚本源码切成粗粒度的词：够用来认出 `a.b`、`a?.b`、`a["b"]`。 */
export function tokenizeScript(source: string): Token[] {
  const tokens: Token[] = [];
  /** 每层模板插值里未闭合的 `{` 数；遇到配对的 `}` 时回到模板文字。 */
  const templates: number[] = [];
  let i = 0;
  const n = source.length;
  const regexAllowed = () => {
    const last = tokens.at(-1);
    if (!last) return true;
    if (last.type === "literal" || last.type === "string") return false;
    if (last.type === "name") return REGEX_AFTER.has(last.value);
    return last.value !== ")" && last.value !== "]" && last.value !== "}";
  };
  /** 从 `i`（反引号之后或 `}` 之后）读模板文字，读到结尾反引号或 `${`。 */
  const templateText = () => {
    while (i < n) {
      const c = source[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        tokens.push({ type: "literal" });
        return;
      } else if (c === "$" && source[i + 1] === "{") {
        i += 2;
        templates.push(0);
        return;
      } else i++;
    }
  };
  while (i < n) {
    const c = source[i];
    // JS 正则的 `\s` 正好是语言里的空白与换行
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = ++i;
      while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      tokens.push({ type: "string", value: source.slice(start, Math.min(i, n)) });
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      templateText();
      continue;
    }
    if (c === "}" && templates.length && templates.at(-1) === 0) {
      templates.pop();
      i++;
      templateText();
      continue;
    }
    if (c === "/" && regexAllowed()) {
      // 正则字面量：到不在字符类里的 `/` 为止；遇到换行说明判断错了，退回当除号
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== "\n") {
        const d = source[j];
        if (d === "/" && !inClass) {
          closed = true;
          break;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        j += d === "\\" ? 2 : 1;
      }
      if (closed) {
        i = j + 1;
        while (i < n && identPart(source[i])) i++;
        tokens.push({ type: "literal" });
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      i++;
      while (i < n && /[\w.]/.test(source[i])) i++;
      tokens.push({ type: "literal" });
      continue;
    }
    if (identStart(c) || c === "#") {
      const start = i++;
      while (i < n && identPart(source[i])) i++;
      tokens.push({ type: "name", value: source.slice(start, i) });
      continue;
    }
    // `?.` 后面跟数字是条件运算（`a?.5:1`），不是可选链
    if (c === "?" && source[i + 1] === "." && !/[0-9]/.test(source[i + 2] ?? "")) {
      tokens.push({ type: "punct", value: "?." });
      i += 2;
      continue;
    }
    if (c === "." && source[i + 1] === "." && source[i + 2] === ".") {
      tokens.push({ type: "punct", value: "..." });
      i += 3;
      continue;
    }
    if (c === "{" && templates.length) templates[templates.length - 1]++;
    else if (c === "}" && templates.length) templates[templates.length - 1]--;
    tokens.push({ type: "punct", value: c });
    i++;
  }
  return tokens;
}

/** 一处成员访问：`root` 是接收者为裸全局名时的名字（`thisScene.x` 的 `thisScene`），否则 null。 */
export interface MemberAccess {
  root: string | null;
  name: string;
}

function isDot(token: Token | undefined): boolean {
  return token?.type === "punct" && (token.value === "." || token.value === "?.");
}

/** 找出全部 `x.名字`、`x?.名字`、`x["名字"]`、`x?.["名字"]`。 */
export function memberAccesses(source: string): MemberAccess[] {
  const tokens = tokenizeScript(source);
  const out: MemberAccess[] = [];
  /** `tokens[at]` 是接收者的最后一个词：它是不跟在 `.` 后面的名字时就是根对象。 */
  const rootAt = (at: number): string | null => {
    const receiver = tokens[at];
    if (receiver?.type !== "name" || isDot(tokens[at - 1])) return null;
    return receiver.value;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (isDot(token) && next?.type === "name") {
      out.push({ root: rootAt(i - 1), name: next.value });
      continue;
    }
    // `x["名字"]`：`[` 前面要是能当接收者的东西（名字、`)`、`]`），否则是数组字面量
    const open = token.type === "punct" && token.value === "[" ? i : -1;
    if (open < 0) continue;
    const before = tokens[open - 1];
    const optional = before?.type === "punct" && before.value === "?.";
    const receiverAt = optional ? open - 2 : open - 1;
    const receiver = tokens[receiverAt];
    const indexable =
      receiver?.type === "name"
        ? !REGEX_AFTER.has(receiver.value)
        : receiver?.type === "punct" && /[)\]]/.test(receiver.value);
    const key = tokens[open + 1];
    const close = tokens[open + 2];
    if (indexable && key?.type === "string" && close?.type === "punct" && close.value === "]")
      out.push({ root: rootAt(receiverAt), name: key.value });
  }
  return out;
}

/** 扫描用到的脚本信息（`SceneScript` 的子集）。 */
export interface ScriptApiContext {
  source: string;
  owner: { kind: "layer" | "material" | "effect" | "general" };
  /** 所在图层的 objects 下标；general 上的脚本为 null。 */
  layer: number | null;
}

/** 根对象解析出的分组：表里的分组，加上 general 上的 `thisObject`（场景字段）与材质常量的 `thisObject`。 */
type ResolvedGroup = ScriptApiGroup | "general" | "material";

/** 根对象解析成表的分组；不认识的名字（局部变量等）返回 null。 */
function rootGroup(root: string, script: ScriptApiContext): ResolvedGroup | null {
  switch (root) {
    case "thisScene":
    case "engine":
    case "input":
    case "localStorage":
    case "console":
      return root;
    case "thisLayer":
      return script.layer === null ? "general" : "layer";
    case "thisObject":
      return script.owner.kind;
    default:
      return null;
  }
}

/** 成员名 → 键（`<分组>.<成员>`）。 */
function index(groups: ScriptApiGroup[], keep: (entry: MissingScriptApi) => boolean = () => true): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groups)
    for (const entry of MISSING_SCRIPT_API[group]) if (keep(entry)) map.set(entry.name, `${group}.${entry.name}`);
  return map;
}

/** 经根对象能访问的表项；`object` 组的成员所有对象都有。 */
const ROOT_INDEX: Readonly<Record<ResolvedGroup, Map<string, string>>> = {
  thisScene: index(["thisScene"]),
  engine: index(["engine"]),
  input: index(["input"]),
  localStorage: index(["localStorage"]),
  console: index(["console"]),
  layer: index(["object", "layer"]),
  effect: index(["object", "effect"]),
  object: index(["object"]),
  material: index(["object"]),
  // L14：general 上的 thisObject 有场景的全部字段，没有方法
  general: index(["thisScene"], (entry) => entry.kind === "field"),
};
const ANY_INDEX = index(Object.keys(MISSING_SCRIPT_API) as ScriptApiGroup[], (entry) => entry.match === "any");

/**
 * 一段脚本用到的未实现 API，返回 `<分组>.<成员>`（去重、排序）。根对象访问先查该分组（含 `root` 项），查不到再按名字查 `any` 项；
 * 其它接收者只查 `any` 项。
 */
export function scanScriptApi(script: ScriptApiContext): string[] {
  const hits = new Set<string>();
  for (const access of memberAccesses(script.source)) {
    const group = access.root === null ? null : rootGroup(access.root, script);
    const key = (group ? ROOT_INDEX[group].get(access.name) : undefined) ?? ANY_INDEX.get(access.name);
    if (key) hits.add(key);
  }
  return [...hits].sort();
}
