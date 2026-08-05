#!/usr/bin/env -S deno run -A
/**
 * 管理 third/ 子模块对应的 third-patches/ patch series。
 *
 * 用法:
 *   deno task patch cef              # 套用:先 reset 回纯净基线,再依次应用整个系列
 *   deno task patch cef --reverse    # 移除:reset 回纯净基线,就这样
 *   deno task patch --all --check    # 一次性 worktree 里预检,不动真实工作区
 *
 * **模型:reset 即纯净。** 子模块的源码全在 git 里,`git reset --hard <当前 HEAD>` 永远能
 * 拿回纯净基线,所以两个方向都是幂等的全量操作,不需要"当前应用到第几个"这类状态推断:
 *   - 套用 = reset + 全量 apply(重复执行结果一致;应用到一半失败时也不会留下半套状态)
 *   - 移除 = reset(不需要逆序 `apply -R`,也就不要求 patch 与已应用内容逐字节一致)
 *
 * 由此**取消了追加式约束**:patch 文件可以随意修改、删除、重新编号——下一次套用总是从
 * 纯净基线重新展开整个系列。历史上的 `--from N` 重同步与工作区纯净度门控随之删除。
 *
 * 代价:reset 会丢弃子模块工作区里的一切未提交改动。要在 third/ 下做本地开发,请先自行
 * commit 到子模块的分支上(reset 的目标是子模块**当前 HEAD**,提交不会被丢弃)。
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import chalk from "chalk";
import { Command } from "commander";
import { globSync } from "glob";
import { ROOT, THIRD_DIR } from "./utils.ts";

const THIRD_PATCHES_DIR = path.join(ROOT, "third-patches");

/**
 * 不由本工具接管的子模块——patch 有各自的应用方式,`third-patches/<dir>/` 下的文件
 * 对它只是**来源记录**。
 *
 * `rusty_v8` 是**就地复用的胖构建树**:嵌套子模块(v8/build/third_party/*)与几十 GB 的
 * 已编译 `target/` 都在其中,还带若干非 diff 形式的 fixup。对它 `reset --hard` 会重置
 * 嵌套子模块指针并抹掉构建状态,代价是从零重编。它的 patch 由 `scripts/build-v8.ts`
 * 在构建流程里幂等应用(含跨嵌套子模块的 0002),见 third-patches/rusty_v8/README.md。
 *
 * 注:`cef` 曾经也在此列——它的 patch 一度以提交形式挂在自建分支 `kabegame-7827` 上,
 * 而 gitlink 指向那个只存在于本地的提交(clone 后 `submodule update` 必然失败)。现已
 * 回到官方上游 pin + 标准 patch 系列;`automate-git.py` 只认提交这一约束改由
 * `scripts/build-chromium.ts` 在构建前把工作区状态固化成临时分支来满足。
 */
const MANUAL_REPOS = new Set(["rusty_v8"]);

export interface RepoPlan {
  dir: string;
  sub: string;
  patchDir: string;
  patches: string[];
}

interface GitApplyOptions {
  reverse?: boolean;
  check?: boolean;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const error = result.error?.message ?? "";
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: [result.stderr ?? "", error].filter(Boolean).join("\n").trim(),
  };
}

function repoPlan(dir: string): RepoPlan {
  const patchDir = path.join(THIRD_PATCHES_DIR, dir);
  return {
    dir,
    sub: path.join(THIRD_DIR, dir),
    patchDir,
    patches: listPatches(patchDir),
  };
}

function assertThirdDirName(dir: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(dir) || dir === "." || dir === "..") {
    throw new Error(`无效的 third 目录名: ${dir}`);
  }
}

export function discoverRepos(onlyDir?: string, all = false): RepoPlan[] {
  if (onlyDir && all) {
    throw new Error("[third-dir] 与 --all 不能同时使用");
  }

  if (onlyDir) {
    assertThirdDirName(onlyDir);
    return [repoPlan(onlyDir)];
  }

  if (!all) {
    throw new Error("请指定 third 目录，例如 `deno task patch cef`，或使用 --all");
  }

  if (!fs.existsSync(THIRD_PATCHES_DIR)) {
    return [];
  }

  return globSync("*/", {
    cwd: THIRD_PATCHES_DIR,
    absolute: true,
  })
    .map((patchDir) => path.basename(path.normalize(patchDir)))
    .sort((a, b) => a.localeCompare(b))
    .map(repoPlan);
}

