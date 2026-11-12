/**
 * 构建 wpefont（场景壁纸的字体引擎：FreeType 2.14.3 + HarfBuzz 15.0.0 + C 胶水 src-tauri/wpefont/wpefont.c）的 wasm：
 *
 *   deno task build:wpefont
 *
 * 产物 bin/wasm/wpefont/wpefont.wasm（git 忽略，与平台无关）。kabegame 的 dev / start / build / check / test
 * 不带 `--skip vue` 时，由 WpefontPlugin 拷进 apps/wpe-scene/src/wpefont/；缺产物只告警，文本对象退回预览图。
 *
 * 需要：
 * - 子模块 third/freetype（VER-2-14-3）与 third/harfbuzz（15.0.0），缺失时报错并给出 git submodule 命令；
 * - 带 wasm32 目标的 clang（同目录要有 wasm-ld）：环境变量 WPEFONT_CLANG → PATH 上的 clang → macOS 上 Homebrew 的
 *   LLVM（Apple clang 没有 wasm 后端）。用 `--print-targets` 确认有 wasm32；
 * - wasi-sdk 34 的 wasi-sysroot 与 libclang_rt：首次运行下载到 bin/wasm/wpefont/toolchain/ 并解压（按 SHA-256 校验，
 *   已有且摘要对就不下载；网络不稳时可以手动把压缩包放进去）。
 *
 * 编译参数照 P6b 1a 选型探针（和 WPE 图集逐字节一致的那一版）：-O2，不加任何会改变数值结果的开关（-ffast-math 之类）；
 * setjmp / longjmp 走 wasm 异常处理（光栅化器的池溢出要用），链接 libsetjmp。FreeType 2.14 起光栅化器在 wasm32 上
 * 也用 DDA 展平曲线，不再需要 1a 给 2.13 打的那处补丁。
 *
 * 不用 scripts/utils.ts 的 run：它在 Windows 上走 shell，`-DFT_CONFIG_MODULES_H="ftmodule.h"` 与带空格的
 * clang 路径会被 cmd.exe 拆坏；这里一律参数数组、不经 shell。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fetchPinned } from "./download.ts";
import {
  ROOT,
  THIRD_DIR,
  WPEFONT_TOOLCHAIN_DIR,
  WPEFONT_WASM,
} from "./paths.ts";

const FREETYPE_DIR = path.join(THIRD_DIR, "freetype");
const HARFBUZZ_DIR = path.join(THIRD_DIR, "harfbuzz");
const GLUE_DIR = path.join(ROOT, "src-tauri", "wpefont");
const OBJ_DIR = path.join(path.dirname(WPEFONT_WASM), "obj");

/** 子模块应有的版本（README 与对照结论都基于它们）。升级时连同 third-patches/{freetype,harfbuzz}/README.md 一起改。 */
const FREETYPE_VERSION = "2.14.3";
const HARFBUZZ_VERSION = "15.0.0";

const WASI_SDK_RELEASE =
  "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34";
/** 压缩包里的顶层目录名就是 name。 */
const TOOLCHAIN = [
  {
    name: "wasi-sysroot-34.0",
    sha256: "9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be",
  },
  {
    name: "libclang_rt-34.0",
    sha256: "eee3e634dcf71aa22b1333391623cf5c9965a637dc428a27b1a858c026c587f1",
  },
] as const;

/** FreeType 编译单元：模块表见 src-tauri/wpefont/ftmodule.h，两边一起改。 */
const FT_UNITS = [
  "src/base/ftsystem.c",
  "src/base/ftdebug.c",
  "src/base/ftinit.c",
  "src/base/ftbase.c",
  "src/base/ftbbox.c",
  "src/base/ftbitmap.c",
  "src/base/ftglyph.c",
  "src/base/ftmm.c",
  "src/base/ftsynth.c",
  "src/base/ftfstype.c",
  "src/base/ftgasp.c",
  "src/base/ftstroke.c",
  "src/autofit/autofit.c",
  "src/truetype/truetype.c",
  "src/cff/cff.c",
  "src/psaux/psaux.c",
  "src/psnames/psnames.c",
  "src/pshinter/pshinter.c",
  "src/sfnt/sfnt.c",
  "src/smooth/smooth.c",
  "src/gzip/ftgzip.c",
];

