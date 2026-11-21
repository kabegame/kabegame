/**
 * 构建插件模式（Linux / KDE Plasma 6）的 Plasma 壁纸插件 `src-plasma-wallpaper-plugin/`：
 *
 *   deno task build:plasma-plugin
 *
 * 产物是一个 KPackage 目录 bin/linux/<arch>/plasma-wallpaper-plugin-build/package/org.kabegame.wallpaper（git 忽略，
 * 在架构子目录里，OSPlugin 清平台暂存目录时不会删掉它）。kabegame 的 dev / build 由 PlasmaWallpaperPlugin 拷进应用的
 * resources/plasma-wallpaper/，应用在切到插件模式时按修订号装进用户目录（`wallpaper/manager/plasma_install.rs`）。
 *
 * - 修订号取 `src-plasma-wallpaper-plugin/REVISION`，约定版本取同目录的 `PROTOCOL`。QML 模块 URI、`.so` 名与内容文件名
 *   都带修订号（`KabegameWallpaperR<修订号>`）：plasmashell 不重启时只有换名字才能加载新版本。改了插件就要加修订号。
 * - 需要 cmake（有 ninja 就用）、Qt 6.6 以上的 Quick / Qml 开发包、libpipewire-0.3 开发包。
 * - 用户的 Qt 不能比构建时用的 Qt 旧（moc 生成的代码按构建时的版本要符号）。出货要在 Qt 6.6 的环境里构建，本机构建只适合
 *   开发；构建时会打印用到的 Qt 版本。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  PLASMA_WALLPAPER_BUILD_DIR,
  PLASMA_WALLPAPER_PACKAGE,
  PLASMA_WALLPAPER_SOURCE_DIR,
  ROOT,
} from "./paths.ts";

function fail(message: string): never {
  console.error(`[build-plasma-plugin] ${message}`);
  process.exit(1);
}

function log(message: string): void {
  console.log(`[build-plasma-plugin] ${message}`);
}

function readInteger(file: string): number {
  const text = fs.readFileSync(path.join(PLASMA_WALLPAPER_SOURCE_DIR, file), "utf8").trim();
  if (!/^[0-9]+$/.test(text) || Number(text) < 1) fail(`${file} 应是正整数，读到 "${text}"`);
  return Number(text);
}

function has(command: string): boolean {
  return spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
}

function run(command: string, args: string[]): void {
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) fail(`${command} 失败（退出码 ${result.status}）`);
}

/** 把 `@KEY@` 换成值，读 `from` 写 `to`。 */
function render(from: string, to: string, values: Record<string, string>): void {
  let text = fs.readFileSync(from, "utf8");
  for (const [key, value] of Object.entries(values)) text = text.split(`@${key}@`).join(value);
  const left = text.match(/@KB_[A-Z_]+@/);
  if (left) fail(`${path.relative(ROOT, from)} 里还有没替换的 ${left[0]}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text);
}

/** CMakeCache 里的 Qt 版本（打印给构建者看兼容下限）。 */
function qtVersion(cmakeDir: string): string {
  const cache = fs.readFileSync(path.join(cmakeDir, "CMakeCache.txt"), "utf8");
  const dir = cache.match(/^Qt6_DIR:PATH=(.*)$/m)?.[1];
  if (!dir) return "未知";
  const config = path.join(dir, "Qt6ConfigVersionImpl.cmake");
  const text = fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
  return text.match(/set\(PACKAGE_VERSION "([^"]+)"\)/)?.[1] ?? "未知";
}

function main(): void {
  if (process.platform !== "linux") fail("Plasma 壁纸插件只在 Linux 上构建");
  if (!has("cmake")) fail("找不到 cmake");
  const revision = readInteger("REVISION");
  const protocol = readInteger("PROTOCOL");
  const uri = `KabegameWallpaperR${revision}`;
  const cmakeDir = path.join(PLASMA_WALLPAPER_BUILD_DIR, `cmake-r${revision}`);

  run("cmake", [
    "-S",
    PLASMA_WALLPAPER_SOURCE_DIR,
    "-B",
    cmakeDir,
    ...(has("ninja") ? ["-G", "Ninja"] : []),
    "-DCMAKE_BUILD_TYPE=Release",
    `-DKB_PLUGIN_REVISION=${revision}`,
    `-DKB_STREAM_PROTOCOL=${protocol}`,
  ]);
  run("cmake", ["--build", cmakeDir]);

  // 拼 KPackage：先在旁边拼好再换上，失败不留半个包
  const staging = `${PLASMA_WALLPAPER_PACKAGE}.staging`;
  fs.rmSync(staging, { recursive: true, force: true });
  const packageSrc = path.join(PLASMA_WALLPAPER_SOURCE_DIR, "package");
  const values = {
    KB_QML_URI: uri,
    KB_PLUGIN_REVISION: String(revision),
    KB_STREAM_PROTOCOL: String(protocol),
  };
  render(path.join(packageSrc, "metadata.json.in"), path.join(staging, "metadata.json"), values);
  render(
    path.join(packageSrc, "contents", "config", "main.xml.in"),
    path.join(staging, "contents", "config", "main.xml"),
    values,
  );
  const ui = path.join(staging, "contents", "ui");
  fs.mkdirSync(ui, { recursive: true });
  fs.copyFileSync(path.join(packageSrc, "contents", "ui", "main.qml"), path.join(ui, "main.qml"));
  // 带修订号的内容文件（Entry 指它），另存一份固定名的 content.qml 给壳在 Entry 失效时退回
  render(path.join(packageSrc, "contents", "ui", "content.qml.in"), path.join(ui, `${uri}.qml`), values);
  fs.copyFileSync(path.join(ui, `${uri}.qml`), path.join(ui, "content.qml"));
  const moduleOut = path.join(cmakeDir, uri);
  const moduleDir = path.join(ui, "Plugin", uri);
  fs.mkdirSync(moduleDir, { recursive: true });
  const moduleFiles = fs.readdirSync(moduleOut).filter((name) =>
    name === "qmldir" || name.endsWith(".qmltypes") || name.endsWith(".so")
  );
  if (!moduleFiles.some((name) => name.endsWith(".so"))) fail(`${path.relative(ROOT, moduleOut)} 里没有 .so`);
  for (const name of moduleFiles) fs.copyFileSync(path.join(moduleOut, name), path.join(moduleDir, name));

  fs.rmSync(PLASMA_WALLPAPER_PACKAGE, { recursive: true, force: true });
  fs.renameSync(staging, PLASMA_WALLPAPER_PACKAGE);
  log(`修订 ${revision}（URI ${uri}，约定版本 ${protocol}）→ ${path.relative(ROOT, PLASMA_WALLPAPER_PACKAGE)}`);
  log(`用的 Qt ${qtVersion(cmakeDir)}：用户的 Qt 不能比它旧，出货要在 Qt 6.6 的环境里构建`);
}

main();
