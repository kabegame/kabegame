/**
 * 重建 dev 场景宿主产物，不重启 dev（kabegame-chromium「场景宿主产物」）。
 *
 * ```text
 * deno run -A apps/kabegame-dev-mcp/src/buildSceneHost.ts [--out-dir <目录>] [--staging <目录>] [--keep-staging]
 * ```
 *
 * dev 只在启动时构建一次场景宿主（`scripts/plugins/wpe-scene-host-plugin.ts` 的 `buildForDev`），之后不监听 `apps/wpe-scene`。
 * 改了宿主代码（含临时插桩）要让跑着的应用用上，就用这个工具：
 * 1. 按 dev 插件同一条命令（`deno task build --mode development`，有 dev 探针）构建到暂存目录（缺省 `<target>/wpe-scene-staging`，
 *    经 `KABEGAME_WPE_SCENE_OUT_DIR`，见 `apps/wpe-scene/vite.config.ts`）；
 * 2. 核对暂存里有 `index.html`、带 dev 探针（`__kabegameSceneProbe`）；
 * 3. 换进应用读的 `<target>/debug/resources/wpe-scene`：先拷新的资源文件，`index.html` 最后拷，再删掉新产物里没有的旧文件
 *    （旧的哈希文件名）。不直接构建进去：vite 会先清空输出目录，构建的几十秒里别的会话的宿主加载会失败。
 *
 * - 换上之后新开的宿主（`render_scene` / `renderFrames.ts` 单开、预览、桌面壁纸窗口重载）用新产物；已经开着的宿主还跑旧代码，
 *   要重开（同 SKILL「宿主产物重新构建后，旧宿主不会被复用」）。这会换掉**所有会话**正在用的宿主产物，产物里是工作区的代码
 *   （含别的会话未提交的改动），和重启 dev 时一样。
 * - `<target>` 是 `CARGO_TARGET_DIR` 或仓库下的 `target`（同 vite.config.ts）。
 * - stdout 一行 JSON：`{ ok, outDir, index, previous, copied, removed, seconds, error? }`（`index` / `previous` 是新旧的 `assets/index-*.js`）。
 * - 本工具不启动、不重启任何进程，只跑一次构建命令、拷文件。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCENE_HOST_APP_DIR = path.join(ROOT, "apps", "wpe-scene");
/** dev 探针在产物里的标记（`apps/wpe-scene/src/dev/install.ts` 挂的全局名）：没有就是 production 构建，探针工具用不了。 */
export const DEV_PROBE_MARK = "__kabegameSceneProbe";

/** `<target>`：`CARGO_TARGET_DIR`（相对仓库根）或仓库下的 `target`，同 `apps/wpe-scene/vite.config.ts`。 */
export function targetRoot(env: Record<string, string | undefined> = process.env): string {
  return env.CARGO_TARGET_DIR ? path.resolve(ROOT, env.CARGO_TARGET_DIR) : path.join(ROOT, "target");
}

/** 目录下全部文件的相对路径（`/` 分隔、排好序）；目录不存在时为空。 */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const child = rel ? `${rel}/${name}` : name;
      if (statSync(path.join(dir, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk("");
  return out.sort();
}

/**
 * 把暂存目录换进输出目录：先拷 `index.html` 以外的新文件，`index.html` 最后拷（它引用的资源这时都在了），再删新产物里没有的旧文件。
 * 返回拷了几个、删了哪些。
 */
export function swapInto(staging: string, outDir: string): { copied: number; removed: string[] } {
  const fresh = listFiles(staging);
  if (!fresh.includes("index.html")) throw new Error(`暂存目录里没有 index.html：${staging}`);
  const ordered = [...fresh.filter((file) => file !== "index.html"), "index.html"];
  for (const file of ordered) {
    const to = path.join(outDir, file);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(staging, file), to);
  }
  const keep = new Set(fresh);
  const removed = listFiles(outDir).filter((file) => !keep.has(file));
  for (const file of removed) rmSync(path.join(outDir, file), { force: true });
  return { copied: ordered.length, removed };
}

/** 产物里的 `assets/index-*.js`（宿主入口）。 */
export function indexScripts(dir: string): string[] {
  return listFiles(dir).filter((file) => /^assets\/index-[^/]+\.js$/.test(file));
}

function main(): number {
  const started = performance.now();
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "out-dir": { type: "string" },
      staging: { type: "string" },
      "keep-staging": { type: "boolean", default: false },
    },
  });
  const outDir = path.resolve(values["out-dir"] ?? path.join(targetRoot(), "debug", "resources", "wpe-scene"));
  const staging = path.resolve(values.staging ?? path.join(targetRoot(), "wpe-scene-staging"));
  const report = (result: Record<string, unknown>) => {
    console.log(JSON.stringify({ ...result, outDir, seconds: Math.round((performance.now() - started) / 100) / 10 }));
  };
  if (path.relative(outDir, staging) === "" || !path.relative(outDir, staging).startsWith("..")) {
    report({ ok: false, error: `暂存目录不能在输出目录里：${staging}` });
    return 2;
  }
  const previous = indexScripts(outDir);
  rmSync(staging, { recursive: true, force: true });
  const build = spawnSync("deno", ["task", "build", "--mode", "development"], {
    cwd: SCENE_HOST_APP_DIR,
    env: { ...process.env, KABEGAME_WPE_SCENE_OUT_DIR: staging },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    report({
      ok: false,
      error: `构建失败（退出码 ${build.status}）`,
      log: `${build.stdout ?? ""}${build.stderr ?? ""}`.slice(-4000),
    });
    return 1;
  }
  const index = indexScripts(staging);
  const probed = index.some((file) => readFileSync(path.join(staging, file), "utf8").includes(DEV_PROBE_MARK));
  if (!index.length || !probed) {
    report({
      ok: false,
      error: index.length ? "产物里没有 dev 探针（不是 development 构建）" : "产物里没有 assets/index-*.js",
      previous,
    });
    return 1;
  }
  const { copied, removed } = swapInto(staging, outDir);
  if (!values["keep-staging"]) rmSync(staging, { recursive: true, force: true });
  report({ ok: true, index, previous, copied, removed });
  return 0;
}

// `import.meta.main`：同 main.ts 的收窄
if ((import.meta as ImportMeta & { main?: boolean }).main) process.exit(main());