/** C 胶水导出的函数（同时用 export_name 属性与 --export，接口见 src-tauri/wpefont/README.md）。 */
const EXPORTS = [
  "wpefont_alloc",
  "wpefont_free",
  "wpefont_font_new",
  "wpefont_font_free",
  "wpefont_font_has",
  "wpefont_font_metrics",
  "wpefont_shape",
  "wpefont_glyph",
  "wpefont_glyph_box",
];

// setjmp / longjmp 走 wasm 异常处理（exnref），链接 libsetjmp（wasi-libc 的做法）
const SJLJ = [
  "-mllvm",
  "-wasm-enable-sjlj",
  "-mllvm",
  "-wasm-use-legacy-eh=false",
];
const COMMON = ["-O2", "-g0", "-fvisibility=hidden"];
const FT_DEFS = ["-DFT2_BUILD_LIBRARY", '-DFT_CONFIG_MODULES_H="ftmodule.h"'];
const HB_DEFS = [
  "-DHAVE_FREETYPE=1",
  "-DHB_NO_MT",
  "-DHAVE_FT_GET_VAR_BLEND_COORDINATES=1",
  "-DHAVE_FT_SET_VAR_BLEND_COORDINATES=1",
  "-DHAVE_FT_DONE_MM_VAR=1",
  "-DHAVE_FT_GET_TRANSFORM=1",
];

function log(message: string): void {
  console.log(`[build:wpefont] ${message}`);
}

function die(message: string): never {
  console.error(`[build:wpefont] ${message}`);
  process.exit(1);
}

function ensureSource(file: string, submodule: string): void {
  if (!fs.existsSync(file)) {
    die(
      `源码未找到: ${file}\n请执行: git submodule update --init ${submodule}`,
    );
  }
}

function freetypeVersion(): string {
  const header = fs.readFileSync(
    path.join(FREETYPE_DIR, "include", "freetype", "freetype.h"),
    "utf8",
  );
  const pick = (name: string) =>
    new RegExp(`#define\\s+FREETYPE_${name}\\s+(\\d+)`).exec(header)?.[1] ??
      "?";
  return `${pick("MAJOR")}.${pick("MINOR")}.${pick("PATCH")}`;
}

function harfbuzzVersion(): string {
  const header = fs.readFileSync(
    path.join(HARFBUZZ_DIR, "src", "hb-version.h"),
    "utf8",
  );
  return /#define\s+HB_VERSION_STRING\s+"([^"]+)"/.exec(header)?.[1] ?? "?";
}

function checkSources(): void {
  ensureSource(
    path.join(FREETYPE_DIR, "include", "ft2build.h"),
    "third/freetype",
  );
  ensureSource(path.join(HARFBUZZ_DIR, "src", "harfbuzz.cc"), "third/harfbuzz");
  const ft = freetypeVersion();
  const hb = harfbuzzVersion();
  if (ft !== FREETYPE_VERSION || hb !== HARFBUZZ_VERSION) {
    die(
      `子模块版本不对：FreeType ${ft}（应为 ${FREETYPE_VERSION}）、HarfBuzz ${hb}（应为 ${HARFBUZZ_VERSION}）。\n` +
        "先运行 git submodule update --init third/freetype third/harfbuzz；有意升级时改本脚本与 third-patches 的 README。",
    );
  }
  log(`FreeType ${ft}、HarfBuzz ${hb}`);
}

/** Windows 优先用系统自带的 bsdtar：Git Bash 的 GNU tar 会把 `C:` 当成远程主机。 */
function tarCommand(): string {
  if (process.platform === "win32") {
    const system = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "tar.exe",
    );
    if (fs.existsSync(system)) return system;
  }
  return "tar";
}

