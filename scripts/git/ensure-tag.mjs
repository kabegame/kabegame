import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { execFileSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function execGit(args, opts = {}) {
  return execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    ...opts,
  }).trim();
}

function tryExecGit(args, opts = {}) {
  try {
    return { ok: true, out: execGit(args, opts) };
  } catch (e) {
    const stderr = e?.stderr?.toString?.() ?? "";
    const stdout = e?.stdout?.toString?.() ?? "";
    return { ok: false, err: e, stdout, stderr };
  }
}

function repoRoot() {
  return execGit(["rev-parse", "--show-toplevel"]);
}

function readPackageVersion(root) {
  // 优先读取 package.json 的版本，如果没有则读取 Cargo.toml
  const pkgPath = path.join(root, "package.json");
  const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
  
  if (fs.existsSync(pkgPath)) {
    const content = fs.readFileSync(pkgPath, "utf8");
    const json = JSON.parse(content);
    const v = String(json.version || "").trim();
    if (v) return v;
  }
  
  if (fs.existsSync(cargoPath)) {
    const content = fs.readFileSync(cargoPath, "utf8");
    const match = content.match(/^version\s*=\s*["']([^"']+)["']/m);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  throw new Error(`Missing version in ${pkgPath} or ${cargoPath}`);
}

function toTag(version) {
  const v = String(version).trim();
  return v.startsWith("v") ? v : `v${v}`;
}

function tagExists(tag) {
  const res = tryExecGit(["tag", "-l", tag]);
  return res.ok && res.out === tag;
}

function main() {
  // 设计目标：
  // - push 前"尝试打 tag"，但任何失败都不阻断 push（exit 0）
  // - tag 来源：package.json 或 Cargo.toml 的 version -> vX.Y.Z
  try {
    const root = repoRoot();
    const version = readPackageVersion(root);
    const tag = toTag(version);

    if (tagExists(tag)) {
      process.stdout.write(`[pre-push] tag '${tag}' already exists, skip\n`);
      return;
    }

    // 创建一个注释 tag，便于在 GitHub Release 里展示
    const create = tryExecGit(["tag", "-a", tag, "-m", `Kabegame ${tag}`], { cwd: root });
    if (create.ok) {
      process.stdout.write(`[pre-push] created tag '${tag}'\n`);
      // 尝试推送 tag 到远程（不阻断 push，失败也不影响）
      const push = tryExecGit(["push", "origin", tag], { cwd: root });
      if (push.ok) {
        process.stdout.write(`[pre-push] pushed tag '${tag}' to remote\n`);
      } else {
        process.stderr.write(
          `[pre-push] warn: failed to push tag '${tag}' to remote (non-blocking)\n${push.stderr || push.stdout}\n`
        );
      }
    } else {
      // 常见：并发/已有 tag/仓库状态问题；不阻断 push
      process.stderr.write(
        `[pre-push] warn: failed to create tag '${tag}', skip (non-blocking)\n${create.stderr || create.stdout}\n`
      );
    }
  } catch (e) {
    process.stderr.write(`[pre-push] warn: ensure-tag failed, skip (non-blocking)\n${e?.message ?? e}\n`);
  }
}

main();

