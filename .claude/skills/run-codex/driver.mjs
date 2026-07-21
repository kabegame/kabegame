#!/usr/bin/env node
// codex exec 驱动：把一个具体任务派给 codex CLI，流式打印进度，最终答案写文件并回显。
// 用法见同目录 SKILL.md。

import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const argv = process.argv.slice(2);
const opts = {
  write: false,
  full: false,
  model: "",
  schema: "",
  resume: "",
  cd: process.cwd(),
  timeout: 900,
  mcp: false,
  quiet: false,
  ephemeral: false,
  prompt: "",
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--write") opts.write = true;
  else if (a === "--full") opts.full = true;
  else if (a === "--mcp") opts.mcp = true;
  else if (a === "--quiet") opts.quiet = true;
  else if (a === "--ephemeral") opts.ephemeral = true;
  else if (a === "--model" || a === "-m") opts.model = argv[++i];
  else if (a === "--schema") opts.schema = resolve(argv[++i]);
  else if (a === "--resume") opts.resume = argv[++i];
  else if (a === "--cd" || a === "-C") opts.cd = resolve(argv[++i]);
  else if (a === "--timeout") opts.timeout = Number(argv[++i]);
  else if (a === "--prompt-file" || a === "-f") opts.prompt = readFileSync(resolve(argv[++i]), "utf8");
  else if (a === "-h" || a === "--help") {
    console.log(`用法: node driver.mjs [选项] "<任务描述>"

选项:
  --write              沙箱设为 workspace-write（默认 read-only，只读分析）
  --full               沙箱设为 danger-full-access（可联网/写仓库外，慎用）
  -m, --model <名字>    覆盖模型（默认走 ~/.codex/config.toml）
  --schema <file>      JSON Schema 文件，强制最终答案为结构化 JSON
  --resume <id|last>   续跑已有会话（id 见上次输出的 session）
  -C, --cd <目录>       codex 的工作根（默认当前目录）
  -f, --prompt-file <f> 从文件读取任务描述（长 prompt 用这个）
  --timeout <秒>        默认 900
  --ephemeral          不把会话 rollout 落到 ~/.codex（用完即弃，之后不能 --resume）
  --mcp                不禁用 ~/.codex/config.toml 里的 MCP server（默认禁用）
  --quiet              不打印中间进度，只打印最终答案

产物写到 <cd>/ignore/codex-runs/<时间戳>/：events.jsonl · last-message.txt · meta.json`);
    process.exit(0);
  } else if (!a.startsWith("-") && !opts.prompt) opts.prompt = a;
  else if (a === "-") { /* stdin 占位，忽略 */ }
  else {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
}

if (!opts.prompt && !opts.resume) {
  console.error("缺少任务描述。用 --help 看用法。");
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(opts.cd, "ignore", "codex-runs", stamp);
mkdirSync(runDir, { recursive: true });
const lastMsgPath = join(runDir, "last-message.txt");
const eventsPath = join(runDir, "events.jsonl");

const sandbox = opts.full ? "danger-full-access" : opts.write ? "workspace-write" : "read-only";

const args = ["exec"];
if (opts.resume) {
  // resume 子命令不接受 --sandbox / -C / --color：沙箱和工作目录从被续的那个会话继承。
  args.push("resume");
  if (opts.resume === "last") args.push("--last");
} else {
  args.push("--color", "never", "--sandbox", sandbox, "-C", opts.cd);
}
args.push("--json", "-o", lastMsgPath);
if (opts.ephemeral && !opts.resume) args.push("--ephemeral");
// 默认禁用 config.toml 里的 kabegame MCP server：应用没跑时它会每几秒刷一条 HTTP 502 ERROR。
// `enabled` 是官方文档里 mcp_servers 条目的字段（"Set false to disable a server without deleting it"），
// 这里用 -c 把它按次覆盖，不动用户的 ~/.codex/config.toml。
if (!opts.mcp) args.push("-c", "mcp_servers.kabegame.enabled=false");
if (opts.model) args.push("-m", opts.model);
if (opts.schema) args.push("--output-schema", opts.schema);
// resume 的位置参数顺序是 [SESSION_ID] [PROMPT]，必须排在所有选项之后。
if (opts.resume && opts.resume !== "last") args.push(opts.resume);
if (opts.prompt) args.push(opts.prompt);

writeFileSync(join(runDir, "meta.json"), JSON.stringify({ args, sandbox, cwd: opts.cd, startedAt: stamp }, null, 2));

const eventsFd = openSync(eventsPath, "a");
// stdin 必须给 /dev/null：非 tty 下 codex 会去读 stdin 当追加输入，管道不关就一直等。
const child = spawn("codex", args, { cwd: opts.cd, stdio: [openSync("/dev/null", "r"), "pipe", "pipe"] });

let killed = false;
const timer = setTimeout(() => {
  killed = true;
  child.kill("SIGKILL");
}, opts.timeout * 1000);

let sessionId = "";
let usage = null;
let buf = "";

child.stdout.on("data", (chunk) => {
  writeFileSync(eventsFd, chunk);
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === "thread.started") sessionId = ev.thread_id;
    if (ev.type === "turn.completed") usage = ev.usage;
    if (opts.quiet) continue;
    const item = ev.item;
    if (ev.type === "item.started" && item?.type === "command_execution") {
      console.error(`  $ ${String(item.command).replace(/^\/bin\/\w+ -lc /, "").slice(0, 160)}`);
    } else if (ev.type === "item.completed" && item?.type === "agent_message") {
      console.error(`  · ${String(item.text).split("\n")[0].slice(0, 160)}`);
    } else if (ev.type === "item.completed" && item?.type === "file_change") {
      console.error(`  ± ${JSON.stringify(item.changes ?? item).slice(0, 160)}`);
    }
  }
});

// codex 的 tracing 日志（含 MCP 报错）走 stderr，原样透传。
child.stderr.pipe(process.stderr);

child.on("close", (code) => {
  clearTimeout(timer);
  if (killed) {
    console.error(`\n[driver] 超时 ${opts.timeout}s，已 SIGKILL。产物: ${runDir}`);
    process.exit(124);
  }
  const final = existsSync(lastMsgPath) ? readFileSync(lastMsgPath, "utf8").trim() : "";
  const sandboxLabel = opts.resume ? "(继承自被续会话)" : sandbox;
  console.error(`\n[driver] session=${sessionId || "?"} sandbox=${sandboxLabel} exit=${code}`);
  if (usage) console.error(`[driver] tokens in=${usage.input_tokens} (cached ${usage.cached_input_tokens}) out=${usage.output_tokens}`);
  console.error(`[driver] 产物: ${runDir}`);
  console.error("[driver] ---------- 最终答案 ----------");
  console.log(final || "(codex 没有产出最终消息，查看 events.jsonl)");
  process.exit(code ?? 1);
});