/** 下载（或复用缓存的）压缩包并解压到 toolchain/<name>；解压过同一摘要的就跳过。返回解压目录。 */
async function prepareToolchain(
  name: string,
  sha256: string,
): Promise<string> {
  const archive = path.join(WPEFONT_TOOLCHAIN_DIR, `${name}.tar.gz`);
  await fetchPinned(`${WASI_SDK_RELEASE}/${name}.tar.gz`, sha256, archive, {
    log,
  });

  const dir = path.join(WPEFONT_TOOLCHAIN_DIR, name);
  const stamp = path.join(dir, ".kabegame-sha256");
  if (
    fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === sha256
  ) {
    return dir;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  // 先解到临时目录，完整解出后再改名，中途失败不会留下半套工具链
  const staging = path.join(WPEFONT_TOOLCHAIN_DIR, `.extract-${name}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  log(`解压 ${path.basename(archive)}`);
  // 相对路径 + cwd，参数里不出现盘符
  const relative = path.relative(staging, archive).split(path.sep).join("/");
  const res = spawnSync(tarCommand(), ["-xzf", relative], {
    cwd: staging,
    stdio: "inherit",
  });
  if (res.error || res.status !== 0) {
    die(`解压 ${archive} 失败：${res.error ?? `退出码 ${res.status}`}`);
  }
  const inner = path.join(staging, name);
  if (!fs.existsSync(inner)) die(`${archive} 里没有顶层目录 ${name}`);
  fs.renameSync(inner, dir);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.writeFileSync(stamp, `${sha256}\n`);
  return dir;
}

function clangCandidates(): { path: string; source: string }[] {
  const explicit = process.env.WPEFONT_CLANG;
  if (explicit) return [{ path: explicit, source: "WPEFONT_CLANG" }];
  const list = [{ path: "clang", source: "PATH" }];
  if (process.platform === "darwin") {
    for (
      const p of [
        "/opt/homebrew/opt/llvm/bin/clang",
        "/usr/local/opt/llvm/bin/clang",
      ]
    ) {
      list.push({ path: p, source: "Homebrew LLVM" });
    }
  }
  return list;
}

function findClang(): string {
  const tried: string[] = [];
  for (const candidate of clangCandidates()) {
    const res = spawnSync(candidate.path, ["--print-targets"], {
      encoding: "utf8",
    });
    if (res.error || res.status !== 0) {
      tried.push(`${candidate.path}（${candidate.source}）：无法运行`);
      continue;
    }
    if (!/^\s*wasm32\s/m.test(res.stdout)) {
      tried.push(`${candidate.path}（${candidate.source}）：没有 wasm32 目标`);
      continue;
    }
    const version = spawnSync(candidate.path, ["--version"], {
      encoding: "utf8",
    }).stdout?.split(/\r?\n/)[0];
    log(`clang：${candidate.path}（${candidate.source}，${version}）`);
    return candidate.path;
  }
  die(
    [
      "找不到带 wasm32 目标的 clang：",
      ...tried.map((line) => `  - ${line}`),
      "设环境变量 WPEFONT_CLANG 指向 clang 可执行文件，或安装 LLVM 并把它的 bin 加进 PATH：",
      "  Windows：winget install LLVM.LLVM（或 https://github.com/llvm/llvm-project/releases）",
      "  macOS：brew install llvm lld（Apple clang 没有 wasm 后端）",
      "  Linux：发行版的 clang 与 lld",
    ].join("\n"),
  );
}

interface Job {
  label: string;
  args: string[];
}

function spawnCollect(
  command: string,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (data) => (output += data));
    child.stderr?.on("data", (data) => (output += data));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** 并行跑编译；任何一个失败就打印命令与输出并退出。 */
async function runJobs(clang: string, jobs: Job[]): Promise<void> {
  const parallel = Math.max(
    1,
    Math.min(
      jobs.length,
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length,
    ),
  );
  log(`编译 ${jobs.length} 个单元（并行 ${parallel}）`);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < jobs.length) {
      const job = jobs[next++];
      const result = await spawnCollect(clang, job.args);
      if (result.code !== 0) {
        failed = true;
        die(
          `编译 ${job.label} 失败：\n${clang} ${
            job.args.join(" ")
          }\n${result.output}`,
        );
      }
      log(`  ${job.label}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

async function main(): Promise<void> {
  checkSources();
  const [sysroot, clangRt] = [
    await prepareToolchain(TOOLCHAIN[0].name, TOOLCHAIN[0].sha256),
    await prepareToolchain(TOOLCHAIN[1].name, TOOLCHAIN[1].sha256),
  ];
  const builtins = path.join(
    clangRt,
    "wasm32-unknown-wasip1",
    "libclang_rt.builtins.a",
  );
  if (!fs.existsSync(builtins)) die(`没有找到 ${builtins}`);
  const clang = findClang();

  fs.rmSync(OBJ_DIR, { recursive: true, force: true });
  fs.mkdirSync(OBJ_DIR, { recursive: true });

  const target = ["--target=wasm32-wasip1", `--sysroot=${sysroot}`];
  const ftInclude = path.join(FREETYPE_DIR, "include");
  const hbSrc = path.join(HARFBUZZ_DIR, "src");
  // libc++ 头文件（不带异常的那套）：wasi-sysroot 34 放在 include/wasm32-wasip1/noeh/c++/v1，clang 不会自己找
  const libcxxInclude = path.join(
    sysroot,
    "include",
    "wasm32-wasip1",
    "noeh",
    "c++",
    "v1",
  );

  // 链接顺序同 1a：FreeType、HarfBuzz、胶水
  const objects: string[] = [];
  const ftJobs: Job[] = [];
  for (const unit of FT_UNITS) {
    const object = path.join(OBJ_DIR, `ft_${path.basename(unit, ".c")}.o`);
    objects.push(object);
    ftJobs.push({
      label: `freetype/${unit}`,
      args: [
        ...target,
        ...COMMON,
        ...SJLJ,
        ...FT_DEFS,
        // ftmodule.h 在胶水目录，必须排在 FreeType 的 include 之前
        "-I",
        GLUE_DIR,
        "-I",
        ftInclude,
        "-c",
        path.join(FREETYPE_DIR, unit),
        "-o",
        object,
      ],
    });
  }
  const hbObject = path.join(OBJ_DIR, "harfbuzz.o");
  objects.push(hbObject);
  const hbJob: Job = {
    label: "harfbuzz/src/harfbuzz.cc",
    args: [
      "--driver-mode=g++",
      ...target,
      ...COMMON,
      ...SJLJ,
      "-nostdinc++",
      "-isystem",
      libcxxInclude,
      "-std=c++17",
      "-fno-exceptions",
      "-fno-rtti",
      "-fno-threadsafe-statics",
      ...HB_DEFS,
      "-I",
      ftInclude,
      "-I",
      hbSrc,
      "-c",
      path.join(hbSrc, "harfbuzz.cc"),
      "-o",
      hbObject,
    ],
  };
  const glueObject = path.join(OBJ_DIR, "wpefont.o");
  objects.push(glueObject);
  const glueJob: Job = {
    label: "src-tauri/wpefont/wpefont.c",
    args: [
      ...target,
      ...COMMON,
      ...SJLJ,
      "-I",
      ftInclude,
      "-I",
      hbSrc,
      "-c",
      path.join(GLUE_DIR, "wpefont.c"),
      "-o",
      glueObject,
    ],
  };
  // HarfBuzz 单元最慢，最先开始
  await runJobs(clang, [hbJob, ...ftJobs, glueJob]);

  const linked = path.join(OBJ_DIR, "wpefont.wasm");
  const linkArgs = [
    "--driver-mode=g++",
    ...target,
    "-O2",
    "-mexec-model=reactor",
    "-nodefaultlibs",
    ...objects,
    "-L",
    path.join(sysroot, "lib", "wasm32-wasip1", "noeh"),
    "-lc++",
    "-lsetjmp",
    "-lc",
    builtins,
    "-Wl,--gc-sections",
    "-Wl,--strip-debug",
    "-Wl,-z,stack-size=1048576",
    ...EXPORTS.map((name) => `-Wl,--export=${name}`),
    "-o",
    linked,
  ];
  log("链接");
  const res = spawnSync(clang, linkArgs, { cwd: ROOT, stdio: "inherit" });
  if (res.error || res.status !== 0) {
    die(`链接失败：\n${clang} ${linkArgs.join(" ")}`);
  }

  // 核对导出，列出 WASI 导入（宿主的桩要覆盖到，见 apps/wpe-scene/src/wpefont/index.ts）
  const module = await WebAssembly.compile(fs.readFileSync(linked));
  const exported = new Set(
    WebAssembly.Module.exports(module).map((entry) => entry.name),
  );
  const missing = [...EXPORTS, "memory", "_initialize"].filter((name) =>
    !exported.has(name)
  );
  if (missing.length) die(`产物缺少导出：${missing.join(" ")}`);
  const imports = WebAssembly.Module.imports(module).map((entry) =>
    `${entry.module}.${entry.name}`
  );
  log(`导入：${imports.join(" ")}`);

  fs.mkdirSync(path.dirname(WPEFONT_WASM), { recursive: true });
  fs.copyFileSync(linked, WPEFONT_WASM);
  const kib = (fs.statSync(WPEFONT_WASM).size / 1024).toFixed(0);
  log(`产物 ${path.relative(ROOT, WPEFONT_WASM)}（${kib} KiB）`);
}

main().catch((error) =>
  die(error instanceof Error ? error.stack ?? error.message : String(error))
);
