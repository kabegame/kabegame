<template>
  <div ref="rootRef" class="rhai-editor-root" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { Registry } from "monaco-textmate";
import { wireTmGrammars } from "monaco-editor-textmate";
import { loadWASM } from "onigasm";
import onigasmWasmUrl from "onigasm/lib/onigasm.wasm?url";
import rhaiTmGrammarJson from "vscode-rhai/syntax/rhai.tmLanguage.json?raw";
import rhaiVsCodeLanguageConfig from "vscode-rhai/syntax/rhai.configuration.json";
import themeDracula from "monaco-themes/themes/Dracula.json";
import themeGithubDark from "monaco-themes/themes/GitHub Dark.json";
import themeGithubLight from "monaco-themes/themes/GitHub Light.json";
import themeNightOwl from "monaco-themes/themes/Night Owl.json";
import themeSolarizedDark from "monaco-themes/themes/Solarized-dark.json";
import themeSolarizedLight from "monaco-themes/themes/Solarized-light.json";
// Monaco ESM 里 editor.api 不会自动带贡献功能，需要显式引入补全/悬浮等贡献
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestWidget";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding";

type MonacoMarkerSeverity = 1 | 2 | 4 | 8;

type EditorMarker = {
  message: string;
  severity: MonacoMarkerSeverity;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

type ApiDoc = {
  signature: string;
  markdown: string;
  params?: { label: string; documentation?: string }[];
};

type UserVarDoc = {
  key: string;
  type?: string;
  name?: string;
  descripts?: string;
  default?: unknown;
};

type ConstVarDoc = {
  key: string;
  type?: string;
  name?: string;
  descripts?: string;
  value?: unknown;
};

// 轻量的 API 文档数据源：用于补全详情、悬浮文档、参数签名提示
const RHAI_API_DOCS: Record<string, ApiDoc> = {
  print: {
    signature: "print(text)",
    markdown: ["**print(text)**", "", "输出一行日志。"].join("\n"),
    params: [{ label: "text", documentation: "要输出的内容（会被转换为字符串）。" }],
  },
  debug: {
    signature: "debug(text)",
    markdown: ["**debug(text)**", "", "输出调试日志。"].join("\n"),
    params: [{ label: "text", documentation: "要输出的内容。" }],
  },
  to: {
    signature: "to(url)",
    markdown: [
      "**to(url)**",
      "",
      "访问一个网页，将当前页面入栈。",
      "",
      "- 参数：`url` (string) 绝对/相对 URL",
      "- 返回：`()` 成功；`String` 失败时的错误信息",
    ].join("\n"),
    params: [{ label: "url", documentation: "要访问的 URL，支持绝对/相对。" }],
  },
  to_json: {
    signature: "to_json(url)",
    markdown: [
      "**to_json(url)**",
      "",
      "访问一个 JSON API，返回 JSON 对象（Map）。",
      "",
      "- 参数：`url` (string) 绝对/相对 URL",
      "- 返回：`Map`（如果响应不是对象，会包在 `data` 字段里）",
    ].join("\n"),
    params: [{ label: "url", documentation: "JSON API 的 URL。" }],
  },
  back: {
    signature: "back()",
    markdown: ["**back()**", "", "返回上一页，从页面栈中弹出当前页面。"].join("\n"),
    params: [],
  },
  current_url: {
    signature: "current_url()",
    markdown: ["**current_url()**", "", "获取当前栈顶页面的 URL。"].join("\n"),
    params: [],
  },
  current_html: {
    signature: "current_html()",
    markdown: ["**current_html()**", "", "获取当前栈顶页面的 HTML 内容。"].join("\n"),
    params: [],
  },
  query: {
    signature: "query(selector)",
    markdown: [
      "**query(selector)**",
      "",
      "在当前页面查询元素文本内容。支持 CSS 选择器与简单 XPath。",
    ].join("\n"),
    params: [{ label: "selector", documentation: "CSS 选择器或 XPath（以 / 或 // 开头）。" }],
  },
  query_by_text: {
    signature: "query_by_text(text)",
    markdown: [
      "**query_by_text(text)**",
      "",
      "通过文本内容查找包含该文本的元素，返回元素详细信息数组（Map）。",
    ].join("\n"),
    params: [{ label: "text", documentation: "要查找的文本内容。" }],
  },
  find_by_text: {
    signature: "find_by_text(text, tag)",
    markdown: ["**find_by_text(text, tag)**", "", "在指定标签中查找包含指定文本的元素。"].join("\n"),
    params: [
      { label: "text", documentation: "要查找的文本内容。" },
      { label: "tag", documentation: "标签名（如 a/button/div）。" },
    ],
  },
  get_attr: {
    signature: "get_attr(selector, attr)",
    markdown: ["**get_attr(selector, attr)**", "", "获取指定元素的属性值数组。"].join("\n"),
    params: [
      { label: "selector", documentation: "CSS 选择器或 XPath。" },
      { label: "attr", documentation: "属性名（如 href/src/class）。" },
    ],
  },
  resolve_url: {
    signature: "resolve_url(relative)",
    markdown: ["**resolve_url(relative)**", "", "将相对 URL 解析为绝对 URL（基于当前栈顶 URL）。"].join("\n"),
    params: [{ label: "relative", documentation: "相对 URL。" }],
  },
  set_header: {
    signature: "set_header(key, value)",
    markdown: [
      "**set_header(key, value)**",
      "",
      "设置一个 HTTP Header（覆盖同名值）。",
      "",
      "- 仅影响当前任务中由 Rhai 发起的 HTTP 请求（如 `to()` / `to_json()` / `download_image()` / `download_archive()`）",
      "- `key` / `value` 会做合法性校验；不合法会被忽略，并在任务日志中提示",
    ].join("\n"),
    params: [
      { label: "key", documentation: "Header 名（如 Authorization、User-Agent）。" },
      { label: "value", documentation: "Header 值。" },
    ],
  },
  del_header: {
    signature: "del_header(key)",
    markdown: ["**del_header(key)**", "", "删除一个 HTTP Header。"].join("\n"),
    params: [{ label: "key", documentation: "Header 名。" }],
  },
  set_concurrency: {
    signature: "set_concurrency(limit)",
    markdown: [
      "**set_concurrency(limit)**",
      "",
      "设置当前任务的最大并发下载数量。",
      "",
      "- 参数：`limit` (int) 最大并发数（必须大于 0）",
      "- 默认无限制",
    ].join("\n"),
    params: [{ label: "limit", documentation: "最大并发数。" }],
  },
  set_interval: {
    signature: "set_interval(ms)",
    markdown: [
      "**set_interval(ms)**",
      "",
      "设置当前任务下载请求之间的最小间隔时间（毫秒）。",
      "",
      "- 参数：`ms` (int) 最小间隔时间（毫秒）",
      "- 计时基准是“上一个下载完成的时间”",
    ].join("\n"),
    params: [{ label: "ms", documentation: "最小间隔时间（毫秒）。" }],
  },
  is_image_url: {
    signature: "is_image_url(url)",
    markdown: ["**is_image_url(url)**", "", "检查 URL 是否是图片 URL。"].join("\n"),
    params: [{ label: "url", documentation: "要检查的 URL。" }],
  },
  re_is_match: {
    signature: "re_is_match(pattern, text)",
    markdown: [
      "**re_is_match(pattern, text)**",
      "",
      "使用正则表达式判断 `text` 是否匹配 `pattern`（Rust regex 语法）。",
    ].join("\n"),
    params: [
      { label: "pattern", documentation: "正则表达式（Rust regex）。非法正则返回 false。" },
      { label: "text", documentation: "要匹配的文本。" },
    ],
  },
  download_image: {
    signature: "download_image(url)",
    markdown: ["**download_image(url)**", "", "下载图片并加入下载队列（异步）。"].join("\n"),
    params: [{ label: "url", documentation: "图片 URL。" }],
  },
  download_archive: {
    signature: "download_archive(url, type)",
    markdown: [
      "**download_archive(url, type)**",
      "",
      "导入压缩包（异步）。",
      "",
      "- 参数：`url` (string) 压缩包 URL 或本地路径",
      "- 参数：`type` (string | ()) 类型（如 \"zip\", \"rar\"）。传入 \"none\" 或 `()` 可自动检测。",
    ].join("\n"),
    params: [
      { label: "url", documentation: "压缩包 URL 或本地路径。" },
      { label: "type", documentation: "类型（如 \"zip\"）。传入 \"none\" 或 `()` 可自动检测。" },
    ],
  },
  get_supported_archive_types: {
    signature: "get_supported_archive_types()",
    markdown: [
      "**get_supported_archive_types()**",
      "",
      "获取当前系统支持的压缩包类型列表。",
      "",
      "- 返回：`Array<String>` (如 `[\"zip\", \"rar\"]`)",
    ].join("\n"),
    params: [],
  },
  add_progress: {
    signature: "add_progress(p)",
    markdown: ["**add_progress(p)**", "", "上报进度（0~100，或增量，取决于插件实现）。"].join("\n"),
    params: [{ label: "p", documentation: "进度值（float）。" }],
  },
};

const RHAI_API_FN_NAMES = Object.keys(RHAI_API_DOCS);

const props = defineProps<{
  modelValue: string;
  markers: EditorMarker[];
  userVars?: UserVarDoc[];
  baseUrl?: string;
  theme?: string;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: string): void;
}>();

