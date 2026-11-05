import { init, parse } from "es-module-lexer";
import type { SceneScripts } from "../compile/scripts";
import { fileToUrl } from "../fileUrl";
import { alignScriptEnvironment } from "./environment";
import type { ScriptRealm } from "./runtime";

export interface JsModule {
  url: string;
  imports: string[];
}

export interface JsModuleIndex {
  lookup(name: string): Promise<JsModule | null>;
  readonly fetchCount: number;
  readonly cacheHits: number;
}

type FetchModule = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
const indexes = new Map<string, JsModuleIndexImpl>();
const BARE_NAME = /^(?![./]|[a-z][\w+.-]*:)[\w-]+$/i;

function assetUrl(root: string, relative: string): string {
  return fileToUrl(`${root.replace(/[\\/]$/, "")}/${relative}`);
}

export class JsModuleIndexImpl implements JsModuleIndex {
  private readonly cache = new Map<string, Promise<JsModule | null>>();
  fetchCount = 0;
  cacheHits = 0;

  constructor(
    private readonly sceneAssets: readonly string[],
    private readonly fetchModule: FetchModule = (url) => fetch(url),
  ) {}

  lookup(name: string): Promise<JsModule | null> {
    const lower = name.toLowerCase();
    const cached = this.cache.get(lower);
    if (cached) {
      this.cacheHits++;
      return cached;
    }
    const task = this.read(lower);
    this.cache.set(lower, task);
    return task;
  }

  private async read(lower: string): Promise<JsModule | null> {
    await init;
    for (const root of this.sceneAssets) {
      const url = assetUrl(root, `scripts/jsmodules/${lower}.js`);
      this.fetchCount++;
      let response: Awaited<ReturnType<FetchModule>>;
      try {
        response = await this.fetchModule(url);
      } catch (error) {
        if (error instanceof TypeError) continue;
        throw error;
      }
      if (!response.ok) continue;
      const source = await response.text();
      const imports = parse(source)[0].flatMap((entry) => (typeof entry.n === "string" ? [entry.n] : []));
      return { url, imports: [...new Set(imports)] };
    }
    return null;
  }
}

/** 同一宿主、同一组 assets 共用扫描结果。 */
export function getJsModuleIndex(sceneAssets: readonly string[]): JsModuleIndex {
  const key = JSON.stringify(sceneAssets);
  let index = indexes.get(key);
  if (!index) {
    index = new JsModuleIndexImpl([...sceneAssets]);
    indexes.set(key, index);
  }
  return index;
}

export async function buildScriptImportMap(
  scripts: SceneScripts,
  modules: Pick<JsModuleIndex, "lookup">,
): Promise<Record<string, string>> {
  const imports: Record<string, string> = {};
  const visited = new Set<string>();
  async function add(name: string): Promise<void> {
    if (!BARE_NAME.test(name)) return;
    const lower = name.toLowerCase();
    const module = await modules.lookup(lower);
    if (!module) return;
    imports[name] = module.url;
    if (visited.has(lower)) return;
    visited.add(lower);
    for (const dependency of module.imports) await add(dependency);
  }
  for (const script of scripts.list) for (const name of script.imports) await add(name);
  return imports;
}

type ChildWindow = Window & typeof globalThis;

function syntaxPosition(child: ChildWindow, source: string): Promise<{ line: number; col: number } | null> {
  return new Promise((resolve) => {
    const url = child.URL.createObjectURL(new child.Blob([source], { type: "text/javascript" }));
    const script = child.document.createElement("script");
    script.type = "module";
    script.src = url;
    let finished = false;
    const done = (position: { line: number; col: number } | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeEventListener("error", onError);
      script.remove();
      child.URL.revokeObjectURL(url);
      resolve(position);
    };
    const onError = (event: ErrorEvent) => {
      if (event.filename === url && event.lineno > 0 && event.colno > 0) done({ line: event.lineno, col: event.colno });
    };
    const timer = setTimeout(() => done(null), 1000);
    child.addEventListener("error", onError);
    child.document.head.appendChild(script);
  });
}

export interface CreateIframeRealmInput {
  document: Document;
  scripts: SceneScripts;
  sceneAssets: readonly string[];
  modules: JsModuleIndex;
  console: { log(text: string): void; error(text: string): void };
  /**
   * 环境改写：子 frame 建好后、执行 baseclasses 之前调用，用子 frame 的全局造 WPE `localStorage` 对象。
   * 存储后端与作用域检查由调用方决定（见 `script/api.ts` 的 `createWpeLocalStorage`）。
   */
  localStorage: (global: Record<string, unknown>) => object;
}

