#!/usr/bin/env -S deno run -A
/**
 * 管理 third/ 子模块对应的 third-patches/ patch series。
 *
 * 用法:
 *   deno task patch cef              # 套用:先 reset 回纯净基线,再依次应用整个系列
 *   deno task patch cef --reverse    # 移除:reset 回纯净基线,就这样
 *   deno task patch --all --check    # 一次性 worktree 里预检,不动真实工作区
 *   deno task patch cef --gen --from 0005 --out third-patches/cef/0006-xxx.patch
 *                                    # 生成:把工作树里「系列到 0005 为止之外」的剩余改动导出成新 patch
 *
 * `--gen` 是唯一**不 reset** 的模式:它的输入正是子模块工作树里尚未成为 patch 的改动,reset 会把
 * 它们丢掉。它在 `GIT_INDEX_FILE` 指向的临时 index 里 `read-tree HEAD` + `apply --cached` 前缀
 * 系列得到基线树,再 `add -A` 得到工作树对应的树,两棵树相 diff 即为新 patch——全程不碰子模块真实的
 * index 与工作树(只会往对象库里写入 blob/tree 对象)。因此 `rusty_v8` 也可以用它。
 *
 * **模型:reset 即纯净。** 子模块的源码全在 git 里,`git reset --hard <当前 HEAD>` 永远能
 * 拿回纯净基线,所以两个方向都是幂等的全量操作,不需要"当前应用到第几个"这类状态推断:
 *   - 套用 = reset + 全量 apply(重复执行结果一致;应用到一半失败时也不会留下半套状态)
 *   - 移除 = reset(不需要逆序 `apply -R`,也就不要求 patch 与已应用内容逐字节一致)
 *
 * 由此**取消了追加式约束**:patch 文件可以随意修改、删除、重新编号——下一次套用总是从
 * 纯净基线重新展开整个系列。历史上的 `--from N` 重同步与工作区纯净度门控随之删除
 * (`--gen` 的 `--from` 是另一回事:只指定生成新 patch 时的基线)。
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

interface CommandOptions {
  /** 叠加在 process.env 之上的环境变量(如 `GIT_INDEX_FILE`) */
  env?: Record<string, string>;
}

function spawnOptions(options: CommandOptions) {
  return {
    env: options.env ? { ...process.env, ...options.env } : undefined,
    // spawnSync 默认只收 1 MiB 输出,超出即截断并报 ENOBUFS;整个系列的 diff 可能比这大
    maxBuffer: 1024 * 1024 * 1024,
  };
}

function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...spawnOptions(options),
  });
  const error = result.error?.message ?? "";
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: [result.stderr ?? "", error].filter(Boolean).join("\n").trim(),
  };
}

/**
 * 同 `runCommand`,但 stdout 保持原始字节:patch 内容不能先按 UTF-8 解码再编码回去,
 * 否则上游里非 UTF-8 的文件会被替换字符损坏。
 */