const rootRef = ref<HTMLDivElement | null>(null);

let monaco: typeof import("monaco-editor") | null = null;
let editor: import("monaco-editor").editor.IStandaloneCodeEditor | null = null;
let model: import("monaco-editor").editor.ITextModel | null = null;
let selfUpdate = false;

async function ensureMonacoWorkers() {
  // Vite + monaco-editor：显式指定 worker（推荐写法，避免 new URL + ?worker 的兼容性问题）
  (self as any).MonacoEnvironment = {
    getWorker(_: unknown, label: string) {
      try {
        if (label === "json") {
          return new JsonWorker();
        }
        return new EditorWorker();
      } catch (e) {
        console.error(`[kabegame] Failed to create Monaco worker for label "${label}":`, e);
        throw e;
      }
    },
  };
}

function registerExtraMonacoThemes(m: typeof import("monaco-editor")) {
  const g = globalThis as any;
  if (g.__kabegame_monaco_themes_registered) return;
  g.__kabegame_monaco_themes_registered = true;

  // 这些主题来自 monaco-themes（MIT），为“现成设计”，不手写配色。
  m.editor.defineTheme("kabegame-dracula", themeDracula as any);
  m.editor.defineTheme("kabegame-github-dark", themeGithubDark as any);
  m.editor.defineTheme("kabegame-github-light", themeGithubLight as any);
  m.editor.defineTheme("kabegame-night-owl", themeNightOwl as any);
  m.editor.defineTheme("kabegame-solarized-dark", themeSolarizedDark as any);
  m.editor.defineTheme("kabegame-solarized-light", themeSolarizedLight as any);
}

