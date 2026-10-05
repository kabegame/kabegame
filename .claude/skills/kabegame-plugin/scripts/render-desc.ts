#!/usr/bin/env -S deno run -A
// 离线渲染插件详情模板 templates/description.ejs 并截图，用来和源站详情页对照。
//
//   render-desc.ts <plugin-id> <metadata.json | --db [--task-plugin <id>] [--where <sql>]> [-o out.png] [--width 600]
//
// metadata 来源：
//   - 一个 JSON 文件（单个 metadata 对象）；
//   - --db：从 release CLI 默认数据目录的 images.db 取最近一次 <task-plugin>（默认 <plugin-id>-test）
//     任务里的一条 metadata，可用 --where 追加条件，如 "json_extract(m.data,'$.comment_count')>0"。
// 渲染方式与 app 的 ImagePluginDescriptionPanel 一致：ejs.render(tpl, { metadata })，外面包一层
// 同款 iframe 外壳样式（:root 的 --anime-* 取 app 默认值、body padding 8px）。
// 只做静态渲染：模板里依赖 window.__bridge 的异步逻辑不会执行。

import ejs from "npm:ejs@3.1.10";

const args = [...Deno.args];
const take = (flag: string) => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (flag: string) => {
  const i = args.indexOf(flag);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const root = new TextDecoder().decode(
  (await new Deno.Command("git", { args: ["rev-parse", "--show-toplevel"], stdout: "piped" }).output()).stdout,
).trim();
const out = take("-o") ?? `${Deno.env.get("TMPDIR") ?? "/tmp"}/kb-desc.png`.replace(/\/+/g, "/");
const width = Number(take("--width") ?? 600);
const taskPlugin = take("--task-plugin");
const where = take("--where");
const fromDb = has("--db");
const [pluginId, metaFile] = args;
if (!pluginId || (!fromDb && !metaFile)) {
  console.error("用法: render-desc.ts <plugin-id> <metadata.json | --db [--task-plugin id] [--where sql]> [-o out.png] [--width 600]");
  Deno.exit(2);
}

let metadataText: string;
if (fromDb) {
  const db = Deno.build.os === "darwin"
    ? `${Deno.env.get("HOME")}/Library/Application Support/Kabegame/images.db`
    : `${Deno.env.get("XDG_DATA_HOME") ?? `${Deno.env.get("HOME")}/.local/share`}/Kabegame/images.db`;
  const pid = taskPlugin ?? `${pluginId}-test`;
  const sql = `select m.data from images i join metadata m on m.id = i.metadata_id
    where i.task_id = (select id from tasks where plugin_id = '${pid.replace(/'/g, "''")}' order by start_time desc limit 1)
    ${where ? `and (${where})` : ""} limit 1`;
  const r = await new Deno.Command("sqlite3", { args: ["-readonly", db, sql], stdout: "piped", stderr: "piped" }).output();
  metadataText = new TextDecoder().decode(r.stdout).trim();
  if (!metadataText) {
    console.error(`✗ 库里没有符合条件的 metadata（task plugin=${pid}）：${new TextDecoder().decode(r.stderr)}`);
    Deno.exit(1);
  }
} else {
  metadataText = await Deno.readTextFile(metaFile);
}
const metadata = JSON.parse(metadataText);

const tplPath = `${root}/src-crawler-plugins/plugins/${pluginId}/templates/description.ejs`;
const body = ejs.render(await Deno.readTextFile(tplPath), { metadata }, { rmWhitespace: false });
// 与 app 注入的 iframe 外壳同形（ImagePluginDescriptionPanel.vue buildDescriptionIframeThemeStyles）
const shell = `<!doctype html><meta charset="utf-8"><style>:root{--anime-text-primary:#4a154b;--anime-text-secondary:#7c3aed;` +
  `--anime-primary:#ff6b9d;--anime-border:rgba(255,107,157,.3);--anime-bg-card:rgba(255,255,255,.9);}html,body{margin:0;padding:8px;` +
  `background:var(--anime-bg-card);color:var(--anime-text-primary);}body{box-sizing:border-box;}</style>`;
const html = `${shell}${body}`;
const htmlPath = out.replace(/\.png$/, ".html");
await Deno.writeTextFile(htmlPath, html);

const chrome = Deno.build.os === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "google-chrome";
await new Deno.Command(chrome, {
  args: ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},1600`,
    "--virtual-time-budget=4000", `--screenshot=${out}`, `file://${htmlPath}`],
  stdout: "null",
  stderr: "null",
}).output();
console.log(`✓ 渲染 ${pluginId} 模板 → ${out}（HTML：${htmlPath}）`);
console.log(`  metadata 顶层键：${Object.keys(metadata).join(", ")}`);
