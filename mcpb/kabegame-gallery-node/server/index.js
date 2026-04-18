#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOL_NAMES = {
  READ_PROVIDER: "read_gallery_provider",
  READ_METADATA: "read_image_metadata",
  SET_ALBUM_ORDER: "set_album_images_order",
};

const MAX_ORDER_BATCH = 100;
const DEFAULT_ENDPOINT = "http://127.0.0.1:7490/mcp";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

let rpcCounter = 1;

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
  if (path.length > 512) {
    throw makeError("INVALID_ARGUMENT", "path is too long (max 512)");
  }
}

function assertImageId(imageId) {
  if (!isNonEmptyString(imageId)) {
    throw makeError("INVALID_ARGUMENT", "image_id must be a non-empty string");
  }
  if (imageId.length > 256) {
    throw makeError("INVALID_ARGUMENT", "image_id is too long (max 256)");
  }
}

function assertAlbumOrderInput(albumId, imageOrders) {
  if (!isNonEmptyString(albumId)) {
    throw makeError("INVALID_ARGUMENT", "album_id must be a non-empty string");
  }
  if (!Array.isArray(imageOrders)) {
    throw makeError("INVALID_ARGUMENT", "image_orders must be an array");
  }
  if (imageOrders.length < 1) {
    throw makeError("INVALID_ARGUMENT", "image_orders must contain at least one item");
  }
  if (imageOrders.length > MAX_ORDER_BATCH) {
    throw makeError(
      "INVALID_ARGUMENT",
      `image_orders exceeds max batch size ${MAX_ORDER_BATCH}`,
    );
  }

  for (let i = 0; i < imageOrders.length; i += 1) {
    const item = imageOrders[i];
    if (!item || typeof item !== "object") {
      throw makeError("INVALID_ARGUMENT", `image_orders[${i}] must be an object`);
    }
    if (!isNonEmptyString(item.image_id)) {
      throw makeError("INVALID_ARGUMENT", `image_orders[${i}].image_id must be a string`);
    }
    if (!Number.isInteger(item.order)) {
      throw makeError("INVALID_ARGUMENT", `image_orders[${i}].order must be an integer`);
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

async function rpcCall(method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const id = rpcCounter++;
  const req = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  try {
    log("debug", "Sending upstream MCP request", { method, id });
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(req),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw makeError("UPSTREAM_HTTP_ERROR", `Upstream returned HTTP ${response.status}`, {
        status: response.status,
      });
    }

    const body = await response.json();
    if (body?.error) {
      throw makeError("UPSTREAM_MCP_ERROR", "Upstream MCP error", body.error);
    }
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, "result")) {
      throw makeError("UPSTREAM_PROTOCOL_ERROR", "Upstream response missing result", body);
    }

    return body.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw makeError(
        "TIMEOUT",
        `Upstream request timed out after ${config.timeoutMs}ms`,
        { method },
      );
    }
    if (error?.ok === false) {
      throw error;
    }
    throw makeError("UPSTREAM_REQUEST_FAILED", "Failed to call upstream MCP endpoint", {
      message: String(error?.message ?? error),
      method,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const server = new Server(
  {
    name: "kabegame-gallery-local-mcpb",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAMES.READ_PROVIDER,
      description:
        "Read one Kabegame gallery provider path page (e.g. all/0, album/{id}/album-order/0).",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Kabegame provider path without URI prefix.",
          },
        },
        required: ["path"],
      },
    },
    {
      name: TOOL_NAMES.READ_METADATA,
      description: "Read metadata for one image id from Kabegame local storage.",
      inputSchema: {
        type: "object",
        properties: {
          image_id: {
            type: "string",
            description: "Image ID from browse result.",
          },
        },
        required: ["image_id"],
      },
    },
    {
      name: TOOL_NAMES.SET_ALBUM_ORDER,
      description:
        "Set manual order for up to 100 images in one album. Call multiple times for larger albums.",
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case TOOL_NAMES.READ_PROVIDER: {
        const path = args.path;
        assertProviderPath(path);
        const result = await rpcCall("resources/read", {
          uri: `provider://${path}`,
        });
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.READ_METADATA: {
        const imageId = args.image_id;
        assertImageId(imageId);
        const result = await rpcCall("resources/read", {
          uri: `image://${imageId}/metadata`,
        });
        return toolResponse(makeSuccess(result));
      }

      case TOOL_NAMES.SET_ALBUM_ORDER: {
        const albumId = args.album_id;
        const imageOrders = args.image_orders;
        assertAlbumOrderInput(albumId, imageOrders);
        const result = await rpcCall("tools/call", {
          name: "set_album_images_order",
          arguments: {
            album_id: albumId,
            image_orders: imageOrders,
          },
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