function applyMonacoTheme(m: typeof import("monaco-editor"), themeName?: string) {
  // 空值/未知值直接回落到 monaco 内置主题
  const t = (themeName || "").trim() || "vs-dark";
  try {
    m.editor.setTheme(t);
  } catch {
    m.editor.setTheme("vs-dark");
  }
}

function tryRegExp(pattern?: string): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function applyRhaiLanguageConfiguration(m: typeof import("monaco-editor")) {
  const cfg: any = rhaiVsCodeLanguageConfig as any;
  m.languages.setLanguageConfiguration("rhai", {
    comments: cfg.comments,
    brackets: cfg.brackets,
    autoClosingPairs: cfg.autoClosingPairs,
    autoCloseBefore: cfg.autoCloseBefore,
    surroundingPairs: cfg.surroundingPairs,
    wordPattern: tryRegExp(cfg.wordPattern),
    folding: cfg.folding?.markers
      ? {
        markers: {
          start: tryRegExp(cfg.folding.markers.start) ?? /^\s*\/\/\s*#?region\b/,
          end: tryRegExp(cfg.folding.markers.end) ?? /^\s*\/\/\s*#?endregion\b/,
        },
      }
      : undefined,
    indentationRules: cfg.indentationRules
      ? {
        increaseIndentPattern:
          tryRegExp(cfg.indentationRules.increaseIndentPattern) ?? /{$/,
        decreaseIndentPattern:
          tryRegExp(cfg.indentationRules.decreaseIndentPattern) ?? /^\s*}/,
      }
      : undefined,
  } as any);
}