export function listPatches(patchDir: string): string[] {
  if (!fs.existsSync(patchDir)) {
    return [];
  }

  return globSync("*.patch", {
    cwd: patchDir,
    absolute: true,
    nodir: true,
  }).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

export function isRepo(sub: string): boolean {
  const result = runCommand("git", ["-C", sub, "rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    return false;
  }

  try {
    return fs.realpathSync(result.stdout.trim()) === fs.realpathSync(sub);
  } catch {
    return false;
  }
}

/**
 * 解析 patch 会**新建**的文件路径(`new file mode` 对应的 `+++ b/<path>`)。
 *
 * `git reset --hard` 只还原已跟踪文件,patch 新建的那些在 reset 后会沦为 untracked 残留,
 * 下一次 `git apply` 撞见既存文件即失败。这里精确点名删除,而不是 `git clean -fd`——
 * 后者会连带清掉子模块里正当的未跟踪内容(构建产物、本地笔记)。
 */
export function patchCreatedFiles(patch: string): string[] {
  const lines = fs.readFileSync(patch, "utf8").split("\n");
  const created: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("new file mode")) continue;
    // diff header 里 `new file mode` 与 `+++ b/<path>` 之间还隔着 index/--- 行
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const matched = lines[j].match(/^\+\+\+ b\/(.+)$/);
      if (matched) {
        created.push(matched[1].trim());
        break;
      }
    }
  }

  return created;
}

/**
 * 把子模块还原到纯净基线:`reset --hard` 到它**当前的 HEAD**(patch-manager 从不 commit,
 * 故 HEAD 恒为父仓库 pin 的那个提交),再删掉系列会新建的文件的残留。
 */
export function resetToBaseline(
  plan: RepoPlan,
): { ok: boolean; stderr?: string } {
  const reset = runCommand("git", ["-C", plan.sub, "reset", "--hard", "HEAD"]);
  if (!reset.ok) {
    return { ok: false, stderr: reset.stderr };
  }

  for (const patch of plan.patches) {
    for (const relative of patchCreatedFiles(patch)) {
      const target = path.join(plan.sub, relative);
      // 防越界:patch 里的路径必须落在子模块内
      if (!path.resolve(target).startsWith(path.resolve(plan.sub) + path.sep)) {
        return { ok: false, stderr: `patch 越界的新建路径: ${relative}` };
      }
      fs.rmSync(target, { force: true });
    }
  }

  return { ok: true };
}

export function gitApply(
  sub: string,
  patch: string,
  options: GitApplyOptions = {},
): { ok: boolean; stderr: string } {
  const args = ["-C", sub, "apply"];
  if (options.reverse) {
    args.push("--reverse");
  }
  if (options.check) {
    args.push("--check");
  }
  args.push("--", patch);

  const result = runCommand("git", args);
  return {
    ok: result.ok,
    stderr: result.stderr || result.stdout.trim(),
  };
}

