#!/usr/bin/env node
/**
 * Start nodemon to watch crawler plugin sources based on Nx inputs config.
 *
 * Why:
 * - Avoid hand-maintaining nodemon.json
 * - Derive watch/ignore/ext from `nx.json` namedInputs + project target inputs
 *
 * Usage:
 *   node scripts/nx-nodemon-plugin-watch.mjs [--verbose]
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import devkit from "@nx/devkit";

const { readJsonFile, joinPathFragments } = devkit;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function parseFlags(argv) {
  return {
    verbose: argv.includes("--verbose"),
  };
}

function isGlobLike(p) {
  return /[*?[\]{}()!]/.test(p);
}

function globBaseDir(relPosixPath) {
  // Given "a/b/**/x.{png,jpg}" => "a/b"
  const parts = relPosixPath.split("/");
  const out = [];
  for (const part of parts) {
    if (part.includes("**") || /[*?[\]{},]/.test(part)) break;
    out.push(part);
  }
  if (out.length === 0) return ".";
  return out.join("/");
}

function uniq(arr) {
  return [...new Set(arr)];
}

function simplifyDirs(dirs) {
  // Keep only highest-level dirs (if a/b exists, drop a/b/c)
  const sorted = uniq(dirs)
    .map((d) => d.replace(/\/+$/, "") || ".")
    .sort((a, b) => a.localeCompare(b));
  const out = [];
  for (const d of sorted) {
    const isChild = out.some((p) => d === p || d.startsWith(p + "/"));
    if (!isChild) out.push(d);
  }
  return out;
}

function expandNamedInputs(nxJson, list, seen = new Set()) {
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    if (item.startsWith("^")) continue; // deps inputs (not file globs we can easily watch here)
    if (nxJson?.namedInputs?.[item]) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(...expandNamedInputs(nxJson, nxJson.namedInputs[item], seen));
    } else {
      out.push(item);
    }
  }
  return out;
}

function resolveProjectTargetInputs({ nxJson, projectRoot, targetInputs }) {
  const expanded = expandNamedInputs(nxJson, targetInputs);
  const resolved = expanded
    .filter((s) => typeof s === "string")
    .map((s) => s.replaceAll("{projectRoot}", toPosix(projectRoot)));
  return resolved;
}

function collectExtensionsFromInputs(inputs) {
  const exts = new Set();
  for (const p of inputs) {
    const s = p.startsWith("!") ? p.slice(1) : p;
    // *.ext
    const m1 = s.match(/\*\.([a-zA-Z0-9]+)\b/g);
    if (m1) {
      for (const hit of m1) exts.add(hit.replace("*.", "").toLowerCase());
    }
    // *.{a,b,c}
    const m2 = s.match(/\*\.\{([^}]+)\}/g);
    if (m2) {
      for (const hit of m2) {
        const inner = hit.match(/\*\.\{([^}]+)\}/)?.[1];
        if (!inner) continue;
        inner
          .split(",")
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean)
          .forEach((x) => exts.add(x));
      }
    }
  }

  // Always include these (packaging + plugin sources commonly touch them)
  [
    "js",
    "mjs",
    "cjs",
    "json",
    "rhai",
    "md",
    "txt",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "ico",
    "svg",
    "bmp",
  ].forEach((e) => exts.add(e));
  return [...exts].sort().join(",");
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function startNodemon({ configPath, verbose }) {
  // On Windows, spawning .cmd without a shell can yield EINVAL in some environments.
  // Use `shell: true` to let the shell resolve `pnpm` correctly.
  const cmd = "pnpm";
  const args = ["exec", "nodemon", "--config", configPath, "--on-change-only"];
  if (verbose) args.push("--verbose");

  const child = spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const shutdown = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const projectName = "crawler-plugins";
  const targetName = "package";

  const nxJsonPath = joinPathFragments(root, "nx.json");
  const nxJson = readJsonFile(nxJsonPath);

  // Runtime script: avoid Nx "Tree" APIs; read the project's `project.json` directly.
  const projectRoot = "crawler-plugins";
  const projectJsonPath = joinPathFragments(root, projectRoot, "project.json");
  const projectJson = readJsonFile(projectJsonPath);
  const target = projectJson?.targets?.[targetName];
  const targetInputs = Array.isArray(target?.inputs)
    ? target.inputs
    : ["default"];
  const resolvedInputs = resolveProjectTargetInputs({
    nxJson,
    projectRoot,
    targetInputs,
  });

  const positive = resolvedInputs.filter(
    (p) => typeof p === "string" && !p.startsWith("!")
  );
  const negative = resolvedInputs
    .filter((p) => typeof p === "string" && p.startsWith("!"))
    .map((p) => p.slice(1));

  const watchDirs = simplifyDirs(
    positive.map((p) => {
      const rel = toPosix(p);
      if (!isGlobLike(rel)) return toPosix(path.posix.dirname(rel));
      return globBaseDir(rel);
    })
  ).filter((d) => d !== "");

  const ignore = simplifyDirs(
    [
      ...negative.map(toPosix),
      "**/node_modules/**",
      `${toPosix(projectRoot)}/node_modules/**`,
      `${toPosix(projectRoot)}/packed/**`,
      "**/*.kgpg",
      "dist/**",
      "src-tauri/target/**",
    ].map((p) => p.replace(/\\/g, "/"))
  );

  const ext = collectExtensionsFromInputs(resolvedInputs);
  const exec = "node scripts/package-and-signal.js";

  const outDir = path.join(root, ".nx", "nodemon");
  ensureDir(outDir);
  const configPath = path.join(outDir, `plugins.${targetName}.json`);

  const nodemonConfig = {
    watch: watchDirs.length ? watchDirs : [toPosix(projectRoot)],
    ignore,
    ext,
    exec,
    delay: 500,
    legacyWatch: false,
    verbose: true,
  };

  fs.writeFileSync(configPath, JSON.stringify(nodemonConfig, null, 2), "utf-8");

  if (flags.verbose) {
    console.log(`[nx-nodemon] project=${projectName} target=${targetName}`);
    console.log(
      `[nx-nodemon] config=${toPosix(path.relative(root, configPath))}`
    );
    console.log(`[nx-nodemon] watch=${nodemonConfig.watch.join(", ")}`);
  }

  startNodemon({ configPath, verbose: flags.verbose });
}

main().catch((err) => {
  console.error("[nx-nodemon] error:", err?.stack || err?.message || err);
  process.exit(1);
});