function sanitizeRhaiTmGrammarJson(raw: string): string {
  // `vscode-rhai` 的 TextMate grammar 中包含 `(?<=\\.|\\?\\.)` 这类 look-behind，
  // 但 onigasm 对“不同长度分支”的 look-behind 支持不完整，会触发：
  // `invalid pattern in look-behind` -> Monaco tokenization 崩掉（表现为“只有括号高亮”）。
  //
  // 这里做一个最小兼容改写：把 look-behind 改为普通匹配 `(?:\\.|\\?\\.)`。
  // 代价：匹配范围会包含前导的 "." / "?."，但高亮能稳定工作。
  let out = raw
    .split("(?<=(\\\\.|\\\\?\\\\.))")
    .join("(?:\\\\.|\\\\?\\\\.)");
  out = out.split("(?<=\\\\.|\\\\?\\\\.)").join("(?:\\\\.|\\\\?\\\\.)");
  return out;
}

async function ensureRhaiTextmateWired(
  m: typeof import("monaco-editor"),
  editor: import("monaco-editor").editor.IStandaloneCodeEditor
) {
  const g = globalThis as any;

  // 1) onigasm wasm 只加载一次（否则会重复初始化，浪费时间）
  if (!g.__kabegame_onigasm_load_promise) {
    console.log("[kabegame] Loading onigasm WASM from:", onigasmWasmUrl);
    g.__kabegame_onigasm_load_promise = loadWASM(onigasmWasmUrl).catch((e) => {
      console.error("[kabegame] Failed to load onigasm WASM:", e);
      throw e;
    });
  }
  await g.__kabegame_onigasm_load_promise;

  // 2) tokens provider 只 wire 一次（Monaco 是全局注册）
  if (g.__kabegame_rhai_textmate_wired) return;
  g.__kabegame_rhai_textmate_wired = true;

  const registry = new Registry({
    getGrammarDefinition: async (scopeName: string, _dependentScope: string) => {
      if (scopeName !== "source.rhai") {
        throw new Error(`Unsupported TM scopeName: ${scopeName}`);
      }
      return { format: "json", content: sanitizeRhaiTmGrammarJson(rhaiTmGrammarJson) } as any;
    },
  });

  const grammars = new Map<string, string>();
  grammars.set("rhai", "source.rhai");
  await wireTmGrammars(m as any, registry as any, grammars, editor as any);
}