function runCommandBytes(
  command: string,
  args: string[],
  options: CommandOptions = {},
): { ok: boolean; stdout: Uint8Array; stderr: string } {
  const result = spawnSync(command, args, spawnOptions(options));
  const error = result.error?.message ?? "";
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? new Uint8Array(),
    stderr: [stderr, error].filter(Boolean).join("\n").trim(),
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

// --gen:把工作树里「系列之外的剩余改动」导出成新 patch。stdout 只留 diff,提示一律走 stderr。

/**
 * 解析 `--from <x>`,返回作为基线要先套用的前缀系列(第一个到 x,含 x)。
 *
 * x 可以是完整文件名、去掉 `.patch` 的名字或 4 位编号;`none` 表示只以纯净基线为底。
 * 省略时取系列的最后一个(空系列即纯净基线)。
 */
export function resolveGenBase(plan: RepoPlan, from?: string): string[] {
  if (from === undefined) {
    return plan.patches;
  }
  if (from === "none") {
    return [];
  }

  // 也接受 third-patches/<dir>/ 下的路径——shell 补全出来的就是这个形态
  const wanted = path.basename(from);
  const names = plan.patches.map((patch) => path.basename(patch));
  const matched = names.flatMap((name, index) =>
    name === wanted || name === `${wanted}.patch` ||
      (/^\d{4}$/.test(wanted) && name.startsWith(`${wanted}-`))
      ? [index]
      : []
  );

  if (matched.length === 0) {
    const series = names.length ? names.join(", ") : "空系列";
    throw new Error(`${plan.dir}: --from ${from} 不在系列里(${series})`);
  }
  if (matched.length > 1) {
    const ambiguous = matched.map((index) => names[index]).join(", ");
    throw new Error(`${plan.dir}: --from ${from} 匹配到多个 patch: ${ambiguous}`);
  }
  return plan.patches.slice(0, matched[0] + 1);
}

/** 与现有系列一致的纯 `git diff --full-index` 输出,不受用户 diff.* 配置左右 */
const GEN_DIFF_ARGS = [
  "diff",
  "--full-index",
  // 二进制改动也要能被 git apply 套用(纯文本改动的输出与不加时逐字节相同)
  "--binary",
  // 改名拆成删除 + 新建:`patchCreatedFiles` 只认 `new file mode`,改名目标会在 reset 后沦为残留
  "--no-renames",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  // 固定 a/ b/ 前缀,不受 diff.noprefix / diff.mnemonicPrefix 影响
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

/**
 * 在临时 index 里算出「纯净基线 + 前缀系列」与工作树之间的差异。
 *
 * 全部 index 写操作都落在 `GIT_INDEX_FILE` 指向的临时文件上,子模块真实的 index 与工作树
 * 保持原样——这里绝不能 reset,输入正是工作树里的那些改动。
 *
 * @returns 新 patch 的原始字节与 `--stat` 摘要;没有剩余改动时 `diff` 为 null
 */
export function generateRemaining(
  plan: RepoPlan,
  base: string[],
): { diff: Uint8Array | null; stat: string } {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `kabegame-patch-gen-${plan.dir}-`),
  );
  const env = { GIT_INDEX_FILE: path.join(tempRoot, "index") };
  const git = (args: string[]): string => {
    const result = runCommand("git", ["-C", plan.sub, ...args], { env });
    if (!result.ok) {
      throw new Error(`${plan.dir}: git ${args[0]} 失败:\n${result.stderr}`);
    }
    return result.stdout;
  };

  try {
    // 1. 子模块当前 HEAD 即纯净基线
    git(["read-tree", "HEAD"]);

    // 2. 前缀系列按文件名顺序套到临时 index 上(--cached 只改 index,不碰工作树)
    for (const patch of base) {
      const applied = runCommand(
        "git",
        ["-C", plan.sub, "apply", "--cached", "--", patch],
        { env },
      );
      if (!applied.ok) {
        throw patchFailure(
          plan,
          patch,
          `${applied.stderr}\n(套用到临时 index 时失败,子模块未被改动)`,
        );
      }
    }

    // 3. 基线树 T1
    const baseTree = git(["write-tree"]).trim();

    // 4. 同一 index 上 add -A 得到工作树对应的树 T2:尊重 .gitignore,也能收进未跟踪的新文件
    //    (直接 diff 工作树会漏掉它们);系列新建、却恰好被 ignore 的文件已在 index 里,
    //    同样按工作树内容更新
    git(["add", "-A"]);
    const workTree = git(["write-tree"]).trim();
    if (baseTree === workTree) {
      return { diff: null, stat: "" };
    }

    // 5. 两棵树相 diff 即为新 patch
    const diff = runCommandBytes("git", [
      "-C",
      plan.sub,
      ...GEN_DIFF_ARGS,
      baseTree,
      workTree,
    ]);
    if (!diff.ok) {
      throw new Error(`${plan.dir}: git diff 失败:\n${diff.stderr}`);
    }
    const stat = git([
      "diff",
      "--stat",
      "--no-renames",
      "--no-color",
      baseTree,
      workTree,
    ]).trimEnd();
    return { diff: diff.stdout.length ? diff.stdout : null, stat };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 列出 diff 里含 `\r` 的文件。树对树 diff 不做换行转换,`\r` 只可能来自 blob 本身:
 * 上游文件本就是 CRLF 时属正常,否则多半是工作树换行与子模块 autocrlf 配置不一致。
 */
function filesWithCarriageReturn(diff: Uint8Array): string[] {
  if (!diff.includes(0x0d)) {
    return [];
  }
  return new TextDecoder()
    .decode(diff)
    .split(/^(?=diff --git )/m)
    .filter((section) => section.includes("\r"))
    .map((section) => {
      const header = section.split("\n", 1)[0].replace(/\r$/, "");
      // 关闭了改名检测,a/ 与 b/ 两侧路径相同
      return header.match(/^diff --git a\/(.+) b\/\1$/)?.[1] ?? header;
    });
}

type GenTarget =
  | { kind: "stdout" }
  | { kind: "file"; file: string }
  | { kind: "dir"; dir: string };

/** 单仓库:省略 = stdout,否则是文件;多仓库:必须是已存在的目录,各写 `<dir>.patch` */
function resolveGenTarget(single: boolean, out?: string): GenTarget {
  if (out === undefined) {
    if (!single) {
      throw new Error(
        "--gen 处理多个仓库时请指定单个 [third-dir],或用 --out <目录> 为每个仓库各写一个 <dir>.patch",
      );
    }
    return { kind: "stdout" };
  }

  // 与 shell 重定向一致:相对路径按调用者所在目录解析(deno task 会把 cwd 切到仓库根,原目录在 INIT_CWD)
  const resolved = path.resolve(process.env.INIT_CWD ?? process.cwd(), out);
  const isDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();

  if (!single) {
    if (!isDir) {
      throw new Error(`--gen 处理多个仓库时 --out 须是已存在的目录: ${resolved}`);
    }
    return { kind: "dir", dir: resolved };
  }

  if (isDir) {
    throw new Error(`单个仓库时 --out 须是文件路径,而不是目录: ${resolved}`);
  }
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`--out 的父目录不存在: ${parent}`);
  }
  return { kind: "file", file: resolved };
}

