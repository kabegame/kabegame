#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAMES = {
  READ_PROVIDER: "read_gallery_provider",
  READ_IMAGE: "read_image",
  READ_IMAGE_METADATA: "read_image_metadata",
  READ_ALBUM: "read_album",
  READ_TASK: "read_task",
  READ_SURF: "read_surf",
  READ_PLUGIN: "read_plugin",
  SET_ALBUM_ORDER: "set_album_images_order",
  CREATE_ALBUM: "create_album",
  ADD_IMAGES_TO_ALBUM: "add_images_to_album",
  RENAME_IMAGE: "rename_image",
};

const MAX_ORDER_BATCH = 100;
const MAX_ADD_BATCH = 1000;
const DEFAULT_ENDPOINT = "http://127.0.0.1:7490/mcp";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const ALLOWED_WITHOUT = new Set(["children", "images"]);
const PLUGIN_SUB_RESOURCES = new Set([
  "info",
  "icon",
  "description_template",
  "doc",
  "doc_resource",
]);

function toBool(value, defaultValue = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return defaultValue;
}

function toInt(value, fallback) {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

const config = (() => {
  const endpoint = process.env.KABEGAME_MCP_ENDPOINT || DEFAULT_ENDPOINT;
  const timeoutRaw = toInt(process.env.KABEGAME_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const timeoutMs = clamp(timeoutRaw, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const debug = toBool(process.env.KABEGAME_MCP_DEBUG, false);

  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Invalid endpoint protocol: ${url.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    throw new Error(
      `Endpoint host not allowed (${url.hostname}). Only localhost/127.0.0.1/::1 are allowed.`,
    );
  }

  return {
    endpoint: url.toString(),
    timeoutMs,
    debug,
  };
})();

function log(level, message, extra = undefined) {
  const payload = {
    time: new Date().toISOString(),
    level,
    message,
  };
  if (extra !== undefined) payload.extra = extra;
  if (level !== "debug" || config.debug) {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function makeError(code, message, details = undefined) {
  return { ok: false, code, message, details };
}

function makeSuccess(data) {
  return { ok: true, data };
}

function assertProviderPath(path) {
  if (!isNonEmptyString(path)) {
    throw makeError("INVALID_ARGUMENT", "path must be a non-empty string");
  }
  if (path.includes("..")) {
    throw makeError("INVALID_ARGUMENT", "path must not contain '..'");
  }
  if (path.startsWith("/")) {
    throw makeError("INVALID_ARGUMENT", "path must be relative (no leading slash)");
  }
  if (path.includes("?") || path.includes("#")) {
    throw makeError("INVALID_ARGUMENT", "path must not contain query or fragment markers");
  }
  if (path.length > 512) {
    throw makeError("INVALID_ARGUMENT", "path is too long (max 512)");
  }
}

function imagePathToUri(path) {
  assertProviderPath(path);
  const trimmed = path.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("images://")) {
    return trimmed;
  }
  if (/^[a-z][a-z0-9_]*:\/\//.test(trimmed)) {
    throw makeError("INVALID_ARGUMENT", "only images:// resource paths are supported here");
  }
  if (
    trimmed.startsWith("gallery/") ||
    trimmed.startsWith("vd/") ||
    trimmed.startsWith("id_") ||
    /^x[1-9][0-9]*x(\/|$)/.test(trimmed)
  ) {
    return `images://${trimmed}`;
  }
  return `images://gallery/${trimmed}`;
}

function idSegment(id) {
  return id.startsWith("id_") ? id : `id_${id}`;
}

function assertOptionalIdentifier(value, field, max = 256) {
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") {
    throw makeError("INVALID_ARGUMENT", `${field} must be a string`);
  }
  if (value.length > max) {
    throw makeError("INVALID_ARGUMENT", `${field} is too long (max ${max})`);
  }
}

function assertRequiredIdentifier(value, field, max = 256) {
  if (!isNonEmptyString(value)) {
    throw makeError("INVALID_ARGUMENT", `${field} must be a non-empty string`);
  }
  if (value.length > max) {
    throw makeError("INVALID_ARGUMENT", `${field} is too long (max ${max})`);
  }
}

function assertOrderEntries(entries, field, max) {
  if (!Array.isArray(entries)) {
    throw makeError("INVALID_ARGUMENT", `${field} must be an array`);
  }
  if (entries.length < 1) {
    throw makeError("INVALID_ARGUMENT", `${field} must contain at least one item`);
  }
  if (entries.length > max) {
    throw makeError(
      "INVALID_ARGUMENT",
      `${field} exceeds max batch size ${max}`,
    );
  }
  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i];
    if (!item || typeof item !== "object") {
      throw makeError("INVALID_ARGUMENT", `${field}[${i}] must be an object`);
    }
    if (!isNonEmptyString(item.image_id)) {
      throw makeError("INVALID_ARGUMENT", `${field}[${i}].image_id must be a string`);
    }
    if (!Number.isInteger(item.order)) {
      throw makeError("INVALID_ARGUMENT", `${field}[${i}].order must be an integer`);
    }
  }
}

function assertImageIdList(imageIds) {
  if (!Array.isArray(imageIds)) {
    throw makeError("INVALID_ARGUMENT", "image_ids must be an array");
  }
  if (imageIds.length < 1) {
    throw makeError("INVALID_ARGUMENT", "image_ids must contain at least one item");
  }
  if (imageIds.length > MAX_ADD_BATCH) {
    throw makeError(
      "INVALID_ARGUMENT",
      `image_ids exceeds max batch size ${MAX_ADD_BATCH}`,
    );
  }
  for (let i = 0; i < imageIds.length; i += 1) {
    if (!isNonEmptyString(imageIds[i])) {
      throw makeError("INVALID_ARGUMENT", `image_ids[${i}] must be a non-empty string`);
    }
  }
}

function toolResponse(resultObj) {
  const serialized = JSON.stringify(resultObj, null, 2);
  return {
    content: [{ type: "text", text: serialized }],
    structuredContent: resultObj,
    isError: resultObj.ok === false,
  };
}

// 与 upstream Kabegame MCP server（rmcp StreamableHTTP）的连接：用官方 SDK
// client 维护，自动完成 initialize / session / SSE。lazy 建立并缓存复用。
let upstreamClient = null;
let upstreamConnecting = null;

async function ensureUpstream() {
  if (upstreamClient) return upstreamClient;
  if (!upstreamConnecting) {
    upstreamConnecting = (async () => {
      const client = new Client(
        { name: "kabegame-gallery-local-mcpb-upstream", version: "1.1.2" },
        { capabilities: {} },
      );
      const transport = new StreamableHTTPClientTransport(new URL(config.endpoint));
      await client.connect(transport);
      client.onclose = () => {
        if (upstreamClient === client) upstreamClient = null;
      };
      log("debug", "Upstream MCP client connected", { endpoint: config.endpoint });
      upstreamClient = client;
      return client;
    })().finally(() => {
      upstreamConnecting = null;
    });
  }
  return upstreamConnecting;
}

// 统一调用包装：超时用 Promise.race（跨 SDK 版本安全），错误按语义映射；
// 连接类错误丢弃缓存以便下次重连，协议/业务错误上报 UPSTREAM_MCP_ERROR。
async function withUpstream(fn) {
  let client;
  try {
    client = await ensureUpstream();
  } catch (error) {
    upstreamClient = null;
    throw makeError("UPSTREAM_REQUEST_FAILED", "Failed to connect upstream MCP endpoint", {
      message: String(error?.message ?? error),
    });
  }

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(makeError("TIMEOUT", `Upstream request timed out after ${config.timeoutMs}ms`)),
      config.timeoutMs,
    );
  });

  try {
    return await Promise.race([fn(client), timeoutPromise]);
  } catch (error) {
    if (error?.ok === false) throw error; // 已是我们的 makeError（校验 / TIMEOUT）
    // SDK McpError 带数字 code：-32001 为请求超时，其余为协议/业务错误，连接仍有效
    if (typeof error?.code === "number") {
      if (error.code === -32001) {
        throw makeError("TIMEOUT", `Upstream request timed out after ${config.timeoutMs}ms`);
      }
      throw makeError("UPSTREAM_MCP_ERROR", "Upstream MCP error", {
        code: error.code,
        message: error.message,
        data: error.data,
      });
    }
    // 连接 / 传输类错误：丢弃 client，下次调用重连
    try {
      await client.close();
    } catch {
      // ignore
    }
    if (upstreamClient === client) upstreamClient = null;
    throw makeError("UPSTREAM_REQUEST_FAILED", "Failed to call upstream MCP endpoint", {
      message: String(error?.message ?? error),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readResource(uri) {
  return withUpstream((client) => client.readResource({ uri }));
}

async function callUpstreamTool(name, args) {
  return withUpstream((client) => client.callTool({ name, arguments: args }));
}

const server = new Server(
  {
    name: "kabegame-gallery-local-mcpb",
    version: "1.1.2",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

const ALL_TOOLS = [
    {
      name: TOOL_NAMES.READ_PROVIDER,
      description:
        "Read a Kabegame images:// path. Relative gallery paths are mapped under images://gallery/. " +
        "Examples: 'gallery/all', 'all/desc/x100x/1', 'album/{id}/x100x/1', 'date/2024y/03m/'.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "images:// path, or a relative path under images://gallery/ when no scheme is provided.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.READ_IMAGE,
      description: "Read full ImageInfo for an image (images://id_{id}).",
      inputSchema: {
        type: "object",
        properties: {
          image_id: { type: "string", description: "Image ID." },
        },
        required: ["image_id"],
      },
    },
    {
      name: TOOL_NAMES.READ_IMAGE_METADATA,
      description: "Read crawl-time metadata for an image (images://id_{id}/metadata).",
      inputSchema: {
        type: "object",
        properties: {
          image_id: { type: "string", description: "Image ID." },
        },
        required: ["image_id"],
      },
    },
    {
      name: TOOL_NAMES.READ_ALBUM,
      description:
        "Read album info. Omit album_id to list all albums (albums://all); pass album_id for a single album (albums://id_{id}).",
      inputSchema: {
        type: "object",
        properties: {
          album_id: {
            type: "string",
            description: "Album ID. Omit to list all albums.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.READ_TASK,
      description:
        "Read task info. Omit task_id to list all tasks (tasks://all); pass task_id for a single task (tasks://id_{id}).",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID. Omit to list all tasks.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.READ_SURF,
      description:
        "Read surf record. Omit surf_record_id to list all records (surf_records://all); pass surf_record_id for a single record (surf_records://id_{id}).",
      inputSchema: {
        type: "object",
        properties: {
          surf_record_id: {
            type: "string",
            description: "Surf record ID. Omit to list all surf records.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.READ_PLUGIN,
      description:
        "Read plugin info or sub-resource. " +
        "Omit plugin_id to list all (trimmed) plugins. " +
        "With plugin_id and resource='info' (default), returns the trimmed plugin object. " +
        "Other resource values: 'icon' (base64 PNG), 'description_template' (EJS), " +
        "'doc' (doc.md, default locale), 'doc_resource' (requires `key`).",
      inputSchema: {
        type: "object",
        properties: {
          plugin_id: {
            type: "string",
            description: "Plugin ID. Omit to list all plugins (trimmed).",
          },
          resource: {
            type: "string",
            enum: ["info", "icon", "description_template", "doc", "doc_resource"],
            description: "Sub-resource to fetch. Defaults to 'info'.",
          },
          key: {
            type: "string",
            description: "Required when resource='doc_resource' (the doc_resource key).",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.SET_ALBUM_ORDER,
      description:
        "Set manual order for up to 100 images in one album. Call multiple times for larger albums. " +
        "After applying, switch the album sort mode in Kabegame to '加入顺序' (album-order) to see the result.",
      inputSchema: {
        type: "object",
        properties: {
          album_id: { type: "string", description: "Album ID." },
          image_orders: {
            type: "array",
            maxItems: MAX_ORDER_BATCH,
            items: {
              type: "object",
              properties: {
                image_id: { type: "string" },
                order: { type: "integer" },
              },
              required: ["image_id", "order"],
            },
          },
        },
        required: ["album_id", "image_orders"],
      },
    },
    {
      name: TOOL_NAMES.CREATE_ALBUM,
      description:
        "Create a new album. Optionally pass parent_id to nest it under another album.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Album display name." },
          parent_id: {
            type: "string",
            description: "Parent album ID (omit for a root-level album).",
          },
        },
        required: ["name"],
      },
    },
    {
      name: TOOL_NAMES.ADD_IMAGES_TO_ALBUM,
      description:
        "Add images to an album. Already-present images are silently skipped. " +
        "Optionally pass image_orders to set per-image order at the same time.",
      inputSchema: {
        type: "object",
        properties: {
          album_id: { type: "string" },
          image_ids: {
            type: "array",
            items: { type: "string" },
            maxItems: MAX_ADD_BATCH,
          },
          image_orders: {
            type: "array",
            maxItems: MAX_ORDER_BATCH,
            description: "Optional: explicit order for selected images after adding.",
            items: {
              type: "object",
              properties: {
                image_id: { type: "string" },
                order: { type: "integer" },
              },
              required: ["image_id", "order"],
            },
          },
        },
        required: ["album_id", "image_ids"],
      },
    },
    {
      name: TOOL_NAMES.RENAME_IMAGE,
      description: "Update the display name of an image.",
      inputSchema: {
        type: "object",
        properties: {
          image_id: { type: "string" },
          display_name: { type: "string" },
        },
        required: ["image_id", "display_name"],
      },
    },
];

// bridge 工具 → server 能力归属：写工具对应同名 server 工具；读工具对应 resource scheme。
const WRITE_TOOL_SET = new Set([
  TOOL_NAMES.SET_ALBUM_ORDER,
  TOOL_NAMES.CREATE_ALBUM,
  TOOL_NAMES.ADD_IMAGES_TO_ALBUM,
  TOOL_NAMES.RENAME_IMAGE,
]);
const READ_TOOL_SCHEME = {
  [TOOL_NAMES.READ_PROVIDER]: "images",
  [TOOL_NAMES.READ_IMAGE]: "images",
  [TOOL_NAMES.READ_IMAGE_METADATA]: "images",
  [TOOL_NAMES.READ_ALBUM]: "albums",
  [TOOL_NAMES.READ_TASK]: "tasks",
  [TOOL_NAMES.READ_SURF]: "surf_records",
  [TOOL_NAMES.READ_PLUGIN]: "plugin",
};

function schemeOf(uri) {
  const idx = String(uri ?? "").indexOf("://");
  return idx > 0 ? uri.slice(0, idx) : "";
}

// 查询 server 当前启用的写工具与读 scheme，用于动态过滤 bridge 工具列表。
// upstream 不可达时返回 null → 回退暴露全部工具（调用时仍由 server 兜底）。
async function fetchEnabledCapabilities() {
  try {
    return await withUpstream(async (client) => {
      const [tools, resources, templates] = await Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => ({ resources: [] })),
        client.listResourceTemplates().catch(() => ({ resourceTemplates: [] })),
      ]);
      const enabledWrite = new Set((tools.tools ?? []).map((t) => t.name));
      const enabledSchemes = new Set();
      for (const r of resources.resources ?? []) enabledSchemes.add(schemeOf(r.uri));
      for (const t of templates.resourceTemplates ?? []) {
        enabledSchemes.add(schemeOf(t.uriTemplate));
      }
      return { enabledWrite, enabledSchemes };
    });
  } catch (error) {
    log("debug", "Failed to fetch upstream capabilities for tool filtering", {
      message: String(error?.message ?? error),
    });
    return null;
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const caps = await fetchEnabledCapabilities();
  if (!caps) return { tools: ALL_TOOLS };
  const tools = ALL_TOOLS.filter((tool) => {
    if (WRITE_TOOL_SET.has(tool.name)) return caps.enabledWrite.has(tool.name);
    const scheme = READ_TOOL_SCHEME[tool.name];
    return scheme ? caps.enabledSchemes.has(scheme) : true;
  });
  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case TOOL_NAMES.READ_PROVIDER: {
        const path = args.path;
        const uri = imagePathToUri(path);
        if (args.without !== undefined && args.without !== null && args.without !== "") {
          if (!ALLOWED_WITHOUT.has(args.without)) {
            throw makeError(
              "INVALID_ARGUMENT",
              "without must be 'children' or 'images'",
            );
          }
          if (args.without === "images") {
            throw makeError(
              "INVALID_ARGUMENT",
              "without=images is no longer supported; images:// resource reads return image rows",
            );
          }
        }
        const result = await readResource(uri);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.READ_IMAGE: {
        assertRequiredIdentifier(args.image_id, "image_id");
        const result = await readResource(`images://${idSegment(args.image_id)}`);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.READ_IMAGE_METADATA: {
        assertRequiredIdentifier(args.image_id, "image_id");
        const result = await readResource(`images://${idSegment(args.image_id)}/metadata`);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.READ_ALBUM: {
        assertOptionalIdentifier(args.album_id, "album_id");
        const uri = isNonEmptyString(args.album_id)
          ? `albums://${idSegment(args.album_id)}`
          : "albums://all";
        const result = await readResource(uri);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.READ_TASK: {
        assertOptionalIdentifier(args.task_id, "task_id");
        const uri = isNonEmptyString(args.task_id)
          ? `tasks://${idSegment(args.task_id)}`
          : "tasks://all";
        const result = await readResource(uri);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.READ_SURF: {
        const surfRecordId = args.surf_record_id ?? args.id;
        if (!isNonEmptyString(surfRecordId) && isNonEmptyString(args.host)) {
          throw makeError(
            "INVALID_ARGUMENT",
            "read_surf now uses surf_record_id; read surf_records://all first to find the id for a host",
          );
        }
        assertOptionalIdentifier(surfRecordId, "surf_record_id");
        const uri = isNonEmptyString(surfRecordId)
          ? `surf_records://${idSegment(surfRecordId)}`
          : "surf_records://all";
        const result = await readResource(uri);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.READ_PLUGIN: {
        assertOptionalIdentifier(args.plugin_id, "plugin_id");
        const resource = args.resource ?? "info";
        if (!PLUGIN_SUB_RESOURCES.has(resource)) {
          throw makeError(
            "INVALID_ARGUMENT",
            `resource must be one of: ${[...PLUGIN_SUB_RESOURCES].join(", ")}`,
          );
        }
        if (!isNonEmptyString(args.plugin_id)) {
          if (resource !== "info") {
            throw makeError(
              "INVALID_ARGUMENT",
              "plugin_id is required when resource is not 'info'",
            );
          }
          const result = await readResource("plugin://");
          return toolResponse(makeSuccess(result));
        }
        let uri = `plugin://${args.plugin_id}`;
        switch (resource) {
          case "info":
            break;
          case "icon":
            uri += "/icon";
            break;
          case "description_template":
            uri += "/description_template";
            break;
          case "doc":
            uri += "/doc";
            break;
          case "doc_resource": {
            assertRequiredIdentifier(args.key, "key", 512);
            uri += `/doc_resource/${args.key}`;
            break;
          }
          default:
            // already validated
            break;
        }
        const result = await readResource(uri);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.SET_ALBUM_ORDER: {
        assertRequiredIdentifier(args.album_id, "album_id");
        assertOrderEntries(args.image_orders, "image_orders", MAX_ORDER_BATCH);
        const result = await callUpstreamTool("set_album_images_order", {
          album_id: args.album_id,
          image_orders: args.image_orders,
        });
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.CREATE_ALBUM: {
        assertRequiredIdentifier(args.name, "name", 512);
        assertOptionalIdentifier(args.parent_id, "parent_id");
        const upstreamArgs = { name: args.name };
        if (isNonEmptyString(args.parent_id)) {
          upstreamArgs.parent_id = args.parent_id;
        }
        const result = await callUpstreamTool("create_album", upstreamArgs);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.ADD_IMAGES_TO_ALBUM: {
        assertRequiredIdentifier(args.album_id, "album_id");
        assertImageIdList(args.image_ids);
        const upstreamArgs = {
          album_id: args.album_id,
          image_ids: args.image_ids,
        };
        if (args.image_orders !== undefined && args.image_orders !== null) {
          assertOrderEntries(args.image_orders, "image_orders", MAX_ORDER_BATCH);
          upstreamArgs.image_orders = args.image_orders;
        }
        const result = await callUpstreamTool("add_images_to_album", upstreamArgs);
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.RENAME_IMAGE: {
        assertRequiredIdentifier(args.image_id, "image_id");
        assertRequiredIdentifier(args.display_name, "display_name", 512);
        const result = await callUpstreamTool("rename_image", {
          image_id: args.image_id,
          display_name: args.display_name,
        });
        return toolResponse(makeSuccess(result));
      }

      default:
        return toolResponse(
          makeError("UNKNOWN_TOOL", `Unknown tool: ${name}`, { tool: name }),
        );
    }
  } catch (error) {
    const errObj =
      error?.ok === false
        ? error
        : makeError("UNEXPECTED_ERROR", "Unexpected tool error", {
            message: String(error?.message ?? error),
          });
    log("error", "Tool call failed", { tool: name, errObj });
    return toolResponse(errObj);
  }
});

async function main() {
  log("info", "Starting Kabegame MCPB bridge", {
    endpoint: config.endpoint,
    timeoutMs: config.timeoutMs,
    debug: config.debug,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "Kabegame MCPB bridge ready");
}

main().catch((error) => {
  log("error", "Fatal startup error", { message: String(error?.message ?? error) });
  process.exit(1);
});