export async function createIframeRealm(
  input: CreateIframeRealmInput,
): Promise<ScriptRealm & { readonly importMap: Readonly<Record<string, string>> }> {
  const frame = input.document.createElement("iframe");
  frame.style.display = "none";
  frame.dataset.kbScriptRealm = "1";
  input.document.body.appendChild(frame);
  try {
    let child: ChildWindow | null = frame.contentWindow as ChildWindow | null;
    if (!child) throw new Error("无法创建场景脚本 frame");
    const scriptGlobal = child as unknown as Record<string, unknown>;
    alignScriptEnvironment(child, input.console, input.localStorage(scriptGlobal));
    const importMap = await buildScriptImportMap(input.scripts, input.modules);
    const map = child.document.createElement("script");
    map.type = "importmap";
    map.textContent = JSON.stringify({ imports: importMap });
    child.document.head.appendChild(map);

    let loaded = false;
    for (const root of input.sceneAssets) {
      const url = assetUrl(root, "scripts/jsclasses/baseclasses.js");
      const script = child.document.createElement("script");
      script.src = url;
      try {
        await new Promise<void>((resolve, reject) => {
          script.onload = () => resolve();
          script.onerror = () => reject(new Error(`baseclasses.js 加载失败：${url}`));
          child!.document.head.appendChild(script);
        });
        loaded = true;
        break;
      } catch {
        script.remove();
      }
    }
    if (!loaded) throw new Error("baseclasses.js 加载失败：所有 sceneAssets 均不可读");
    const global = child as unknown as Record<string, unknown>;
    const internal = global._Internal as ScriptRealm["internal"] | undefined;
    if (
      !internal ||
      typeof internal.updateScriptProperties !== "function" ||
      typeof internal.convertUserProperties !== "function"
    )
      throw new Error("baseclasses.js 缺少 _Internal");
    const prototypes = {
      Vec2: global._Vec2 as object,
      Vec3: global._Vec3 as object,
      Vec4: global._Vec4 as object,
      Mat3: global._Mat3 as object,
      Mat4: global._Mat4 as object,
    };
    if (Object.values(prototypes).some((value) => !value)) throw new Error("baseclasses.js 缺少向量或矩阵原型");
    let heldGlobal: Record<string, unknown> | null = global;
    let heldInternal: ScriptRealm["internal"] | null = internal;
    let heldPrototypes: typeof prototypes | null = prototypes;
    let heldFrame: HTMLIFrameElement | null = frame;
    return {
      get global() {
        if (!heldGlobal) throw new Error("脚本 realm 已释放");
        return heldGlobal;
      },
      get internal() {
        if (!heldInternal) throw new Error("脚本 realm 已释放");
        return heldInternal;
      },
      get prototypes() {
        if (!heldPrototypes) throw new Error("脚本 realm 已释放");
        return heldPrototypes;
      },
      importMap,
      async importModule(source: string, _label: string): Promise<Record<string, unknown>> {
        if (!child) throw new Error("脚本 realm 已释放");
        const activeChild = child;
        const url = activeChild.URL.createObjectURL(new activeChild.Blob([source], { type: "text/javascript" }));
        try {
          const importer = new activeChild.Function("u", "return import(u)") as (
            url: string,
          ) => Promise<Record<string, unknown>>;
          return await importer(url);
        } catch (error) {
          const stack = (error as { stack?: unknown })?.stack;
          if ((error as { name?: string })?.name === "SyntaxError" && !/blob:[^\s)]+:\d+:\d+/.test(String(stack))) {
            const position = await syntaxPosition(activeChild, source);
            if (position) {
              const object = error as { message?: string };
              object.message = `${object.message ?? String(error)} (line ${position.line}, col ${position.col})`;
            }
          }
          throw error;
        } finally {
          activeChild.URL.revokeObjectURL(url);
        }
      },
      dispose(): void {
        heldFrame?.remove();
        heldFrame = null;
        child = null;
        heldGlobal = null;
        heldInternal = null;
        heldPrototypes = null;
      },
    };
  } catch (error) {
    frame.remove();
    throw error;
  }
}