function registerRhaiLanguage(m: typeof import("monaco-editor")) {
  const languageId = "rhai";

  // Monaco 的语言/补全 provider 是全局注册的（单页多次 mount 也会复用）。
  // 用全局标记避免重复注册导致补全项重复出现。
  const g = globalThis as any;
  if (g.__kabegame_rhai_language_registered) return;
  g.__kabegame_rhai_language_registered = true;

  // 动态变量数据源（由组件 watch 更新）
  if (!g.__kabegame_rhai_user_vars) {
    g.__kabegame_rhai_user_vars = new Map<string, UserVarDoc>();
  }
  if (!g.__kabegame_rhai_const_vars) {
    g.__kabegame_rhai_const_vars = new Map<string, ConstVarDoc>();
  }

  m.languages.register({ id: languageId });
  applyRhaiLanguageConfiguration(m);

  // 基础补全（Rhai API + 常用关键字）
  const apiFns = RHAI_API_FN_NAMES;

  m.languages.registerCompletionItemProvider(languageId, {
    // 没有 triggerCharacters 时，Monaco 默认往往只在 Ctrl+Space 或某些符号触发补全
    // 这里显式指定字母/下划线，达到“输入 le 自动弹出 let”的体验
    triggerCharacters: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_".split(""),
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const constVarSuggestions: import("monaco-editor").languages.CompletionItem[] = [];
      const userVarSuggestions: import("monaco-editor").languages.CompletionItem[] = [];
      try {
        const map = (globalThis as any).__kabegame_rhai_user_vars as Map<string, UserVarDoc>;
        const constMap = (globalThis as any).__kabegame_rhai_const_vars as Map<string, ConstVarDoc>;

        // 先注入常量变量补全（如果用户变量同名，则跳过，避免“看起来像覆盖”）
        for (const [k, v] of constMap.entries()) {
          if (map.has(k)) continue;
          const typeText = (v.type || "").trim();
          const nameText = (v.name || "").trim();
          const detailParts = [typeText ? `常量 (${typeText})` : "常量"];
          if (nameText) detailParts.push(nameText);
          let valueText = "";
          try {
            valueText = typeof v.value === "string" ? v.value : JSON.stringify(v.value);
          } catch {
            valueText = String(v.value ?? "");
          }
          valueText = String(valueText ?? "").trim();
          if (valueText.length > 200) valueText = valueText.slice(0, 200) + "…";

          constVarSuggestions.push({
            label: k,
            kind: m.languages.CompletionItemKind.Constant,
            insertText: k,
            detail: detailParts.join(" - "),
            documentation: {
              value: [
                `**常量** \`${k}\`${typeText ? `（${typeText}）` : ""}`,
                "",
                v.descripts ? `**说明**：${v.descripts}` : "",
                "",
                valueText ? `**值**：\`${valueText}\`` : "",
              ]
                .filter(Boolean)
                .join("\n"),
            } as any,
            range,
          });
        }

        for (const [k, v] of map.entries()) {
          const typeText = (v.type || "").trim();
          const nameText = (v.name || "").trim();
          const detailParts = [typeText ? `变量 (${typeText})` : "变量"];
          if (nameText) detailParts.push(nameText);
          userVarSuggestions.push({
            label: k,
            kind: m.languages.CompletionItemKind.Variable,
            insertText: k,
            detail: detailParts.join(" - "),
            documentation: v.descripts ? ({ value: v.descripts } as any) : undefined,
            range,
          });
        }
      } catch {
        // ignore
      }

      const suggestions: import("monaco-editor").languages.CompletionItem[] = [
        ...constVarSuggestions,
        ...userVarSuggestions,
        ...apiFns.map((name) => {
          const doc = RHAI_API_DOCS[name];
          return {
            label: name,
            kind: m.languages.CompletionItemKind.Function,
            insertText: name,
            detail: doc?.signature,
            documentation: doc?.markdown ? ({ value: doc.markdown } as any) : undefined,
            range,
          };
        }),
        ...[
          "fn",
          "let",
          "const",
          "if",
          "else",
          "while",
          "for",
          "return",
          "true",
          "false",
          "try",
          "catch",
        ].map((kw) => ({
          label: kw,
          kind: m.languages.CompletionItemKind.Keyword,
          insertText: kw,
          range,
        })),
      ];
      return { suggestions };
    },
  });

  // 悬浮文档：Rhai API 函数
  m.languages.registerHoverProvider(languageId, {
    provideHover: (model, position) => {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      // 0) 常量变量（base_url 等）
      try {
        const userMap = (globalThis as any).__kabegame_rhai_user_vars as Map<string, UserVarDoc>;
        // 若用户变量同名，则优先展示用户变量文档（符合“不覆盖”的直觉）
        if (!userMap?.has(word.word)) {
          const constMap = (globalThis as any).__kabegame_rhai_const_vars as Map<string, ConstVarDoc>;
          const v = constMap?.get(word.word);
          if (v) {
            const lines: string[] = [];
            const typeText = (v.type || "").trim();
            lines.push(`**常量** \`${v.key}\`${typeText ? `（${typeText}）` : ""}`);
            const nameText = (v.name || "").trim();
            if (nameText) lines.push(`**名称**：${nameText}`);
            const descText = (v.descripts || "").trim();
            if (descText) lines.push(`**说明**：${descText}`);
            if (v.value !== undefined) {
              let d = "";
              try {
                d = typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2);
              } catch {
                d = String(v.value);
              }
              lines.push("", "**值**：", "```text", d, "```");
            }
            const markdown = lines.join("\n");
            return {
              range: new (m as any).Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
              contents: [{ value: markdown }],
            } as any;
          }
        }
      } catch {
        // ignore
      }

      // 1) 用户变量优先（更贴合当前需求）
      try {
        const map = (globalThis as any).__kabegame_rhai_user_vars as Map<string, UserVarDoc>;
        const v = map.get(word.word);
        if (v) {
          const lines: string[] = [];
          const typeText = (v.type || "").trim();
          lines.push(`**变量** \`${v.key}\`${typeText ? `（${typeText}）` : ""}`);
          const nameText = (v.name || "").trim();
          if (nameText) lines.push(`**名称**：${nameText}`);
          const descText = (v.descripts || "").trim();
          if (descText) lines.push(`**说明**：${descText}`);
          if (v.default !== undefined) {
            let d = "";
            try {
              d = JSON.stringify(v.default, null, 2);
            } catch {
              d = String(v.default);
            }
            lines.push("", "**默认值**：", "```json", d, "```");
          } else {
            lines.push("", "**默认值**：无（required）");
          }
          const markdown = lines.join("\n");
          return {
            range: new (m as any).Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            contents: [{ value: markdown }],
          } as any;
        }
      } catch {
        // ignore
      }

      // 2) Rhai API 函数
      const doc = RHAI_API_DOCS[word.word];
      if (!doc) return null;
      return {
        range: new (m as any).Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value: doc.markdown }],
      } as any;
    },
  });

  // 参数签名提示：输入 `(` / `,` 时展示
  m.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: (model, position) => {
      const empty = {
        value: { signatures: [], activeSignature: 0, activeParameter: 0 },
        dispose: () => { },
      } as any;

      const line = model.getLineContent(position.lineNumber);
      const left = line.slice(0, Math.max(0, position.column - 1));
      const idx = left.lastIndexOf("(");
      if (idx < 0) return empty;

      const before = left.slice(0, idx).trimEnd();
      const mName = before.match(/([A-Za-z_][\w]*)\s*$/);
      const name = mName?.[1];
      if (!name) return empty;

      const doc = RHAI_API_DOCS[name];
      if (!doc) return empty;

      const commaCount = left.slice(idx + 1).split(",").length - 1;
      const params = (doc.params ?? []).map((p) => ({
        label: p.label,
        documentation: p.documentation ? ({ value: p.documentation } as any) : undefined,
      }));
      const sig = {
        label: doc.signature,
        documentation: doc.markdown ? ({ value: doc.markdown } as any) : undefined,
        parameters: params,
      };

      return {
        value: {
          signatures: [sig],
          activeSignature: 0,
          activeParameter: Math.min(commaCount, Math.max(0, params.length - 1)),
        },
        dispose: () => { },
      } as any;
    },
  });
}

