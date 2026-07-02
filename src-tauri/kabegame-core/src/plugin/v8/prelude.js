// Kabegame V8 runtime prelude.
// This file is the only runtime-injected JS ABI. The Phase 3 SDK wraps these
// globals from bundled plugin code.
const ops = Deno.core.ops;

globalThis.__kabegame_to = (url) => ops.op_kabegame_to(url);
globalThis.__kabegame_back = () => ops.op_kabegame_back();
globalThis.__kabegame_fetch_json = (url) => ops.op_kabegame_fetch_json(url);
globalThis.__kabegame_current_url = () => ops.op_kabegame_current_url();
globalThis.__kabegame_current_html = () => ops.op_kabegame_current_html();
globalThis.__kabegame_current_headers = () => ops.op_kabegame_current_headers();
globalThis.__kabegame_plugin_data = () => ops.op_kabegame_plugin_data();
globalThis.__kabegame_set_plugin_data = (map) => ops.op_kabegame_set_plugin_data(map);
globalThis.__kabegame_set_header = (key, value) => ops.op_kabegame_set_header(key, value);
globalThis.__kabegame_del_header = (key) => ops.op_kabegame_del_header(key);
globalThis.__kabegame_warn = (message) => ops.op_kabegame_warn(message);
globalThis.__kabegame_add_progress = (percentage) => ops.op_kabegame_add_progress(percentage);
globalThis.__kabegame_download_image = (url, opts) => ops.op_kabegame_download_image(url, opts);
globalThis.__kabegame_create_image_metadata = (map, opts) =>
  ops.op_kabegame_create_image_metadata(map, opts);

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

globalThis.setTimeout = (callback, ms = 0, ...args) =>
  Deno.core.createSystemTimer(() => callback(...args), ms, true);
globalThis.clearTimeout = (id) => Deno.core.cancelTimer(id);
