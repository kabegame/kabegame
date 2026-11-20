/**
 * 按命令选定 cargo 产物目录（必须在 `scripts/run.ts` 的第一个 import 位置求值——
 * `scripts/paths.ts` 在模块加载时就把 `TARGET_DIR` 冻结下来了）。
 *
 * - `build` → `target/`（默认，不设环境变量）
 * - 其余命令（`dev` / `start` / `check` / `test`）→ `target-dev/`
 * - 显式设了 `CARGO_TARGET_DIR` 时一律以它为准，这里不插手
 *
 * 为什么要分开：cargo 把 build script 读到的环境变量**值**记进 fingerprint，值一变就
 * `EnvVarChanged` → build script 重跑 → 依赖它的整个 crate 连同全部 bin 重编重链。而
 * 这些命令注入的环境本来就不同（`KABEGAME_DATA` 按 `--release` 取值，`build` 还会往
 * RUSTFLAGS 加 `-Awarnings`），共用一个 `target/` 就会来回掀翻对方的缓存：
 * `KABEGAME_DATA` 掀 `kabegame` / `kabegame-core`（连带 `kabegame.exe` 与
 * `kabegame-cef-helper`），`CEF_PATH` 掀 `cef-dll-sys` → `cef` → `tauri-runtime-kbcef`，
 * `FFMPEG_*` 掀 `rusty_ffmpeg` → `rsmpeg` → `kabegame-core`。
 *
 * 相对值由 `paths.ts` 的 `TARGET_DIR` 按仓库根解析并回写成绝对路径，派生进程一致。
 * 详见 `scripts/AGENTS.md`「产物目录隔离」。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEV_TARGET_DIR = "target-dev";

if (!process.env.CARGO_TARGET_DIR) {
  // commander 的子命令名就是第一个位置参数
  const cmd = process.argv[2];
  if (cmd && cmd !== "build") {
    process.env.CARGO_TARGET_DIR = DEV_TARGET_DIR;
    pinPluginPackingCli();
  }
}

/**
 * 把打包 `.kgpg` 用的 `kabegame-cli` 钉在 `target/`。
 *
 * 它和上面隔离的那些产物性质不同：**不是本次构建的产物，而是一个预先构建好的工具**，
 * 由 `deno task b -c kabegame-cli`（build 命令，落 `target/`）产出，dev / check / test
 * 流程只是拿来用。`src-crawler-plugins/package-plugin.ts` 默认按 `CARGO_TARGET_DIR`
 * 去找它（那是为 `CARGO_TARGET_DIR=target-22` 的隔离构建准备的，那种场景下 cli 确实
 * 同处一个 target），所以这里显式用它支持的 `KABEGAME_CLI` 指回去，否则 dev 启动时的
 * 插件打包会找 `target-dev/release/kabegame-cli` 而报「请在 kabegame 父仓库构建 cli
 * 工具」。release 优先、debug 兜底；两个都没有时不设，让打包脚本按 `target/` 报错。
 */
function pinPluginPackingCli(): void {
  if (process.env.KABEGAME_CLI) return;
  // 同 paths.ts：`import.meta.dirname` 在本仓库的 TS 配置下没有类型
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const name = `kabegame-cli${process.platform === "win32" ? ".exe" : ""}`;
  const buildTarget = path.join(root, "target");
  const found = ["release", "debug"]
    .map((profile) => path.join(buildTarget, profile, name))
    .find((p) => fs.existsSync(p));
  process.env.KABEGAME_CLI = found ?? path.join(buildTarget, "release", name);
}
