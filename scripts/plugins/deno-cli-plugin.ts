import { BasePlugin } from "./base-plugin.ts";
import { BuildSystem } from "../build-system.ts";
import * as path from "path";
import { existsSync } from "fs";
import { ROOT, TARGET_DIR, run, platformExeExt } from "../utils.ts";
import { OSPlugin } from "./os-plugin.ts";

/**
 * DenoCliPlugin — 与 TauriCliPlugin 同款：树内自编 deno CLI(third/deno,pin v2.9.0,
 * third-patches/deno series)编到统一 target,在 run.ts 每次进入构建流程前增量刷新
 * (warm ≈ 秒级 no-op),保证 patch 变更后 CLI 及时更新——bun→deno 迁移的"可自修 bug"通道。
 *
 * - PATH 前置由 TauriCliPlugin.prepareEnv 完成(同一 BIN_DIR),此处不重复。
 * - 首次 bootstrap(还没有任何 deno 时)走 `bash scripts/build-deno.sh`(纯 bash)。
 * - CI 设 KABEGAME_SKIP_DENO_CLI=1 用官方 2.9.0 二进制,跳过源码构建。
 * - deno_core 的 `embed_ext_sources` feature 仅由 kabegame-core 依赖声明启用;
 *   本 CLI 构建不开启,ext/node 懒加载 TS 源保持上游 snapshot 转译路径
 *   (见 third-patches/deno/README.md)。
 * - 默认 thin-LTO 降级档(官方 fat-LTO+cgu1 链接需 8-16GB 内存);KB_DENO_OFFICIAL=1
 *   切官方档。CARGO_PROFILE_RELEASE_* 只注入本次 spawn,绝不外泄到主程序构建。
 */
export class DenoCliPlugin extends BasePlugin {
  static readonly NAME = "DenoCliPlugin";

  static readonly CLI_MANIFEST = path.join(
    ROOT,
    "third",
    "deno",
    "cli",
    "Cargo.toml",
  );
  static readonly BIN_DIR = path.join(TARGET_DIR, "release");

  private built = false;

  constructor() {
    super(DenoCliPlugin.NAME);
  }

  apply(bs: BuildSystem): void {
    bs.hooks.beforeBuild.tap(this.name, () => {
      if (this.built) return; // bun b 全量时 beforeBuild 按组件触发多次,只需刷新一次
      if (process.env.KABEGAME_SKIP_DENO_CLI === "1") return; // CI: 官方二进制
      if (!existsSync(DenoCliPlugin.CLI_MANIFEST)) return; // submodule 未 checkout: 用 PATH 上现有 deno
      if (OSPlugin.isWindows) {
        // Windows 不能覆盖运行中的 deno.exe;改动 third/deno 后手动
        // `bash scripts/build-deno.sh`(用官方 deno 或另一份拷贝运行)。
        return;
      }
      this.built = true;

      // 与 build-deno.sh 保持完全一致的编译环境(RUSTFLAGS 固定为 -Awarnings,不继承
      // ReleasePlugin 的 codegen-units=1 等),否则 cargo 指纹漂移会反复触发全量重编。
      // 用临时改 process.env 而非 opts.env,避免 run() 把整份 env JSON 打进日志。
      const saved: Record<string, string | undefined> = {};
      const overrides: Record<string, string | undefined> = {
        RUSTFLAGS: "-Awarnings",
        ...(process.env.KB_DENO_OFFICIAL === "1"
          ? {
              CARGO_PROFILE_RELEASE_LTO: undefined,
              CARGO_PROFILE_RELEASE_CODEGEN_UNITS: undefined,
              CARGO_PROFILE_RELEASE_OPT_LEVEL: undefined,
            }
          : {
              CARGO_PROFILE_RELEASE_LTO: "thin",
              CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
              CARGO_PROFILE_RELEASE_OPT_LEVEL: "2",
            }),
      };
      for (const [k, v] of Object.entries(overrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        run(
          "cargo",
          [
            "build",
            "--release",
            "--locked",
            "--manifest-path",
            DenoCliPlugin.CLI_MANIFEST,
            // 显式统一到根 target(deno workspace 默认是 third/deno/target)
            "--target-dir",
            TARGET_DIR,
          ],
          { cwd: ROOT },
        );
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      const bin = path.join(DenoCliPlugin.BIN_DIR, `deno${platformExeExt()}`);
      if (!existsSync(bin)) {
        throw new Error(
          `自编 deno 未产出: ${bin}\n请检查 third/deno 子模块是否已初始化(git submodule update --init third/deno)并已应用 patch(deno task patch deno)，或先 bash scripts/build-deno.sh`,
        );
      }
    });
  }
}
