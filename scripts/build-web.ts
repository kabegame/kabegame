/**
 * Web 发布构建统一入口：宿主出前端，容器只跑 Rust。
 *
 * 拆分原因：Apple Silicon 上 docker 的 linux/amd64 模拟层（Rosetta for Linux）
 * 存在 V8 浮点缺陷——所有 double 的小数部分被截断为整数（0.96→0、Math.PI→3、
 * parseFloat("0.96")→0），sass/rollup/UnoCSS 等跑在 deno/V8 上的 JS 构建全部
 * 被静默数值污染（rgba alpha 归零 → 背景全透明、transition 全变 0s、bundle 里
 * 97% 的小数字面量丢失），且全程零报错。Rust/C/Go 工具链不受影响（rustc、
 * esbuild 的 Go 二进制、rspack 的 SWC 浮点均实测正常）。
 * 因此：一切 JS 构建（vite 前端 + 爬虫插件打包）在宿主原生执行；容器只负责
 * 以服务器 glibc 基线（almalinux 8）链接 x86_64 Rust 二进制。dist-kabegame-web/
 * 是纯文本静态资源，与构建宿主的架构无关（web 模式下平台 define 全为 false，
 * 由 KABEGAME_MODE 驱动而非宿主 OS）。
 *
 * 注意产物目录：web 前端出 dist-kabegame-web/，桌面/Android 出 dist-kabegame/。
 * 两者的平台 define 与 chunking 完全不同，故严格分开——本脚本是「宿主出前端 →
 * 容器编 Rust 嵌入」两段式，共用目录时中途插入的桌面构建会静默把 web bundle
 * 换成桌面 bundle（浏览器里 invoke 走 __TAURI_INTERNALS__，页面全挂）。
 *
 * 用法：
 *   deno task build:web            # 日常构建
 *   deno task build:web --rebuild  # 先重建镜像（deno.lock/子模块/Dockerfile 变更后）
 *
 * 产物（均在 .kabegame/release/，见 scripts/utils.ts 的 RELEASE_DIR）：
 *   kabegame        x86_64 Linux 单二进制，前端静态资源已编译期嵌入
 *   plugins/*.kgpg  爬虫插件（web 不嵌入二进制，部署时单独传到服务器用户数据目录）
 * 部署：bash scripts/deploy-web.sh
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, TARGET_DIR } from "./paths.ts";

interface ParsedArgs {
  rebuild: boolean;
}

function die(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function usageError(message?: string): never {
  if (message) console.error(message);
  console.error("用法: deno task build:web [--rebuild]");
  process.exit(2);
}

function parseArgs(argv: string[]): ParsedArgs {
  let rebuild = false;
  for (const arg of argv) {
    if (arg === "--rebuild") {
      rebuild = true;
    } else {
      usageError(`未知参数: ${arg}`);
    }
  }
  return { rebuild };
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

function isExecutable(filename: string): boolean {
  try {
    fs.accessSync(filename, fs.constants.X_OK);
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function hasPackagedPlugin(directory: string): boolean {
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) =>
      entry.isFile() && entry.name.endsWith(".kgpg")
    );
  } catch {
    return false;
  }
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const composeArgs = [
    "compose",
    "-f",
    path.join("docker", "docker-compose.web-release.yml"),
  ];

  if (parsed.rebuild) {
    console.log("==> 重建构建镜像");
    run("docker", [...composeArgs, "build"]);
  }

  // 1) 宿主原生构建前端（vite → dist-kabegame-web/）+ 打包爬虫插件。
  //    插件打包经 kabegame-cli sidecar（宿主 TARGET_DIR/release/），缺失则先构建。
  const cli = path.join(TARGET_DIR, "release", "kabegame-cli");
  const cliExecutable = process.platform === "win32" ? `${cli}.exe` : cli;
  if (!isExecutable(cliExecutable)) {
    console.log("==> 宿主 kabegame-cli 缺失，先构建（插件 .kgpg 打包所需）");
    run("deno", ["task", "b", "-c", "kabegame-cli", "--release"]);
  }

  // pathql 生成客户端不入库，vite 侧 @kabegame/pathql-client 别名指向该文件，缺失则前端
  // 构建必败——在最前面给出明确指引（不自动生成：release CLI 的数据目录/插件集合与
  // 生成语境耦合，交由开发者显式执行）。
  const pathqlClient = path.join(
    ROOT,
    "packages",
    "kabegame-pathql-client",
    "index.ts",
  );
  if (!fs.existsSync(pathqlClient) || !fs.statSync(pathqlClient).isFile()) {
    const cliCommand = path.relative(ROOT, cliExecutable) || cliExecutable;
    die(
      "packages/kabegame-pathql-client/index.ts 不存在。\n" +
        `先运行: ${cliCommand} pathql generate --out ` +
        "packages/kabegame-pathql-client/index.ts",
    );
  }

  console.log("==> [宿主] 构建 web 前端 dist-kabegame-web/ + 插件 .kabegame/release/plugins/");
  run("deno", [
    "task",
    "b",
    "-c",
    "kabegame",
    "--mode",
    "web",
    "--skip",
    "cargo",
  ]);

  const webIndex = path.join(ROOT, "dist-kabegame-web", "index.html");
  if (!fs.existsSync(webIndex) || !fs.statSync(webIndex).isFile()) {
    die("dist-kabegame-web/index.html 不存在，前端构建未产出");
  }
  const releasePlugins = path.join(ROOT, ".kabegame", "release", "plugins");
  if (!hasPackagedPlugin(releasePlugins)) {
    die(".kabegame/release/plugins/ 无 .kgpg，插件打包未产出");
  }

  // 2) 容器内只跑 Rust（--skip vue + KABEGAME_SKIP_PLUGIN_PACKAGE=1，见 compose 注释）。
  console.log("==> [容器] 构建 x86_64 web 二进制");
  run("docker", [...composeArgs, "run", "--rm", "build"]);

  console.log("==> 完成：.kabegame/release/{kabegame,plugins/}（部署：bash scripts/deploy-web.sh）");
}

main();
