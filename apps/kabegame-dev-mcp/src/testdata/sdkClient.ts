/**
 * 单测用的 MCP SDK 客户端部分（同 `../sdk.ts`：用 `@ts-types` 绕开 Deno 对 SDK 子路径的类型解析问题）。
 */
// @ts-types="../../../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts"
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
// @ts-types="../../../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.d.ts"
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// @ts-types="../../../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.d.ts"
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
