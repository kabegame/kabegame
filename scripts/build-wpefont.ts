/**
 * 构建 wpefont（场景壁纸的字体引擎：FreeType 2.14.3 + HarfBuzz 15.0.0 + msdfgen v1.13 + 胶水
 * src-tauri/wpefont/wpefont.c、msdf.cpp）的 wasm：
 *
 *   deno task build:wpefont [--if-stale]
 *
 * 产物 bin/wasm/wpefont/wpefont.wasm（git 忽略，与平台无关），旁边的 wpefont.wasm.inputs.json 记录构建时的输入指纹
 * （本脚本、src-tauri/wpefont/ 的源文件、三个子模块的提交与本地改动）。`--if-stale` 时指纹没变就直接退出，不碰工具链；
 * 场景宿主（apps/wpe-scene）的 vite build 与 vitest 开始前都这样调一次（`apps/wpe-scene/wasmDeps.ts`），再把产物拷进
 * apps/wpe-scene/src/wpefont/，所以改了胶水、编译参数或子模块后不用记得手动重建。
 *
 * 需要：
 * - 子模块 third/freetype（VER-2-14-3）、third/harfbuzz（15.0.0）与 third/msdfgen（v1.13），缺失时报错并给出
 *   git submodule 命令；
 * - 带 wasm32 目标的 clang 与它调得起的 wasm-ld：环境变量 WPEFONT_CLANG → PATH 上的 clang → macOS 上 Homebrew 的
 *   LLVM（Apple clang 没有 wasm 后端）。用 `--print-targets` 确认有 wasm32，编译前用 `-Wl,--version` 预检链接器
 *   （Ubuntu 的 clang-N 找的是 `wasm-ld-N`，要装 lld-N）；
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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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
const MSDFGEN_DIR = path.join(THIRD_DIR, "msdfgen");
const GLUE_DIR = path.join(ROOT, "src-tauri", "wpefont");
const OBJ_DIR = path.join(path.dirname(WPEFONT_WASM), "obj");
/** 产物的输入指纹（`--if-stale` 比较用），构建成功后与产物一起写。 */
const INPUTS_STAMP = `${WPEFONT_WASM}.inputs.json`;

/** 子模块应有的版本（README 与对照结论都基于它们）。升级时连同 third-patches/{freetype,harfbuzz}/README.md 一起改。 */
const FREETYPE_VERSION = "2.14.3";
const HARFBUZZ_VERSION = "15.0.0";
/** msdfgen 要 v1.13（不能是 v1.13.1：它改了 symmetricalTrichotomy，和 WPE 不同，见 rea-p6f-msdf 第 1 节）。 */
const MSDFGEN_VERSION = "1.13.0";
/** msdfgen core/ 里不编的单元：文件输出、SVG 导出、形状描述文本（不进 wasm，也不依赖 libpng / tinyxml）。 */
const MSDFGEN_SKIP = new Set([
  "save-bmp.cpp",
  "save-tiff.cpp",
  "save-rgba.cpp",
  "save-fl32.cpp",
  "export-svg.cpp",
  "shape-description.cpp",
]);

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
  "wpefont_msdf",
];

// setjmp / longjmp 走 wasm 异常处理（exnref），链接 libsetjmp（wasi-libc 的做法）
const SJLJ = [
  "-mllvm",
  "-wasm-enable-sjlj",
  "-mllvm",
  "-wasm-use-legacy-eh=false",
];
const COMMON = ["-O2", "-g0", "-fvisibility=hidden"];
// FT_CONFIG_OPTION_USE_HARFBUZZ：自动 hinter 经 HarfBuzz 顺着 GSUB 给只能经替换到达的字形归类（cmap 里没有的上下文替换字形等），
// WPE 链的 FreeType 是这样编的（P6f 走查：LXGW 文楷的抬高冒号 gid 20066，不开时 hinted 框宽 1 像素）。HarfBuzz 头在 hbSrc
const FT_DEFS = ["-DFT2_BUILD_LIBRARY", '-DFT_CONFIG_MODULES_H="ftmodule.h"', "-DFT_CONFIG_OPTION_USE_HARFBUZZ"];
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

/** msdfgen 的版本：读 vcpkg.json（上游每次发版都改），不依赖 git 状态。 */
function msdfgenVersion(): string {
  const file = path.join(MSDFGEN_DIR, "vcpkg.json");
  if (!fs.existsSync(file)) return "?";
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string })
    .version ?? "?";
}