export function genRepo(
  plan: RepoPlan,
  from: string | undefined,
  target: GenTarget,
): void {
  if (!isRepo(plan.sub)) {
    throw new Error(
      `${plan.dir}: 子模块未初始化，请运行 git submodule update --init third/${plan.dir}`,
    );
  }

  const base = resolveGenBase(plan, from);
  const names = base.map((patch) => path.basename(patch));
  const baseLabel = names.length === 0
    ? "纯净基线"
    : names.length === 1
    ? `纯净基线 + ${names[0]}`
    : `纯净基线 + ${names[0]} … ${names[names.length - 1]}`;

  const { diff, stat } = generateRemaining(plan, base);
  if (!diff) {
    console.error(
      chalk.gray(`${plan.dir}: 相对「${baseLabel}」没有剩余改动,不输出 patch`),
    );
    return;
  }

  console.error(chalk.gray(`${plan.dir}: 相对「${baseLabel}」的剩余改动:\n${stat}`));
  const crFiles = filesWithCarriageReturn(diff);
  if (crFiles.length) {
    console.error(
      chalk.yellow(
        `${plan.dir}: patch 含 \\r(${crFiles.join(", ")});上游文件本身是 CRLF 时属正常,` +
          "否则请检查子模块的 core.autocrlf / .gitattributes",
      ),
    );
  }

  if (target.kind === "stdout") {
    process.stdout.write(diff);
    return;
  }
  const file = target.kind === "file"
    ? target.file
    : path.join(target.dir, `${plan.dir}.patch`);
  fs.writeFileSync(file, diff);
  console.error(chalk.green(`${plan.dir}: 已写入 ${file}`));
}

