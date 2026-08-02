#!/usr/bin/env node
// claude CLI 驱动：把一个前端任务派给 claude（默认 sonnet 模型），流式打印进度，
// 最终答案写文件并回显。后端 Rust 任务请走 run-codex skill。用法见同目录 SKILL.md。

import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const SCOPES = {
  // 默认作用域：本 skill 就是"claude 写前端"的入口，后端交给 codex。
  fe: [
    "本轮你只负责【前端】：Vue / TypeScript / JavaScript / 样式(UnoCSS、CSS) / i18n JSON。",
    "禁止修改任何后端与构建产物文件——按【文件类型】判断，不要只按目录判断：",
    "*.rs、Cargo.toml / Cargo.lock、*.kt / *.java、build.rs、scripts/ 下的构建脚本、third/ 子模块，",
    "以及 src-tauri/、src-tauri-plugins/ 下的一切。为了理解接口可以【读】它们，但一行都不要改，",
    "也不要用 Bash（sed/perl/cat 重写等）绕过这条限制。",
    "如果任务必须动后端，就把前端能做的部分做完，然后在最终答案里单独起一段「需要后端配合」，",
    "列出涉及哪个 Rust 文件、要加什么命令/字段/事件，交由 codex（run-codex skill）处理。",
  ].join(""),
  be: [
    "本轮你只负责【后端】：src-tauri/ 下的 Rust。前端 Vue/TS 文件只读不改。",
    "（注意：本仓库后端任务默认应该派给 codex，用这个 scope 说明你有意让 claude 来做。）",
  ].join(""),
  none: "",
};

const argv = process.argv.slice(2);
const opts = {
  write: false,
  full: false,
  model: "sonnet",
  scope: "fe",
  schema: "",
  resume: "",
  cd: process.cwd(),
  timeout: 900,
  effort: "",
  noMcp: false,
  quiet: false,
  ephemeral: false,
  prompt: "",
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--write") opts.write = true;
  else if (a === "--full") opts.full = true;
  else if (a === "--no-mcp") opts.noMcp = true;
  else if (a === "--quiet") opts.quiet = true;
  else if (a === "--ephemeral") opts.ephemeral = true;
  else if (a === "--model" || a === "-m") opts.model = argv[++i];
  else if (a === "--scope") opts.scope = argv[++i];
  else if (a === "--effort") opts.effort = argv[++i];
  else if (a === "--schema") opts.schema = resolve(argv[++i]);
  else if (a === "--resume") opts.resume = argv[++i];
  else if (a === "--cd" || a === "-C") opts.cd = resolve(argv[++i]);
  else if (a === "--timeout") opts.timeout = Number(argv[++i]);
  else if (a === "--prompt-file" || a === "-f") opts.prompt = readFileSync(resolve(argv[++i]), "utf8");
  else if (a === "-h" || a === "--help") {
    console.log(`用法: node driver.mjs [选项] "<任务描述>"

选项:
  --write              允许改文件（--permission-mode acceptEdits）。默认只读：Edit/Write 会被拒
  --full               --dangerously-skip-permissions（什么都放行，慎用）
  -m, --model <名字>    默认 sonnet（本 skill 的定位就是让 sonnet 写前端）
  --scope <fe|be|none> 追加作用域约束系统提示，默认 fe（只碰前端，后端交给 codex）
  --effort <级别>       low|medium|high|xhigh|max，默认走 claude 自己的设置
  --schema <file>      JSON Schema 文件，强制最终答案为结构化 JSON
  --resume <id|last>   续跑已有会话（id 见上次输出的 session；last = 本目录下最近一次 driver 跑的会话）
  -C, --cd <目录>       claude 的工作目录（默认当前目录）。会话按目录隔离，resume 必须同目录
  -f, --prompt-file <f> 从文件读取任务描述（长 prompt 用这个）
  --timeout <秒>        默认 900
  --ephemeral          --no-session-persistence，会话不落盘（之后不能 --resume）
  --no-mcp             --strict-mcp-config，忽略所有已配置的 MCP server
  --quiet              不打印中间进度，只打印最终答案

退出码: 0 正常 · 3 写入类工具(Edit/Write)被权限拒绝（多半是忘了 --write）· 124 超时 · 其他透传 claude
        Bash 被拒不影响退出码（分类器挡掉某条命令很常见，claude 会换写法重试）

产物写到 <cd>/ignore/claude-runs/<时间戳>/：events.jsonl · last-message.txt · session.txt · meta.json`);
    process.exit(0);
  } else if (!a.startsWith("-") && !opts.prompt) opts.prompt = a;
  else {
    console.error(`未知参数: ${a}`);
    process.exit(2);
  }
}

if (!(opts.scope in SCOPES)) {
  console.error(`--scope 只能是 fe / be / none，收到: ${opts.scope}`);
  process.exit(2);
}
if (!opts.prompt) {
  console.error("缺少任务描述。用 --help 看用法。");
  process.exit(2);
}

