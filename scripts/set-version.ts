#!/usr/bin/env node
/**
 * scripts/set-version.ts
 *
 * 用于统一管理项目版本号。
 *
 * 用法:
 *   1. 设置新版本并同步: bun run set-version 3.0.1
 *   2. 从 Cargo.toml 同步: bun run set-version --sync
 *
 * 会同步 README.md / README.zh-CN.md / README.ja.md / README.ko.md 中 GitHub Release 直链里的版本号。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import { readCargoTomlVersion } from "./utils";
import { ROOT } from "./utils";

interface PackageJson {
  version: string;
  [key: string]: any;
}

interface TauriConf {
  version: string;
  [key: string]: any;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function updateCargoTomlVersion(newVersion: string): void {
  const cargoTomlPath = path.join(ROOT, "Cargo.toml");
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  const workspacePackageRegex =
    /(\[workspace\.package\][^\[]*?version\s*=\s*")([^"]+)(")/s;

  if (!workspacePackageRegex.test(cargoToml)) {
    throw new Error("Could not find [workspace.package] version in Cargo.toml");
  }

  const updatedCargoToml = cargoToml.replace(
    workspacePackageRegex,
    `$1${newVersion}$3`,
  );
  fs.writeFileSync(cargoTomlPath, updatedCargoToml);
  console.log(`✓ Updated Cargo.toml to ${newVersion}`);
}

// 更新 packages/core/package.json
function updateCorePackageJson(newVersion: string): void {
  const corePkgPath = path.join(ROOT, "packages", "core", "package.json");
  if (!fs.existsSync(corePkgPath)) {
    return;
  }

  try {
    const pkg: PackageJson = JSON.parse(fs.readFileSync(corePkgPath, "utf8"));
    pkg.version = newVersion;
    fs.writeFileSync(corePkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(`✓ Updated packages/core/package.json to ${newVersion}`);
  } catch (e: any) {
    console.error(`✗ Error updating ${corePkgPath}:`, e.message);
  }
}

// 更新 Tauri 配置文件
function updateTauriConf(relPath: string, newVersion: string): void {
  const fullPath = path.join(ROOT, relPath);
  if (!fs.existsSync(fullPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(fullPath, "utf8");
    const newContent = content.replace(content.match(/"version": ".*?"/)![0], `"version": "${newVersion}"`);
    fs.writeFileSync(fullPath, newContent);
    console.log(`✓ Updated ${relPath} to ${newVersion}`);
  } catch (e: any) {
    console.error(`✗ Error updating ${relPath}:`, e.message);
  }
}

// 更新所有 Tauri 配置文件
function updateAllTauriConfs(newVersion: string): void {
  const tauriConfPaths = [
    "src-tauri/kabegame/tauri.conf.json.handlebars",
  ];

  tauriConfPaths.forEach((relPath) => {
    updateTauriConf(relPath, newVersion);
  });
}

// 更新 apps/kabegame/.env 中的 VITE_APP_VERSION（Vite 编译期注入前端版本号）
function updateMainEnvVersion(newVersion: string): void {
  const envPath = path.join(ROOT, "apps", "kabegame", ".env");
  const line = `VITE_APP_VERSION=${newVersion}`;
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  if (/^VITE_APP_VERSION=.*$/m.test(content)) {
    content = content.replace(/^VITE_APP_VERSION=.*$/m, line);
  } else {
    content = (content && !content.endsWith("\n") ? content + "\n" : content) + line + "\n";
  }
  fs.writeFileSync(envPath, content);
  console.log(`✓ Updated apps/kabegame/.env to ${newVersion}`);
}

const README_RELEASE_FILES = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ko.md",
] as const;

/** 仅处理含 kabegame 主仓库 release 下载 URL 的行，避免误改其它 semver */
function patchKabegameReleaseDownloadLine(
  line: string,
  oldVersion: string,
  newVersion: string,
): string {
  if (!line.includes("github.com/kabegame/kabegame/releases/download")) {
    return line;
  }
  let s = line.replaceAll(`v${oldVersion}/`, `v${newVersion}/`);
  s = s.replaceAll(`_${oldVersion}_`, `_${newVersion}_`);
  s = s.replaceAll(
    `Kabegame_${oldVersion}_android`,
    `Kabegame_${newVersion}_android`,
  );
  return s;
}

