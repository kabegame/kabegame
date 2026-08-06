/**
 * 生成 PathQL TypeScript 客户端（packages/kabegame-pathql-client/index.ts）。
 *
 * provider DSL（*.provider.json5）在编译期内嵌进 kabegame-cli，旧二进制会静默生成
 * 旧客户端——因此默认每次先增量构建 debug CLI（无改动时秒级完成）再执行
 * `pathql generate`。外壳 packages/kabegame-pathql-client/package.json 入库
 * （workspace 成员，`deno install` 链接进 node_modules），index.ts 为生成物不入库。
 *
 * 用法：
 *   deno task pathql:generate                # 增量构建 debug CLI 后生成
 *   deno task pathql:generate --skip-build   # 直接用现有 CLI 二进制（debug/release 取最新）
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, TARGET_DIR } from "./paths.ts";

const OUT_RELATIVE = path.join("packages", "kabegame-pathql-client", "index.ts");

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function usageError(message: string): never {
  console.error(message);
  console.error("用法: deno task pathql:generate [--skip-build]");
  process.exit(2);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) die(`无法执行 ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    die(`${command} 执行失败（退出码 ${result.status ?? "unknown"}）`);
  }
}

function cliBinary(profile: "debug" | "release"): string {
  const base = path.join(TARGET_DIR, profile, "kabegame-cli");
  return process.platform === "win32" ? `${base}.exe` : base;
}

function isExecutable(filename: string): boolean {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

/** --skip-build 下取现有二进制；debug/release 都在时用最近构建的那个，避免旧客户端。 */
function resolveExistingCli(): string {
  const candidates = (["debug", "release"] as const)
    .map(cliBinary)
    .filter(isExecutable);
  if (candidates.length === 0) {
    die(
      "未找到 kabegame-cli 二进制。去掉 --skip-build，或先运行: deno task b -c kabegame-cli",
    );
  }
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

function main(): void {
  let skipBuild = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--skip-build") skipBuild = true;
    else usageError(`未知参数: ${arg}`);
  }

  let cli: string;
  if (skipBuild) {
    cli = resolveExistingCli();
  } else {
    console.log("==> 增量构建 kabegame-cli（DSL 编译期内嵌，旧二进制会生成旧客户端）");
    run("deno", ["task", "b", "-c", "kabegame-cli"]);
    cli = cliBinary("debug");
    if (!isExecutable(cli)) die(`构建完成但未找到 ${cli}`);
  }

  console.log(`==> 生成 ${OUT_RELATIVE}（${path.relative(ROOT, cli)}）`);
  run(cli, ["pathql", "generate", "--target", "typescript", "--out", OUT_RELATIVE]);
}

main();
