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
const DEV_TARGET_DIR = "target-dev";

if (!process.env.CARGO_TARGET_DIR) {
  // commander 的子命令名就是第一个位置参数
  const cmd = process.argv[2];
  if (cmd && cmd !== "build") {
    process.env.CARGO_TARGET_DIR = DEV_TARGET_DIR;
  }
}