function checkSources(): void {
  ensureSource(
    path.join(FREETYPE_DIR, "include", "ft2build.h"),
    "third/freetype",
  );
  ensureSource(path.join(HARFBUZZ_DIR, "src", "harfbuzz.cc"), "third/harfbuzz");
  ensureSource(path.join(MSDFGEN_DIR, "msdfgen.h"), "third/msdfgen");
  const ft = freetypeVersion();
  const hb = harfbuzzVersion();
  const msdf = msdfgenVersion();
  if (
    ft !== FREETYPE_VERSION || hb !== HARFBUZZ_VERSION ||
    msdf !== MSDFGEN_VERSION
  ) {
    die(
      `子模块版本不对：FreeType ${ft}（应为 ${FREETYPE_VERSION}）、HarfBuzz ${hb}（应为 ${HARFBUZZ_VERSION}）、` +
        `msdfgen ${msdf}（应为 ${MSDFGEN_VERSION}，即 tag v1.13）。\n` +
        "先运行 git submodule update --init third/freetype third/harfbuzz third/msdfgen；有意升级时改本脚本与 third-patches 的 README。",
    );
  }
  log(`FreeType ${ft}、HarfBuzz ${hb}、msdfgen ${msdf}`);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 子模块的检出状态：HEAD 提交，有本地改动时再带上 `git diff HEAD` 的摘要；没初始化返回 `missing`。 */
function submoduleState(dir: string): string {
  // 没初始化的子模块只是个空目录，`git -C` 会一路找到外层仓库，所以先认 `.git`
  if (!fs.existsSync(path.join(dir, ".git"))) return "missing";
  const git = (args: string[]) => {
    const res = spawnSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    if (res.error || res.status !== 0) {
      return `error:${String(res.error ?? res.stderr).trim()}`;
    }
    return res.stdout.trim();
  };
  const head = git(["rev-parse", "HEAD"]);
  const diff = git(["diff", "--no-ext-diff", "HEAD"]);
  return diff ? `${head}+${sha256(diff)}` : head;
}

/**
 * 决定产物内容的输入，各取一个摘要：本脚本（编译参数、单元表、导出表、工具链摘要都写在这里）、胶水目录的源文件、
 * 三个子模块的检出状态。不含 clang 版本：同一份源码换编译器不算「过旧」。
 */
function currentInputs(): Record<string, string> {
  const inputs: Record<string, string> = {
    "scripts/build-wpefont.ts": sha256(
      fs.readFileSync(fileURLToPath(import.meta.url)),
    ),
  };
  for (const name of fs.readdirSync(GLUE_DIR).sort()) {
    const file = path.join(GLUE_DIR, name);
    if (name === "README.md" || !fs.statSync(file).isFile()) continue;
    inputs[`src-tauri/wpefont/${name}`] = sha256(fs.readFileSync(file));
  }
  inputs["third/freetype"] = submoduleState(FREETYPE_DIR);
  inputs["third/harfbuzz"] = submoduleState(HARFBUZZ_DIR);
  inputs["third/msdfgen"] = submoduleState(MSDFGEN_DIR);
  return inputs;
}

/** 产物为什么要重建；是最新的返回 null。 */
function staleReason(inputs: Record<string, string>): string | null {
  if (!fs.existsSync(WPEFONT_WASM)) return "还没有产物";
  let recorded: Record<string, string>;
  try {
    recorded = JSON.parse(fs.readFileSync(INPUTS_STAMP, "utf8"));
  } catch {
    return "产物没有输入记录（旧版脚本构建的）";
  }
  const changed = [...new Set([...Object.keys(inputs), ...Object.keys(recorded)])]
    .filter((key) => inputs[key] !== recorded[key]);
  return changed.length ? `输入变了：${changed.join("、")}` : null;
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

/**
 * 确认 clang 调得起 wasm 链接器：带 `-Wl,--version` 真跑一次 wasm-ld（`--version` 打印后即退出、不写输出文件）。
 * 链接器缺失时 clang 只在最后链接那一步报 `posix_spawn failed` / `Executable ... doesn't exist`，要等全部单元编完才暴露，
 * 这里提前拦下，并说出它找的是哪个可执行文件——发行版的 clang 可能找带版本号的名字（Ubuntu 的 clang-21 找 `wasm-ld-21`），
 * 不一定是同目录的 `wasm-ld`。
 */
function checkLinker(clang: string): void {
  const probe = ["--target=wasm32-wasip1", "-nostdlib", "-Wl,--version"];
  const res = spawnSync(clang, probe, { cwd: os.tmpdir(), encoding: "utf8" });
  if (!res.error && res.status === 0) {
    log(`wasm-ld：${res.stdout.trim().split(/\r?\n/)[0]}`);
    return;
  }
  // `-###` 只打印命令不执行：找到的链接器是完整路径，找不到时是 clang 要找的裸名字
  const plan = spawnSync(clang, [...probe, "-###"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
  });
  const linker = plan.stderr?.match(/^\s*"((?:[^"\\]|\\.)+)"/m)?.[1]
    .replace(/\\(.)/g, "$1") ?? "wasm-ld";
  const versioned = /wasm-ld-(\d+)(?:\.exe)?$/.exec(linker)?.[1];
  die(
    [
      `${clang} 调不起 wasm 链接器 ${linker}：`,
      (res.error ? String(res.error) : `${res.stderr}${res.stdout}`).trim(),
      "安装与 clang 同版本的 lld，或设环境变量 WPEFONT_CLANG 指向自带 wasm-ld 的 clang：",
      versioned
        ? `  Ubuntu / Debian：apt install lld-${versioned}（提供 wasm-ld-${versioned}）`
        : "  Linux：发行版的 lld（与 clang 同版本）",
      "  macOS：brew install lld",
      "  Windows：LLVM 官方安装包自带 wasm-ld.exe，确认它在 clang 同目录",
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
  // 构建前取指纹、成功后原样写下：构建期间改了输入的，下次照样判为过旧
  const inputs = currentInputs();
  const stale = staleReason(inputs);
  if (process.argv.includes("--if-stale")) {
    if (!stale) {
      log(`${path.relative(ROOT, WPEFONT_WASM)} 已是最新，跳过`);
      return;
    }
    log(`需要重建：${stale}`);
  }
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
  checkLinker(clang);

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
        // FT_CONFIG_OPTION_USE_HARFBUZZ 要 HarfBuzz 的头（hb.h、hb-ot.h）
        "-I",
        hbSrc,
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
  // C++ 通用参数（HarfBuzz 与 msdfgen 同一套：libc++ 无异常头、无 RTTI、无线程安全静态量）
  const cxx = [
    "--driver-mode=g++",
    ...target,
    ...COMMON,
    "-nostdinc++",
    "-isystem",
    libcxxInclude,
    "-std=c++17",
    "-fno-exceptions",
    "-fno-rtti",
    "-fno-threadsafe-statics",
  ];
  const msdfJobs: Job[] = [];
  const coreDir = path.join(MSDFGEN_DIR, "core");
  for (const name of fs.readdirSync(coreDir).sort()) {
    if (!name.endsWith(".cpp") || MSDFGEN_SKIP.has(name)) continue;
    const object = path.join(
      OBJ_DIR,
      `msdfgen_${path.basename(name, ".cpp")}.o`,
    );
    objects.push(object);
    msdfJobs.push({
      label: `msdfgen/core/${name}`,
      args: [
        ...cxx,
        "-DMSDFGEN_PUBLIC=",
        "-I",
        MSDFGEN_DIR,
        "-c",
        path.join(coreDir, name),
        "-o",
        object,
      ],
    });
  }
  const msdfGlueObject = path.join(OBJ_DIR, "wpefont_msdf.o");
  objects.push(msdfGlueObject);
  const msdfGlueJob: Job = {
    label: "src-tauri/wpefont/msdf.cpp",
    args: [
      ...cxx,
      ...SJLJ, // 包含 FreeType 头（FT_Outline_Decompose 的 setjmp 在 FreeType 里，但头里的宏与 ABI 同一套）
      "-DMSDFGEN_PUBLIC=",
      "-I",
      GLUE_DIR,
      "-I",
      ftInclude,
      "-I",
      hbSrc,
      "-I",
      MSDFGEN_DIR,
      "-c",
      path.join(GLUE_DIR, "msdf.cpp"),
      "-o",
      msdfGlueObject,
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
      GLUE_DIR,
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
  await runJobs(clang, [hbJob, ...ftJobs, ...msdfJobs, glueJob, msdfGlueJob]);

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
    "-lc++abi",
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
  fs.writeFileSync(INPUTS_STAMP, `${JSON.stringify(inputs, null, 2)}\n`);
  const kib = (fs.statSync(WPEFONT_WASM).size / 1024).toFixed(0);
  log(`产物 ${path.relative(ROOT, WPEFONT_WASM)}（${kib} KiB）`);
}

main().catch((error) =>
  die(error instanceof Error ? error.stack ?? error.message : String(error))
);
