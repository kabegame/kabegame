#!/usr/bin/env node
/**
 * 原子管理 third/ 子模块对应的 third-patches/ patch series。
 *
 * 用法:
 *   bun run patch cef
 *   bun run patch cef --reverse
 *   bun run patch --all --check
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import chalk from "chalk";
import { Command } from "commander";
import { globSync } from "glob";
import { ROOT, THIRD_DIR } from "./utils";

const THIRD_PATCHES_DIR = path.join(ROOT, "third-patches");

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
    throw new Error("请指定 third 目录，例如 `bun run patch cef`，或使用 --all");
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
 * 工作区是否纯净(据以判定 forward/reverse 门控)。**不含子仓库**:`--ignore-submodules=all`
 * 只看本仓库自己的已跟踪改动——嵌套子模块可能被提前单独应用(如 0002 经 `build/` 前缀跨进 build
 * 子模块),且跨路径应用顺序不保证,故子仓库的脏不应门控父仓库。空即纯净。
 */
export function isClean(sub: string): boolean {
  const result = runCommand("git", [
    "-C",
    sub,
    "status",
    "--porcelain",
    "--ignore-submodules=all",
  ]);
  return result.ok && result.stdout.trim() === "";
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
  reverse: boolean,
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
    if (reverse) {
      for (const patch of plan.patches) {
        const result = gitApply(worktree, patch);
        if (!result.ok) {
          return { ok: false, failedPatch: patch, stderr: result.stderr };
        }
      }

      for (const patch of [...plan.patches].reverse()) {
        const result = gitApply(worktree, patch, { reverse: true });
        if (!result.ok) {
          return { ok: false, failedPatch: patch, stderr: result.stderr };
        }
      }
    } else {
      for (const patch of plan.patches) {
        const result = gitApply(worktree, patch);
        if (!result.ok) {
          return { ok: false, failedPatch: patch, stderr: result.stderr };
        }
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

/**
 * 链式应用一组 patch 到真实工作区:逐个 `git apply`,后一个看到前一个的结果。
 * 任一失败即 best-effort 完整回滚(逆序撤回已应用的),回滚本身也可能失败,
 * 此时 rollbackOk 为 false,交由调用方提示手动检查。
 */
export function chainApply(
  sub: string,
  patches: string[],
  reverse: boolean,
): { ok: boolean; failedPatch?: string; stderr?: string; rollbackOk: boolean } {
  const applied: string[] = [];

  for (const patch of patches) {
    const result = gitApply(sub, patch, { reverse });
    if (result.ok) {
      applied.push(patch);
      continue;
    }

    let rollbackOk = true;
    for (const done of [...applied].reverse()) {
      if (!gitApply(sub, done, { reverse: !reverse }).ok) {
        rollbackOk = false;
      }
    }

    return { ok: false, failedPatch: patch, stderr: result.stderr, rollbackOk };
  }

  return { ok: true, rollbackOk: true };
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

  if (!isRepo(plan.sub)) {
    throw new Error(
      `${plan.dir}: 子模块未初始化，请运行 git submodule update --init third/${plan.dir}`,
    );
  }

  const ordered = options.reverse
    ? [...plan.patches].reverse()
    : [...plan.patches];

  // 幂等门控,以工作区纯净度为准(apply/reverse/--check 一致):forward 只在纯净树上进行
  //(脏树视为已应用/有本地改动而跳过);reverse 只在脏树上进行(纯净树无可回滚而跳过)。
  // 复用型胖构建树(如 third/rusty_v8 就地搬入的完整构建树)常驻脏态,forward 与 --check 据此
  // 自动跳过——其嵌套子模块也不在一次性 worktree 里、无法预检,由其构建脚本自行幂等应用。
  const clean = isClean(plan.sub);
  if (!options.reverse && !clean) {
    console.log(
      chalk.gray(`${plan.dir}: 工作区非纯净,跳过(视为已应用或有本地改动)`),
    );
    return;
  }
  if (options.reverse && clean) {
    console.log(chalk.gray(`${plan.dir}: 工作区纯净,无需回滚,跳过`));
    return;
  }

  // --check:在一次性 worktree 里链式模拟,不动真实工作区
  if (options.check) {
    const checked = preflight(plan, options.reverse);
    if (!checked.ok) {
      throw patchFailure(plan, checked.failedPatch, checked.stderr);
    }
    console.log(chalk.green(`${plan.dir}: OK dry-run`));
    return;
  }

  // 链式应用到真实工作区,任一失败即 best-effort 完整回滚
  const result = chainApply(plan.sub, ordered, options.reverse);
  if (!result.ok) {
    const rollbackNote = result.rollbackOk
      ? "\n已完整回滚"
      : "\n回滚未完全成功,请手动检查工作区";
    throw patchFailure(
      plan,
      result.failedPatch,
      `${result.stderr ?? ""}${rollbackNote}`,
    );
  }

  const action = options.reverse ? "reversed" : "applied";
  console.log(chalk.green(`${plan.dir}: ${ordered.length} patches ${action}`));
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
    .description("原子应用或移除 third/ 子模块的 patch series")
    .argument("[third-dir]", "third/ 下的子目录名，例如 cef")
    .option("-r, --reverse", "逆序移除 patch", false)
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

if (import.meta.main) {
  main();
}
