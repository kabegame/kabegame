/**
 * MCP SDK 在本包里的唯一入口（服务端用到的部分）。
 *
 * 为什么不直接 import：Deno 2.9 给 `@modelcontextprotocol/sdk/<子路径>.js` 找类型时只认 exports 的 `types` 条件，SDK 的
 * `"./*": { "types": "./dist/esm/*.d.ts" }` 会拼出 `server/mcp.js.d.ts` 这种不存在的文件，`deno check` 报 TS2307
 * （tsc 会退到 `import` 条件、按 `.js` 找到同名 `.d.ts`，Deno 不会）。这里用 `@ts-types` 直接指向声明文件；依赖提升在根
 * `node_modules`（`deno.json` 的 `nodeModulesLinker: hoisted`）。运行时照常按包名解析，不受影响。
 */
// @ts-types="../../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts"
export { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-types="../../../node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.d.ts"
export { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// @ts-types="../../../node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts"
export type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
// @ts-types="../../../node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts"
export type {
  CallToolResult,
  ReadResourceResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