function setMarkers(next: EditorMarker[]) {
  if (!monaco || !model) return;
  monaco.editor.setModelMarkers(model, "rhai", next as any);
}

onMounted(async () => {
  if (!rootRef.value) return;
  await ensureMonacoWorkers();
  // 用 editor.api 入口（比直接 import("monaco-editor") 更轻，也更少触发预构建问题）
  monaco = (await import("monaco-editor/esm/vs/editor/editor.api")) as unknown as typeof import("monaco-editor");
  registerExtraMonacoThemes(monaco);
  applyMonacoTheme(monaco, props.theme);
  registerRhaiLanguage(monaco);

  model = monaco.editor.createModel(props.modelValue ?? "", "rhai");
  editor = monaco.editor.create(rootRef.value, {
    model,
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    wordWrap: "on",
    scrollBeyondLastLine: false,
    hover: { enabled: true, delay: 200 },
    // 代码折叠（语言侧规则来自 vscode-rhai 的 configuration：indentationRules + folding markers）
    folding: true,
    showFoldingControls: "always",
    foldingHighlight: true,
    // 关键：开启“输入时自动建议”
    suggestOnTriggerCharacters: true,
    quickSuggestions: { other: true, comments: false, strings: false },
    // 避免只靠单词提示导致“看不到关键字补全”
    wordBasedSuggestions: "off",
  });

  editor.onDidChangeModelContent(() => {
    if (!model) return;
    const v = model.getValue();
    if (selfUpdate) return;
    emit("update:modelValue", v);
  });

  // 显式添加快捷键绑定（确保注释和缩放功能可用，避免浏览器快捷键冲突）
  // 注释：Ctrl+/ 切换行注释，Ctrl+Shift+/ 切换块注释
  // 缩放：Ctrl++ 放大，Ctrl+- 缩小，Ctrl+0 重置
  // 注意：Monaco Editor 默认支持这些快捷键，这里显式绑定以确保优先级
  if (editor) {
    try {
      const KeyMod = (monaco as any).KeyMod;
      const KeyCode = (monaco as any).KeyCode;
      if (KeyMod && KeyCode) {
        // 注释快捷键
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.Slash, () => {
          editor?.getAction("editor.action.commentLine")?.run();
        });
        editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Slash, () => {
          editor?.getAction("editor.action.blockComment")?.run();
        });
        // 缩放快捷键
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.Equal, () => {
          editor?.getAction("editor.action.fontZoomIn")?.run();
        });
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.Minus, () => {
          editor?.getAction("editor.action.fontZoomOut")?.run();
        });
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.Digit0, () => {
          editor?.getAction("editor.action.fontZoomReset")?.run();
        });
      }
    } catch (e) {
      // 如果快捷键 API 不可用，Monaco Editor 的默认快捷键应该仍然有效
      console.warn("[kabegame] Failed to register custom keyboard shortcuts:", e);
    }
  }

  // 用 vscode-rhai 的 TextMate grammar 替换手写 tokenizer（高亮更完整）
  try {
    await ensureRhaiTextmateWired(monaco, editor);
    console.log("[kabegame] Rhai TextMate grammar wired successfully");
  } catch (e) {
    console.error("[kabegame] wire rhai textmate failed, fallback to basic highlight:", e);
    // 即使 TextMate 失败，Monaco 的基础高亮仍然可用
  }

  setMarkers(props.markers || []);
});