function runGen(
  plans: RepoPlan[],
  single: boolean,
  options: CliOptions,
): void {
  let target: GenTarget;
  try {
    target = resolveGenTarget(single, options.out);
  } catch (error) {
    console.error(chalk.red(`✗ ${(error as Error).message}`));
    process.exitCode = 1;
    return;
  }

  // 批量生成只覆盖 patch-manager 接管的仓库;MANUAL_REPOS 需显式点名(--gen 只读,点名即可用)
  const selected = single ? plans : plans.filter((plan) => {
    if (!MANUAL_REPOS.has(plan.dir)) {
      return true;
    }
    console.error(
      chalk.gray(
        `${plan.dir}: 不由 patch-manager 接管,批量 --gen 跳过;需要时请单独 \`deno task patch ${plan.dir} --gen\``,
      ),
    );
    return false;
  });
  if (selected.length === 0) {
    console.error(chalk.gray("third-patches/ 下没有可处理的仓库"));
    return;
  }

  const failures: string[] = [];
  for (const plan of selected) {
    try {
      genRepo(plan, options.from, target);
    } catch (error) {
      const message = (error as Error).message;
      failures.push(message);
      console.error(chalk.red(`✗ ${message}`));
    }
  }

  if (!single) {
    const succeeded = selected.length - failures.length;
    const summary = `${succeeded}/${selected.length} repositories succeeded`;
    console.error(failures.length ? chalk.red(summary) : chalk.green(summary));
  }
  if (failures.length) {
    process.exitCode = 1;
  }
}

interface CliOptions {
  reverse: boolean;
  check: boolean;
  all: boolean;
  gen: boolean;
  from?: string;
  out?: string;
}

function assertModeOptions(options: CliOptions): void {
  if (options.gen && (options.reverse || options.check)) {
    throw new Error("--gen 不能与 -r / --check 同时使用");
  }
  if (!options.gen && (options.from !== undefined || options.out !== undefined)) {
    throw new Error("--from / --out 只能与 --gen 一起使用");
  }
}

export function main(argv = process.argv): void {
  const program = new Command();
  program
    .name("patch")
    .description(
      "套用或移除 third/ 子模块的 patch series（两个方向都先 reset 回纯净基线）；--gen 从工作树生成新 patch（不 reset）",
    )
    .argument("[third-dir]", "third/ 下的子目录名，例如 cef")
    .option("-r, --reverse", "移除 patch（reset 回纯净基线）", false)
    .option("--check", "仅在一次性 worktree 中预检", false)
    .option("--all", "处理 third-patches/ 下的全部仓库", false)
    .option(
      "--gen",
      "从工作树生成系列之外的剩余改动作为新 patch（不 reset，只读工作树）",
      false,
    )
    .option(
      "--from <patch>",
      "--gen 的基线：系列套用到该 patch 为止（文件名 / 去掉 .patch 的名字 / 4 位编号；none = 纯净基线），默认最后一个",
    )
    .option(
      "--out <path>",
      "--gen 的输出：单仓库为文件，多仓库为已存在的目录（各写 <dir>.patch）；省略则写 stdout",
    )
    .action((thirdDir: string | undefined, options: CliOptions) => {
      let plans: RepoPlan[];
      try {
        assertModeOptions(options);
        // --gen 只读,不点名时默认处理全部仓库;其余模式仍要求显式 [third-dir] 或 --all
        plans = discoverRepos(thirdDir, options.all || (options.gen && !thirdDir));
      } catch (error) {
        console.error(chalk.red(`✗ ${(error as Error).message}`));
        process.exitCode = 1;
        return;
      }
      if (options.gen) {
        runGen(plans, thirdDir !== undefined, options);
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
