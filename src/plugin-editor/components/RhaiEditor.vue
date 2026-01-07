<template>
  <div ref="rootRef" class="rhai-editor-root" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";


type MonacoMarkerSeverity = 1 | 2 | 4 | 8;

type EditorMarker = {
  message: string;
  severity: MonacoMarkerSeverity;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

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
  const apiFns = [
    "print",
    "debug",
    "re_is_match",
    "to",
    "to_json",
    "back",
    "current_url",
    "current_html",
    "query",
    "query_by_text",
    "find_by_text",
    "get_attr",
    "resolve_url",
    "is_image_url",
    "download_image",
    "add_progress",
  ];

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
        ...apiFns.map((name) => ({
          label: name,
          kind: m.languages.CompletionItemKind.Function,
          insertText: name,
          range,
        })),
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

<style scoped>
.rhai-editor-root {
  width: 100%;
  height: 100%;
}
</style>
