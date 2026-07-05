// Kabegame V8 runtime prelude.
// Host-only crawler capabilities are exposed through the single Kabegame global.
import {
  Attr,
  CharacterData,
  Comment,
  Document,
  DocumentFragment,
  DocumentType,
  DOMImplementation,
  DOMParser,
  DOMTokenList,
  Element,
  HTMLCollection,
  HTMLDocument,
  HTMLTemplateElement,
  initParser,
  Node,
  NodeList,
  Text,
} from "ext:kabegame_v8/deno_dom_wasm_noinit.js";

const ops = Deno.core.ops;

// deno_web and deno_fetch ship their APIs as lazy_loaded_js IIFE scripts that
// `return { ... }` but do NOT attach to globalThis automatically. In a full Deno
// process that wiring lives in runtime/js/99_main.js, which we omit. Load the
// modules here and assign globals so the snapshot bakes them in.
// NOTE: deno_crypto is intentionally absent - see below.
const webUrl = Deno.core.loadExtScript("ext:deno_web/00_url.js");
const webBase64 = Deno.core.loadExtScript("ext:deno_web/05_base64.js");
const webEncoding = Deno.core.loadExtScript("ext:deno_web/08_text_encoding.js");
const webDomException = Deno.core.loadExtScript("ext:deno_web/01_dom_exception.js");
const webTimers = Deno.core.loadExtScript("ext:deno_web/02_timers.js");
// deno_crypto/00_crypto.js is NOT loaded here: it creates cppgc objects
// (Crypto/SubtleCrypto/CryptoKey) which require a CppHeap. V8 snapshot isolates
// have no CppHeap, so crypto is deferred to runtime startup in v8.rs.
// Only Headers + Response are pulled from deno_fetch: they depend on deno_web
// only. The native `Request`/`fetch` (23_request.js -> 22_http_client.js ->
// ext:deno_net/02_tls.js, and 26_fetch.js -> ext:deno_telemetry/*) would drag in
// deno_net (raw sockets) + deno_telemetry, so we provide host-backed `fetch` and
// a minimal `Request` instead (see below), routed through the proxy-aware host.
const fetchHeaders = Deno.core.loadExtScript("ext:deno_fetch/20_headers.js");
const fetchResponse = Deno.core.loadExtScript("ext:deno_fetch/23_response.js");

Object.assign(globalThis, {
  URL: webUrl.URL,
  URLSearchParams: webUrl.URLSearchParams,
  atob: webBase64.atob,
  btoa: webBase64.btoa,
  TextEncoder: webEncoding.TextEncoder,
  TextDecoder: webEncoding.TextDecoder,
  TextEncoderStream: webEncoding.TextEncoderStream,
  TextDecoderStream: webEncoding.TextDecoderStream,
  DOMException: webDomException.DOMException,
  // Crypto/crypto/CryptoKey/SubtleCrypto are attached at runtime (see v8.rs).
  Headers: fetchHeaders.Headers,
  Response: fetchResponse.Response,
});

let domParserReady = null;

function ensureDomParserReady() {
  if (domParserReady === null) {
    domParserReady = initParser();
  }
  return domParserReady;
}

Object.assign(globalThis, {
  Attr,
  CharacterData,
  Comment,
  Document,
  DocumentFragment,
  DocumentType,
  DOMImplementation,
  DOMParser,
  DOMTokenList,
  Element,
  HTMLCollection,
  HTMLDocument,
  HTMLTemplateElement,
  Node,
  NodeList,
  Text,
});

Object.defineProperty(globalThis, Symbol.for("kabegame.domReady"), {
  value: ensureDomParserReady,
  configurable: false,
  enumerable: false,
});

Object.assign(globalThis, {
  clearInterval: webTimers.clearInterval,
  clearTimeout: webTimers.clearTimeout,
  setInterval: webTimers.setInterval,
  setTimeout: webTimers.setTimeout,
});

function formatConsoleArgs(args) {
  return args.map((arg) => {
    if (typeof arg === "string") {
      return arg;
    }
    try {
      const json = JSON.stringify(arg);
      return json === undefined ? String(arg) : json;
    } catch {
      return String(arg);
    }
  }).join(" ");
}

globalThis.console = {
  log: (...args) => ops.op_kabegame_log("print", formatConsoleArgs(args)),
  info: (...args) => ops.op_kabegame_log("info", formatConsoleArgs(args)),
  warn: (...args) => ops.op_kabegame_log("warn", formatConsoleArgs(args)),
  error: (...args) => ops.op_kabegame_log("error", formatConsoleArgs(args)),
  debug: (...args) => ops.op_kabegame_log("debug", formatConsoleArgs(args)),
};

// Minimal `Request`: enough to normalize fetch inputs (url/method/headers/body)
// and support `input instanceof Request`. Not a full spec Request (no streaming
// body, no cache/mode/credentials semantics) since fetch is host-backed.
class Request {
  #body;
  constructor(input, init = {}) {
    if (input instanceof Request) {
      this.url = input.url;
      this.method = init.method ? String(init.method).toUpperCase() : input.method;
      this.headers = new globalThis.Headers(
        init.headers !== undefined ? init.headers : input.headers,
      );
      this.#body = init.body !== undefined ? init.body : input.#body;
    } else {
      this.url = String(input && input.url !== undefined ? input.url : input);
      this.method = String(init.method ?? "GET").toUpperCase();
      this.headers = new globalThis.Headers(init.headers);
      this.#body = init.body ?? null;
    }
  }
  get bodyText() {
    return this.#body;
  }
}
globalThis.Request = Request;

// Response statuses that must not carry a body (per the Response constructor).
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

// Host-backed `fetch`: routes through op_kabegame_fetch (proxy-aware reqwest on
// the Rust side). The task's default request headers are merged on the host; here
// we only forward the caller's method/headers/body and rebuild a native Response.
globalThis.fetch = async (input, init = undefined) => {
  const request = new Request(input, init);
  const bodyText = request.bodyText;
  const result = await ops.op_kabegame_fetch(request.url, {
    method: request.method,
    headers: [...request.headers],
    body: bodyText == null ? null : String(bodyText),
  });
  const body = NULL_BODY_STATUS.has(result.status) ? null : result.body;
  const response = new globalThis.Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  // `new Response()` always reports url === ""; surface the real (post-redirect)
  // URL so callers relying on response.url behave like a network response.
  Object.defineProperty(response, "url", { value: result.url, configurable: true });
  return response;
};

globalThis.Kabegame = Object.freeze({
  to: (url) => ops.op_kabegame_to(url),
  back: () => ops.op_kabegame_back(),
  currentUrl: () => ops.op_kabegame_current_url(),
  currentHtml: () => ops.op_kabegame_current_html(),
  currentDocument: async () => {
    try {
      const html = await ops.op_kabegame_current_html();
      await ensureDomParserReady();
      return new DOMParser().parseFromString(html, "text/html");
    } catch {
      return null;
    }
  },
  currentHeaders: () => ops.op_kabegame_current_headers(),
  pluginData: () => ops.op_kabegame_plugin_data(),
  setPluginData: (map) => ops.op_kabegame_set_plugin_data(map),
  setHeader: (key, value) => ops.op_kabegame_set_header(key, value),
  delHeader: (key) => ops.op_kabegame_del_header(key),
  warn: (message) => ops.op_kabegame_warn(message),
  addProgress: (percentage) => ops.op_kabegame_add_progress(percentage),
  downloadImage: (url, opts) => ops.op_kabegame_download_image(url, opts ?? null),
  createImageMetadata: (map, opts) =>
    ops.op_kabegame_create_image_metadata(map, opts ?? null),
});