export function preflight(
  plan: RepoPlan,
): { ok: boolean; failedPatch?: string; stderr?: string } {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `kabegame-patch-${plan.dir}-`),
  );
  const worktree = path.join(tempRoot, "worktree");
  const addResult = runCommand("git", [
    "-C",
    plan.sub,
    "worktree",
    "add",
    "--detach",
    worktree,
    "HEAD",
  ]);

  if (!addResult.ok) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    return { ok: false, stderr: addResult.stderr };
  }

  try {
    // 一次性 worktree 从 HEAD 建出,本就是纯净基线,直接链式套用即可。
    // 移除方向无需预检——它只是 reset,不可能失败在 patch 上。
    for (const patch of plan.patches) {
      const result = gitApply(worktree, patch);
      if (!result.ok) {
        return { ok: false, failedPatch: patch, stderr: result.stderr };
      }
    }

    return { ok: true };
  } finally {
    runCommand("git", [
      "-C",
      plan.sub,
      "worktree",
      "remove",
      "--force",
      worktree,
    ]);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function patchFailure(
  plan: RepoPlan,
  patch: string | undefined,
  stderr = "",
): Error {
  const patchName = patch ? path.basename(patch) : "worktree preflight";
  const detail = stderr ? `:\n${stderr}` : "";
  return new Error(`${plan.dir}/${patchName} 失败${detail}`);
}

export function processRepo(
  plan: RepoPlan,
  options: { reverse: boolean; check: boolean },
): void {
  if (plan.patches.length === 0) {
    console.log(chalk.gray(`${plan.dir}: 无 patch，nothing to do`));
    return;
  }

  if (MANUAL_REPOS.has(plan.dir)) {
    console.log(
      chalk.gray(`${plan.dir}: 由其构建脚本自行应用,patch-manager 跳过`),
    );
    return;
  }

  if (!isRepo(plan.sub)) {
    throw new Error(
      `${plan.dir}: 子模块未初始化，请运行 git submodule update --init third/${plan.dir}`,
    );
  }

  // --check:在一次性 worktree 里链式模拟,不动真实工作区
  if (options.check) {
    const checked = preflight(plan);
    if (!checked.ok) {
      throw patchFailure(plan, checked.failedPatch, checked.stderr);
    }
    console.log(chalk.green(`${plan.dir}: OK dry-run`));
    return;
  }

  // 两个方向都从 reset 开始——移除到此为止,套用再展开整个系列。
  const reset = resetToBaseline(plan);
  if (!reset.ok) {
    throw new Error(`${plan.dir}: reset 到纯净基线失败:\n${reset.stderr ?? ""}`);
  }

  if (options.reverse) {
    console.log(chalk.green(`${plan.dir}: reset 到纯净基线`));
    return;
  }

  for (const patch of plan.patches) {
    const result = gitApply(plan.sub, patch);
    if (!result.ok) {
      // 不留半套状态:失败即退回纯净基线,重跑本命令即可再试。
      resetToBaseline(plan);
      throw patchFailure(plan, patch, `${result.stderr}\n已 reset 回纯净基线`);
    }
  }

  console.log(
    chalk.green(`${plan.dir}: ${plan.patches.length} patches applied`),
  );
}

interface CliOptions {
  reverse: boolean;
  check: boolean;
  all: boolean;
}

export function main(argv = process.argv): void {
  const program = new Command();
  program
    .name("patch")
    .description("套用或移除 third/ 子模块的 patch series（两个方向都先 reset 回纯净基线）")
    .argument("[third-dir]", "third/ 下的子目录名，例如 cef")
    .option("-r, --reverse", "移除 patch（reset 回纯净基线）", false)
    .option("--check", "仅在一次性 worktree 中预检", false)
    .option("--all", "处理 third-patches/ 下的全部仓库", false)
    .action((thirdDir: string | undefined, options: CliOptions) => {
      let plans: RepoPlan[];
      try {
        plans = discoverRepos(thirdDir, options.all);
      } catch (error) {
        console.error(chalk.red(`✗ ${(error as Error).message}`));
        process.exitCode = 1;
        return;
      }
      if (plans.length === 0) {
        console.log(chalk.gray("third-patches/ 下没有可处理的仓库"));
        return;
      }

      const failures: string[] = [];
      for (const plan of plans) {
        try {
          processRepo(plan, options);
        } catch (error) {
          const message = (error as Error).message;
          failures.push(message);
          console.error(chalk.red(`✗ ${message}`));
          if (!options.all) {
            break;
          }
        }
      }

      if (options.all) {
        const succeeded = plans.length - failures.length;
        const summary = `${succeeded}/${plans.length} repositories succeeded`;
        console.log(failures.length ? chalk.red(summary) : chalk.green(summary));
      }
      if (failures.length) {
        process.exitCode = 1;
      }
    });

  program.parse(argv);
}

// import.meta.main 是 Deno 运行时字段，项目的 TS lib 里没有它的声明
if ((import.meta as { main?: boolean }).main) {
  main();
}
