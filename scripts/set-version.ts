#!/usr/bin/env node
/**
 * scripts/set-version.ts
 *
 * 用于统一管理项目版本号。
 *
 * 用法:
 *   1. 设置新版本并同步: bun run set-version 3.0.1
 *   2. 从 Cargo.toml 同步: bun run set-version --sync
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
    "src-tauri/app-main/tauri.conf.json.handlebars",
    "src-tauri/app-cli/tauri.conf.json.handlebars",
    "src-tauri/app-plugin-editor/tauri.conf.json.handlebars",
  ];

  tauriConfPaths.forEach((relPath) => {
    updateTauriConf(relPath, newVersion);
  });
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
    updateCargoTomlVersion(newVersion);
    updateCorePackageJson(newVersion);
    updateAllTauriConfs(newVersion);
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