const runsRoot = join(opts.cd, "ignore", "claude-runs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(runsRoot, stamp);
mkdirSync(runDir, { recursive: true });
const lastMsgPath = join(runDir, "last-message.txt");
const eventsPath = join(runDir, "events.jsonl");

// --resume last：claude 自己没有 "last" 语义（-r 不带值会开交互 picker，非 tty 下没用），
// 这里用本 driver 自己落的 session.txt 找最近一次。
let resumeId = opts.resume;
if (resumeId === "last") {
  const cands = existsSync(runsRoot)
    ? readdirSync(runsRoot).sort().reverse()
        .map((d) => join(runsRoot, d, "session.txt"))
        .filter((p) => existsSync(p))
    : [];
  if (!cands.length) {
    console.error(`[driver] --resume last 找不到历史会话（${runsRoot} 下没有 session.txt）`);
    process.exit(2);
  }
  resumeId = readFileSync(cands[0], "utf8").trim();
  console.error(`[driver] --resume last -> ${resumeId}`);
}

const permissionMode = opts.full ? null : opts.write ? "acceptEdits" : "default";

const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", opts.model];
if (opts.full) args.push("--dangerously-skip-permissions");
else args.push("--permission-mode", permissionMode);
if (resumeId) args.push("-r", resumeId);
if (opts.effort) args.push("--effort", opts.effort);
if (opts.ephemeral) args.push("--no-session-persistence");
if (opts.noMcp) args.push("--strict-mcp-config");
if (opts.schema) args.push("--json-schema", readFileSync(opts.schema, "utf8"));
// scope 走 --append-system-prompt：不覆盖 claude 默认系统提示，只在末尾加一段作用域约束。
if (SCOPES[opts.scope]) args.push("--append-system-prompt", SCOPES[opts.scope]);
args.push(opts.prompt);

writeFileSync(
  join(runDir, "meta.json"),
  JSON.stringify({ args, model: opts.model, scope: opts.scope, permissionMode, cwd: opts.cd, startedAt: stamp }, null, 2),
);

const eventsFd = openSync(eventsPath, "a");
// stdin 给 /dev/null：非 tty 下 claude 会把 stdin 当输入读，管道不关就一直等。
const child = spawn("claude", args, { cwd: opts.cd, stdio: [openSync("/dev/null", "r"), "pipe", "pipe"] });

let killed = false;
const timer = setTimeout(() => {
  killed = true;
  child.kill("SIGKILL");
}, opts.timeout * 1000);

let sessionId = "";
let resultEvent = null;
let buf = "";

const brief = (s, n = 160) => String(s ?? "").split("\n")[0].slice(0, n);

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
    if (ev.type === "system" && ev.subtype === "init") {
      sessionId = ev.session_id;
      if (!opts.quiet) console.error(`[driver] session=${sessionId} model=${ev.model} permission=${ev.permissionMode}`);
      continue;
    }
    if (ev.type === "result") { resultEvent = ev; continue; }
    // 额度告警始终打印（即使 --quiet）：claude 走的是订阅额度，跑满了后面全会失败。
    if (ev.type === "rate_limit_event") {
      const r = ev.rate_limit_info ?? {};
      if (r.status && r.status !== "allowed") {
        console.error(`[driver] 额度 ${r.rateLimitType}=${Math.round((r.utilization ?? 0) * 100)}% (${r.status})`);
      }
      continue;
    }
    if (opts.quiet) continue;
    if (ev.type !== "assistant") continue;
    for (const c of ev.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) console.error(`  · ${brief(c.text)}`);
      else if (c.type === "tool_use") {
        const inp = c.input ?? {};
        const detail = inp.command ?? inp.file_path ?? inp.pattern ?? inp.path ?? inp.prompt ?? "";
        console.error(`  ${c.name === "Edit" || c.name === "Write" ? "±" : "$"} ${c.name}: ${brief(detail)}`);
      }
    }
  }
});

// claude 的报错走 stderr，且不是 JSON —— 千万别 2>&1 混进事件流，原样透传。
child.stderr.pipe(process.stderr);

child.on("close", (code) => {
  clearTimeout(timer);
  if (killed) {
    console.error(`\n[driver] 超时 ${opts.timeout}s，已 SIGKILL。产物: ${runDir}`);
    process.exit(124);
  }
  if (sessionId && !opts.ephemeral) writeFileSync(join(runDir, "session.txt"), sessionId);

  const denials = resultEvent?.permission_denials ?? [];
  // schema 模式优先落结构化结果（result 字段是同一份 JSON 的字符串形式）。
  const final = resultEvent?.structured_output
    ? JSON.stringify(resultEvent.structured_output)
    : (resultEvent?.result ?? "");
  writeFileSync(lastMsgPath, final);

  const u = resultEvent?.usage;
  console.error(`\n[driver] session=${sessionId || "?"} scope=${opts.scope} exit=${code} subtype=${resultEvent?.subtype ?? "?"}`);
  if (u) {
    console.error(`[driver] tokens in=${u.input_tokens} (cache read ${u.cache_read_input_tokens}, write ${u.cache_creation_input_tokens}) out=${u.output_tokens}`
      + ` cost=$${(resultEvent.total_cost_usd ?? 0).toFixed(4)} ${(resultEvent.duration_ms / 1000).toFixed(1)}s`);
  }
  // Bash 被拒很常见（权限分类器挡掉某条命令，claude 换个写法就过了），不算失败。
  // 真正需要报警的是写入类工具被拒 —— 那基本等于"忘了 --write"，任务没真做。
  const writeDenied = denials.filter((d) => ["Edit", "Write", "NotebookEdit"].includes(d.tool_name));
  if (denials.length) {
    console.error(`[driver] 被权限拒绝的调用 ${denials.length} 次: ${[...new Set(denials.map((d) => d.tool_name))].join(", ")}（明细见 events.jsonl）`);
  }
  if (writeDenied.length) {
    console.error("[driver] !! 写入被拒——多半是忘了 --write，任务没真正落盘。");
  }
  console.error(`[driver] 产物: ${runDir}`);
  console.error("[driver] ---------- 最终答案 ----------");
  console.log(final || "(claude 没有产出最终消息，查看 events.jsonl)");
  process.exit(code ? code : writeDenied.length ? 3 : 0);
});
