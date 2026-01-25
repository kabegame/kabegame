import { spawnSync } from "child_process";

type Options = {
  path: string;
  exclude: string;
  includeExt: string;
};

function usage(): void {
  console.log(
    [
      "用法:",
      "  bun cloc",
      "  bun cloc -- --path <路径> --exclude <逗号分隔目录> --include-ext <逗号分隔后缀>",
      "",
      "示例:",
      "  bun cloc",
      "  bun cloc -- --path src-tauri",
      '  bun cloc -- --exclude "node_modules,dist,build,.git"',
      '  bun cloc -- --include-ext "rs,ts,tsx,vue"',
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    path: ".",
    exclude:
      "node_modules,dist,build,.git,.turbo,.next,target,.nx,public,actions-runner,data,crawler-venv",
    includeExt:
      "ts,tsx,js,jsx,vue,rs,go,py,java,kt,swift,cs,cpp,c,h,cc,hpp,rb,php,html,css,scss,rhai",
  };

  const args = [...argv];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    }
    if (a === "-p" || a === "--path" || a === "--Path") {
      const v = args.shift();
      if (!v) throw new Error(`缺少参数值：${a}`);
      opts.path = v;
      continue;
    }
    if (a === "-e" || a === "--exclude" || a === "--Exclude") {
      const v = args.shift();
      if (!v) throw new Error(`缺少参数值：${a}`);
      opts.exclude = v;
      continue;
    }
    if (a === "--include-ext" || a === "--IncludeExt" || a === "--includeExt") {
      const v = args.shift();
      if (!v) throw new Error(`缺少参数值：${a}`);
      opts.includeExt = v;
      continue;
    }
    throw new Error(`未知参数：${a}`);
  }

  return opts;
}

function tryRun(cmd: string, args: string[]): { ok: boolean; status?: number } {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) return { ok: false };
  if (typeof res.status === "number") {
    return { ok: res.status === 0, status: res.status };
  }
  return { ok: false };
}

function hasCommand(cmd: string): boolean {
  if (process.platform === "win32") {
    const res = spawnSync("where", [cmd], { stdio: "ignore", shell: false });
    return res.status === 0;
  }
  const res = spawnSync("sh", ["-lc", `command -v ${cmd}`], {
    stdio: "ignore",
    shell: false,
  });
  return res.status === 0;
}

function main(): void {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String((e as Error)?.message ?? e));
    usage();
    process.exit(2);
    return;
  }

  const excludeOpt = `--exclude-dir=${opts.exclude}`;
  const includeOpt = `--include-ext=${opts.includeExt}`;

  if (hasCommand("cloc")) {
    const res = tryRun("cloc", [opts.path, excludeOpt, includeOpt]);
    process.exit(res.status ?? (res.ok ? 0 : 1));
    return;
  }

  if (hasCommand("bunx")) {
    const res = tryRun("bunx", ["cloc", opts.path, excludeOpt, includeOpt]);
    process.exit(res.status ?? (res.ok ? 0 : 1));
    return;
  }

  if (hasCommand("npx")) {
    const res = tryRun("npx", [
      "--yes",
      "cloc",
      opts.path,
      excludeOpt,
      includeOpt,
    ]);
    process.exit(res.status ?? (res.ok ? 0 : 1));
    return;
  }

  console.error(
    "未找到 cloc，也未找到 bunx/npx。请安装 cloc 或 Node.js(npx) 后重试。",
  );
  process.exit(127);
}

main();
