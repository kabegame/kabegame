import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { ROOT, WPEFONT_FE_WASM, WPEFONT_WASM, WPESL2WGSL_FE_WASM, WPESL2WGSL_WASM } from "../../scripts/paths.ts";

/**
 * 场景宿主的两个 wasm 依赖：构建（`vite build`，含 watch 的第一次）与测试（vitest）开始前各确保一次是最新的，再拷进 `src/`。
 *
 * - wpesl2wgsl：直接跑 `scripts/build-wpesl2wgsl.ts`，新不新由 cargo 判断（最新时约 0.5 s）；
 * - wpefont：`scripts/build-wpefont.ts --if-stale`，按输入指纹判断，没变就跳过（它是全量编译，约 1 分钟）；
 * - 拷贝：内容相同不重写，免得 watch / dev 收到一次文件变更。
 *
 * 构建失败（缺 clang、缺 rustup 目标、子模块没初始化等）只告警，沿用已有产物——那样场景会退回预览图或文本层报 `text:engine`，
 * 告警里说明后果；构建脚本自己的报错（含要运行的命令）照常打在前面。kabegame 的 dev / build 经 `WpeSceneHostPlugin`
 * 跑宿主的 vite build，dev 工具的 `buildSceneHost.ts` 与手动 `deno task --cwd apps/wpe-scene build` 也走这里。
 */
interface WasmDep {
  name: string;
  script: string;
  args: string[];
  built: string;
  dest: string;
  /** 用不上最新产物时场景会怎样（告警里说）。 */
  consequence: string;
}

const DEPS: WasmDep[] = [
  {
    name: "wpesl2wgsl",
    script: "scripts/build-wpesl2wgsl.ts",
    args: [],
    built: WPESL2WGSL_WASM,
    dest: WPESL2WGSL_FE_WASM,
    consequence: "场景壁纸会退回预览图",
  },
  {
    name: "wpefont",
    script: "scripts/build-wpefont.ts",
    args: ["--if-stale"],
    built: WPEFONT_WASM,
    dest: WPEFONT_FE_WASM,
    consequence: "带文本对象的场景会报 text:engine、退回预览图",
  },
];

/** 一个进程只同步一次：watch 重新构建、vitest 的多次配置解析都不再跑。 */
let synced = false;

const rel = (p: string) => path.relative(ROOT, p);

function syncDep(dep: WasmDep, warn: (message: string) => void, info: (message: string) => void): void {
  const res = spawnSync("deno", ["run", "-A", path.join(ROOT, dep.script), ...dep.args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  const failed = res.error || res.status !== 0;
  if (!fs.existsSync(dep.built)) {
    warn(`没有 ${rel(dep.built)}，${dep.consequence}。构建失败的原因见上面 [build:${dep.name}] 的输出`);
    return;
  }
  if (failed) {
    warn(
      `${dep.name} 构建失败（${res.error ?? `退出码 ${res.status}`}），沿用已有的 ${rel(dep.built)}；它可能过旧，` +
        `${dep.consequence}。原因见上面 [build:${dep.name}] 的输出`,
    );
  }
  const bytes = fs.readFileSync(dep.built);
  if (fs.existsSync(dep.dest) && fs.readFileSync(dep.dest).equals(bytes)) return;
  fs.mkdirSync(path.dirname(dep.dest), { recursive: true });
  fs.writeFileSync(dep.dest, bytes);
  info(`复制 ${rel(dep.built)} → ${rel(dep.dest)}`);
}

export function sceneWasmDeps(): Plugin {
  return {
    name: "kabegame-scene-wasm-deps",
    configResolved(config) {
      if (synced) return;
      synced = true;
      const tag = "[scene-wasm]";
      for (const dep of DEPS) {
        syncDep(
          dep,
          (message) => config.logger.warn(`${tag} ${message}`),
          (message) => config.logger.info(`${tag} ${message}`),
        );
      }
    },
  };
}