function updateReadmeKabegameReleaseLinks(
  oldVersion: string,
  newVersion: string,
): void {
  if (oldVersion === newVersion) {
    return;
  }
  for (const rel of README_RELEASE_FILES) {
    const fullPath = path.join(ROOT, rel);
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    const content = fs.readFileSync(fullPath, "utf8");
    const next = content
      .split("\n")
      .map((line) =>
        patchKabegameReleaseDownloadLine(line, oldVersion, newVersion),
      )
      .join("\n");
    if (next !== content) {
      fs.writeFileSync(fullPath, next);
      console.log(`✓ Updated ${rel} release download links to v${newVersion}`);
    }
  }
}

/** 从 README.md 解析当前发布链接中的版本（与 Cargo 比对用于 sync） */
function readReadmeKabegameReleaseVersion(): string | null {
  const readmePath = path.join(ROOT, "README.md");
  if (!fs.existsSync(readmePath)) {
    return null;
  }
  const content = fs.readFileSync(readmePath, "utf8");
  const m = content.match(
    /github\.com\/kabegame\/kabegame\/releases\/download\/v(\d+\.\d+\.\d+)\//,
  );
  return m?.[1] ?? null;
}

// 验证版本号格式
function validateVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+/.test(version);
}

// 主函数：设置版本
function setVersion(newVersion: string): void {
  console.log(`Setting version to ${newVersion}...`);

  if (!validateVersion(newVersion)) {
    console.error("✗ Error: Version must be in format x.y.z");
    process.exit(1);
  }

  try {
    const previousVersion = readCargoTomlVersion();
    updateCargoTomlVersion(newVersion);
    updateCorePackageJson(newVersion);
    updateAllTauriConfs(newVersion);
    updateMainEnvVersion(newVersion);
    updateReadmeKabegameReleaseLinks(previousVersion, newVersion);
    console.log(`\n🎉 Version successfully set to ${newVersion}!`);
  } catch (error) {
    console.error("✗ Error:", (error as Error).message);
    process.exit(1);
  }
}

// 主函数：从 Cargo.toml 同步版本
function syncVersion(): void {
  console.log("Syncing version from Cargo.toml...");

  try {
    const version = readCargoTomlVersion();
    console.log(`Found version ${version} in Cargo.toml`);

    updateCorePackageJson(version);
    updateAllTauriConfs(version);
    updateMainEnvVersion(version);
    const readmeReleaseVer = readReadmeKabegameReleaseVersion();
    if (readmeReleaseVer) {
      updateReadmeKabegameReleaseLinks(readmeReleaseVer, version);
    }
    console.log(`\n🎉 Version successfully synced to ${version}!`);
  } catch (error) {
    console.error("✗ Error:", (error as Error).message);
    process.exit(1);
  }
}

// 创建 Commander 程序
const program = new Command();

program.name("set-version").description("统一管理项目版本号").version("1.0.0");

program
  .command("set <version>")
  .description("设置新版本并同步到所有配置文件")
  .action((version: string) => {
    setVersion(version);
  });

program
  .command("sync")
  .description("从 Cargo.toml 同步版本到其他配置文件")
  .action(() => {
    syncVersion();
  });

// 如果没有提供子命令，则默认为 set 命令（向后兼容）
program
  .argument("[version]", "要设置的版本号（格式：x.y.z）")
  .action((version: string) => {
    if (version) {
      setVersion(version);
    } else {
      syncVersion();
    }
  });

// 解析命令行参数
program.parse();
