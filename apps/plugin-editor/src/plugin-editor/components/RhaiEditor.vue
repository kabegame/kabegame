<template>
  <div ref="rootRef" class="rhai-editor-root" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
// Monaco ESM 里 editor.api 不会自动带贡献功能，需要显式引入补全/悬浮等贡献
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestWidget";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/esm/vs/editor/contrib/parameterHints/browser/parameterHints";

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
      if (label === "json") {
        return new JsonWorker();
      }
      return new EditorWorker();
    },
  };
}

function registerRhaiLanguage(m: typeof import("monaco-editor")) {
  const languageId = "rhai";

  // Monaco 的语言/补全 provider 是全局注册的（单页多次 mount 也会复用）。
  // 用全局标记避免重复注册导致补全项重复出现。
  const g = globalThis as any;
  if (g.__kabegame_rhai_language_registered) return;
  g.__kabegame_rhai_language_registered = true;

  m.languages.register({ id: languageId });

  // 轻量 tokenizer（不追求 100% 语法覆盖）
  m.languages.setMonarchTokensProvider(languageId, {
    keywords: [
      "fn",
      "let",
      "const",
      "if",
      "else",
      "switch",
      "case",
      "default",
      "while",
      "loop",
      "for",
      "in",
      "break",
      "continue",
      "return",
      "throw",
      "try",
      "catch",
      "true",
      "false",
      "null",
    ],
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/`([^`\\\\]|\\\\.)*`/, "string"],
        [/"([^"\\\\]|\\\\.)*"/, "string"],
        [/'([^'\\\\]|\\\\.)*'/, "string"],
        [/[0-9]+(\.[0-9]+)?/, "number"],
        [/[{}()[\]]/, "@brackets"],
        [/[;,.]/, "delimiter"],
        [/[+\-*/%=&|<>!]+/, "operator"],
        [/[a-zA-Z_][\w]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
        [/\s+/, "white"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  } as any);

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
      const suggestions: import("monaco-editor").languages.CompletionItem[] = [
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

  setMarkers(props.markers || []);
});

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
