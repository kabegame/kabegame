#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const manifestPath = fileURLToPath(new URL("../manifest.json", import.meta.url));

function fail(message) {
  process.stderr.write(`[manifest-check] ${message}\n`);
  process.exit(1);
}

function ok(message) {
  process.stdout.write(`[manifest-check] ${message}\n`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`failed to parse manifest.json: ${String(error?.message ?? error)}`);
}

const requiredTopFields = [
  "manifest_version",
  "name",
  "version",
  "description",
  "author",
  "server",
];

for (const field of requiredTopFields) {
  if (!(field in manifest)) {
    fail(`missing required field: ${field}`);
  }
}

if (manifest.manifest_version !== "0.3") {
  fail(`manifest_version must be "0.3", got "${manifest.manifest_version}"`);
}

if (!manifest.author || typeof manifest.author.name !== "string") {
  fail("author.name must exist and be a string");
}

if (manifest.server?.type !== "node") {
  fail(`server.type must be "node", got "${manifest.server?.type}"`);
}

if (!manifest.server?.entry_point || !manifest.server?.mcp_config?.command) {
  fail("server.entry_point and server.mcp_config.command are required for node bundles");
}

if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
  fail("tools should be a non-empty array for this bundle");
}

ok("manifest.json basic checks passed");