watch(
  () => props.theme,
  (t) => {
    if (!monaco) return;
    applyMonacoTheme(monaco, t);
  }
);

watch(
  () => props.userVars,
  (vars) => {
    try {
      const map = (globalThis as any).__kabegame_rhai_user_vars as Map<string, UserVarDoc>;
      map.clear();
      for (const v of vars || []) {
        const key = (v?.key || "").trim();
        if (!key) continue;
        map.set(key, { ...v, key });
      }
    } catch {
      // ignore
    }
  },
  { deep: true, immediate: true }
);

watch(
  () => props.baseUrl,
  (v) => {
    try {
      const constMap = (globalThis as any).__kabegame_rhai_const_vars as Map<string, ConstVarDoc>;
      const baseUrl = (v ?? "").trim();
      if (!baseUrl) {
        constMap?.delete("base_url");
        return;
      }
      constMap?.set("base_url", {
        key: "base_url",
        type: "string",
        name: "插件 baseUrl",
        descripts: "来自 config.json 的 baseUrl；后端会将其作为常量注入脚本作用域（不覆盖同名用户变量）。",
        value: baseUrl,
      });
    } catch {
      // ignore
    }
  },
  { immediate: true }
);

watch(
  () => props.modelValue,
  (v) => {
    if (!model) return;
    const current = model.getValue();
    if (current === v) return;
    selfUpdate = true;
    model.setValue(v ?? "");
    selfUpdate = false;
  }
);

watch(
  () => props.markers,
  (m) => setMarkers(m || []),
  { deep: true }
);

onBeforeUnmount(() => {
  editor?.dispose();
  model?.dispose();
  editor = null;
  model = null;
});
</script>

<style>
.rhai-editor-root {
  width: 100%;
  height: 100%;
}
</style>
