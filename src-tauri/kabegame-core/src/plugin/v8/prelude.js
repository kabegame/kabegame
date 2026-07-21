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

// deno_web ships its APIs as lazy_loaded_js IIFE scripts that `return { ... }` but
// do NOT attach to globalThis automatically. In a full Deno process that wiring
// lives in runtime/js/99_main.js, which we omit. Load the modules here and assign
// globals. deno_crypto is intentionally absent - see below.
const webUrl = Deno.core.loadExtScript("ext:deno_web/00_url.js");
const webBase64 = Deno.core.loadExtScript("ext:deno_web/05_base64.js");
const webEncoding = Deno.core.loadExtScript("ext:deno_web/08_text_encoding.js");
const webDomException = Deno.core.loadExtScript("ext:deno_web/01_dom_exception.js");
const webTimers = Deno.core.loadExtScript("ext:deno_web/02_timers.js");
// deno_fs statSync/lstatSync read Deno.build.os from a generated decoder.
// The full Deno runtime maps this same core metadata onto Deno.build; keep the
// compatibility property non-enumerable and expose filesystem APIs only below.
Object.defineProperty(Deno, "build", {
  value: Deno.core.build,
  configurable: false,
  enumerable: false,
  writable: false,
});
const denoFs = Deno.core.loadExtScript("ext:deno_fs/30_fs.js");
// deno_crypto/00_crypto.js is NOT loaded here: it creates cppgc objects
// (Crypto/SubtleCrypto/CryptoKey), attached at runtime startup in v8.rs.
// Headers/Response are NOT pulled from deno_fetch either: that crate (and its
// deno_net/deno_tls networking) is not linked at all. `fetch` is host-backed
// (op_kabegame_fetch, proxy-aware reqwest), so we implement the minimal
// Headers/Response/Request the crawler needs directly in JS (see below).

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

// Minimal WHATWG Headers: case-insensitive multimap. Values for the same name are
// combined with ", " on get()/iteration (except Set-Cookie, exposed via
// getSetCookie()). No header name/value validation, which is fine because the host
// owns the actual wire request; this only shapes what plugins read/pass.
class Headers {
  #map; // Map<lowercaseName, string[]>
  constructor(init) {
    this.#map = new Map();
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      for (const [name, value] of init) this.append(name, value);
    } else if (Array.isArray(init)) {
      for (const pair of init) this.append(pair[0], pair[1]);
    } else {
      for (const name of Object.keys(init)) this.append(name, init[name]);
    }
  }
  append(name, value) {
    const key = String(name).toLowerCase();
    const arr = this.#map.get(key);
    if (arr === undefined) this.#map.set(key, [String(value)]);
    else arr.push(String(value));
  }
  set(name, value) {
    this.#map.set(String(name).toLowerCase(), [String(value)]);
  }
  get(name) {
    const arr = this.#map.get(String(name).toLowerCase());
    return arr === undefined ? null : arr.join(", ");
  }
  has(name) {
    return this.#map.has(String(name).toLowerCase());
  }
  delete(name) {
    this.#map.delete(String(name).toLowerCase());
  }
  getSetCookie() {
    const arr = this.#map.get("set-cookie");
    return arr === undefined ? [] : arr.slice();
  }
  *entries() {
    for (const key of [...this.#map.keys()].sort()) {
      yield [key, this.#map.get(key).join(", ")];
    }
  }
  *keys() {
    for (const [key] of this.entries()) yield key;
  }
  *values() {
    for (const [, value] of this.entries()) yield value;
  }
  forEach(callback, thisArg) {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}
globalThis.Headers = Headers;

// Response statuses that must not carry a body (per the Response constructor).
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

// Minimal WHATWG Response backed by host-fetched bytes. Supports the body accessors
// crawler plugins use (text/json/arrayBuffer/bytes); no streaming body / clone. The
// `body` arg is the host fetch result (Uint8Array), or a string/ArrayBuffer/null.
class Response {
  #bytes; // Uint8Array | null
  constructor(body, init = {}) {
    const status = init.status ?? 200;
    this.status = status;
    this.statusText = init.statusText ?? "";
    this.headers = new Headers(init.headers);
    this.ok = status >= 200 && status < 300;
    this.redirected = false;
    this.type = "default";
    this.url = "";
    this.bodyUsed = false;
    if (body === null || body === undefined) {
      this.#bytes = null;
    } else if (body instanceof Uint8Array) {
      this.#bytes = body;
    } else if (body instanceof ArrayBuffer) {
      this.#bytes = new Uint8Array(body);
    } else if (typeof body === "string") {
      this.#bytes = new webEncoding.TextEncoder().encode(body);
    } else {
      this.#bytes = new Uint8Array(0);
    }
  }
  #consume() {
    if (this.bodyUsed) throw new TypeError("Body has already been consumed");
    this.bodyUsed = true;
    return this.#bytes ?? new Uint8Array(0);
  }
  async arrayBuffer() {
    const b = this.#consume();
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async bytes() {
    return this.#consume();
  }
  async text() {
    return new webEncoding.TextDecoder().decode(this.#consume());
  }
  async json() {
    return JSON.parse(new webEncoding.TextDecoder().decode(this.#consume()));
  }
}
globalThis.Response = Response;

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

// Host-backed `fetch`: routes through op_kabegame_fetch (proxy-aware reqwest on
// the Rust side). The task's default request headers are merged on the host; here
// we only forward the caller's method/headers/body and rebuild a Response.
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
  // Surface the real (post-redirect) URL so callers relying on response.url behave
  // like a network response.
  response.url = result.url;
  return response;
};

const kabegameFs = Object.freeze({
  ...denoFs,
  getRoot: () => ops.op_kabegame_fs_root(),
});

globalThis.Kabegame = Object.freeze({
  fs: kabegameFs,
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
  requireCookie: (host) => ops.op_kabegame_require_cookie(host ?? ""),
  delHeader: (key) => ops.op_kabegame_del_header(key),
  warn: (message) => ops.op_kabegame_warn(message),
  addProgress: (percentage) => ops.op_kabegame_add_progress(percentage),
  downloadImage: (url, opts) => ops.op_kabegame_download_image(url, opts ?? null),
  createImageMetadata: (map, opts) =>
    ops.op_kabegame_create_image_metadata(map, opts ?? null),
});
