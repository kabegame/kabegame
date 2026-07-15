#!/usr/bin/env -S deno run -A

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

interface Options {
  article: string;
  env: string;
  outDir?: string;
  dryRun: boolean;
}

interface WechatConfig {
  appId: string;
  appSecret: string;
  author: string;
  contentSourceUrl: string;
  needOpenComment: number;
  onlyFansCanComment: number;
  maxInlineImageBytes: number;
}

interface ImageRef {
  alt: string;
  rawPath: string;
  absolutePath: string;
  index: number;
}

interface UploadedImage {
  ref: ImageRef;
  preparedPath: string;
  url?: string;
}

const API_BASE = "https://api.weixin.qq.com/cgi-bin";

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    article: "",
    env: "ignore/wechat-daily-codex/wechat.env",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--article":
        opts.article = argv[++i] ?? "";
        break;
      case "--env":
        opts.env = argv[++i] ?? "";
        break;
      case "--out-dir":
        opts.outDir = argv[++i] ?? "";
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`Usage:
  deno run -A scripts/upload-wechat-draft.ts --article <article.final.md> [--env <wechat.env>] [--dry-run]

Required env values:
  WECHAT_APP_ID
  WECHAT_APP_SECRET

Typical run:
  deno run -A scripts/upload-wechat-draft.ts --article ignore/wechat-daily-codex/.../article.final.md --env ignore/wechat-daily-codex/wechat.env
`);
}

async function findLatestFinalArticle(): Promise<string> {
  const root = path.resolve("ignore/wechat-daily-codex");
  const found: { file: string; mtimeMs: number }[] = [];

  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === "article.final.md") {
        const st = await stat(full);
        found.push({ file: full, mtimeMs: st.mtimeMs });
      }
    }
  }

  await walk(root);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!found[0]) {
    throw new Error(`No article.final.md found under ${root}`);
  }
  return found[0].file;
}

async function loadEnvFile(file: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (!existsSync(file)) return env;

  const text = await readFile(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function getEnvValue(env: Record<string, string>, key: string): string {
  return process.env[key] ?? env[key] ?? "";
}

function loadConfig(env: Record<string, string>, requireCredentials: boolean): WechatConfig {
  const appId = getEnvValue(env, "WECHAT_APP_ID");
  const appSecret = getEnvValue(env, "WECHAT_APP_SECRET");
  if (requireCredentials && (!appId || !appSecret)) {
    throw new Error(
      "Missing WECHAT_APP_ID or WECHAT_APP_SECRET. Copy scripts/wechat-draft.env.example to ignore/wechat-daily-codex/wechat.env and fill it.",
    );
  }

  return {
    appId: appId || "DRY_RUN_APP_ID",
    appSecret: appSecret || "DRY_RUN_APP_SECRET",
    author: getEnvValue(env, "WECHAT_AUTHOR"),
    contentSourceUrl: getEnvValue(env, "WECHAT_CONTENT_SOURCE_URL"),
    needOpenComment: Number(getEnvValue(env, "WECHAT_NEED_OPEN_COMMENT") || "0"),
    onlyFansCanComment: Number(getEnvValue(env, "WECHAT_ONLY_FANS_CAN_COMMENT") || "0"),
    maxInlineImageBytes: Number(
      getEnvValue(env, "WECHAT_MAX_INLINE_IMAGE_BYTES") || "950000",
    ),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripMarkdownBreak(value: string): string {
  return value.replace(/[ \t]{2,}$/g, "");
}

function parseArticleMarkdown(markdown: string, articleDir: string) {
  const lines = markdown.split(/\r?\n/);
  const titleLine = lines.find((line) => line.startsWith("# "));
  const title = titleLine?.replace(/^#\s+/, "").trim() || "Untitled";

  const imageRefs: ImageRef[] = [];
  let imageIndex = 0;
  for (const line of lines) {
    const match = line.match(/^!\[(.*)\]\((.*)\)\s*$/);
    if (!match) continue;
    imageIndex += 1;
    const rawPath = match[2]!.trim();
    const absolutePath = path.resolve(articleDir, rawPath);
    imageRefs.push({
      alt: match[1] ?? "",
      rawPath,
      absolutePath,
      index: imageIndex,
    });
  }

  const digest = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!") && line !== "---")[0]
    ?.slice(0, 120) ?? "";

  return { title, digest, lines, imageRefs };
}

async function prepareImageForWechat(
  image: ImageRef,
  workDir: string,
  maxBytes: number,
): Promise<string> {
  if (!existsSync(image.absolutePath)) {
    throw new Error(`Image does not exist: ${image.absolutePath}`);
  }

  const out = path.join(workDir, `${String(image.index).padStart(2, "0")}-${path.parse(image.rawPath).name}.jpg`);
  let quality = 88;
  let width = 1280;
  let lastBuffer: Buffer | undefined;

  for (let attempt = 0; attempt < 10; attempt++) {
    lastBuffer = await sharp(image.absolutePath)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();

    if (lastBuffer.byteLength <= maxBytes) break;
    if (quality > 62) {
      quality -= 8;
    } else {
      width = Math.max(720, Math.floor(width * 0.82));
    }
  }

  if (!lastBuffer) throw new Error(`Failed to prepare image: ${image.absolutePath}`);
  await writeFile(out, lastBuffer);
  return out;
}

function buildContentHtml(
  lines: string[],
  uploadedImages: UploadedImage[],
): string {
  const uploadedByRawPath = new Map(uploadedImages.map((item) => [item.ref.rawPath, item]));
  const html: string[] = [];
  let paragraph: string[] = [];

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map((line) => escapeHtml(stripMarkdownBreak(line))).join("<br/>")}</p>`);
    paragraph = [];
  }

  for (const line of lines) {
    if (line.startsWith("# ")) continue;
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    if (line.trim() === "---") {
      flushParagraph();
      html.push(`<p style="margin:24px 0;border-top:1px solid #eeeeee;"></p>`);
      continue;
    }

    const imageMatch = line.match(/^!\[(.*)\]\((.*)\)\s*$/);
    if (imageMatch) {
      flushParagraph();
      const alt = imageMatch[1] ?? "";
      const rawPath = imageMatch[2]!.trim();
      const uploaded = uploadedByRawPath.get(rawPath);
      const src = uploaded?.url ?? uploaded?.preparedPath ?? rawPath;
      html.push(`<p><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"/></p>`);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return html.join("\n");
}

async function parseWechatJson(res: Response): Promise<any> {
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`WeChat returned non-JSON HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.ok || (json.errcode && json.errcode !== 0)) {
    throw new Error(`WeChat API error HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getAccessToken(config: WechatConfig): Promise<string> {
  const stable = await fetch(`${API_BASE}/stable_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credential",
      appid: config.appId,
      secret: config.appSecret,
      force_refresh: false,
    }),
  });

  try {
    const json = await parseWechatJson(stable);
    if (json.access_token) return json.access_token;
  } catch (error) {
    console.warn(`stable_token failed, falling back to token endpoint: ${(error as Error).message}`);
  }

  const token = await fetch(
    `${API_BASE}/token?grant_type=client_credential&appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}`,
  );
  const json = await parseWechatJson(token);
  if (!json.access_token) throw new Error(`Missing access_token: ${JSON.stringify(json)}`);
  return json.access_token;
}

async function uploadArticleImage(accessToken: string, filePath: string): Promise<string> {
  const form = new FormData();
  form.set("media", new Blob([await readFile(filePath)], { type: "image/jpeg" }), path.basename(filePath));
  const res = await fetch(`${API_BASE}/media/uploadimg?access_token=${accessToken}`, {
    method: "POST",
    body: form,
  });
  const json = await parseWechatJson(res);
  if (!json.url) throw new Error(`Missing upload image url: ${JSON.stringify(json)}`);
  return json.url;
}

async function uploadPermanentImage(accessToken: string, filePath: string): Promise<string> {
  const form = new FormData();
  form.set("media", new Blob([await readFile(filePath)], { type: "image/jpeg" }), path.basename(filePath));
  const res = await fetch(`${API_BASE}/material/add_material?access_token=${accessToken}&type=image`, {
    method: "POST",
    body: form,
  });
  const json = await parseWechatJson(res);
  if (!json.media_id) throw new Error(`Missing material media_id: ${JSON.stringify(json)}`);
  return json.media_id;
}

async function addDraft(accessToken: string, article: any): Promise<any> {
  const res = await fetch(`${API_BASE}/draft/add?access_token=${accessToken}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ articles: [article] }),
  });
  return parseWechatJson(res);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const articlePath = path.resolve(opts.article || (await findLatestFinalArticle()));
  const articleDir = path.dirname(articlePath);
  const outDir = path.resolve(opts.outDir || path.join(articleDir, "wechat-upload"));
  const preparedDir = path.join(outDir, "prepared-images");
  await mkdir(preparedDir, { recursive: true });

  const envPath = path.resolve(opts.env);
  if (!existsSync(envPath)) {
    await mkdir(path.dirname(envPath), { recursive: true });
    await copyFile(path.resolve("scripts/wechat-draft.env.example"), envPath).catch(() => {});
  }

  const env = await loadEnvFile(envPath);
  const config = loadConfig(env, !opts.dryRun);
  const markdown = await readFile(articlePath, "utf8");
  const parsed = parseArticleMarkdown(markdown, articleDir);
  if (parsed.imageRefs.length === 0) {
    throw new Error(`No markdown images found in ${articlePath}`);
  }

  const uploadedImages: UploadedImage[] = [];
  for (const image of parsed.imageRefs) {
    const preparedPath = await prepareImageForWechat(
      image,
      preparedDir,
      config.maxInlineImageBytes,
    );
    uploadedImages.push({ ref: image, preparedPath });
  }

  let accessToken = "";
  let thumbMediaId = "";
  if (!opts.dryRun) {
    accessToken = await getAccessToken(config);
    for (const item of uploadedImages) {
      item.url = await uploadArticleImage(accessToken, item.preparedPath);
    }
    thumbMediaId = await uploadPermanentImage(accessToken, uploadedImages[0]!.preparedPath);
  }

  const content = buildContentHtml(parsed.lines, uploadedImages);
  const draftArticle = {
    title: parsed.title,
    author: config.author,
    digest: parsed.digest,
    content,
    content_source_url: config.contentSourceUrl,
    thumb_media_id: thumbMediaId || "DRY_RUN_THUMB_MEDIA_ID",
    need_open_comment: config.needOpenComment,
    only_fans_can_comment: config.onlyFansCanComment,
  };

  await writeFile(path.join(outDir, "wechat-content.generated.html"), content, "utf8");
  await writeFile(
    path.join(outDir, "draft-request.preview.json"),
    JSON.stringify({ articles: [draftArticle] }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "upload-map.json"),
    JSON.stringify(
      uploadedImages.map((item) => ({
        index: item.ref.index,
        raw_path: item.ref.rawPath,
        original_path: item.ref.absolutePath,
        prepared_path: item.preparedPath,
        uploaded_url: item.url ?? null,
      })),
      null,
      2,
    ),
    "utf8",
  );

  if (opts.dryRun) {
    console.log(`Dry run complete: ${outDir}`);
    console.log("Fill ignore/wechat-daily-codex/wechat.env and rerun without --dry-run to create a WeChat draft.");
    return;
  }

  const draftResponse = await addDraft(accessToken, draftArticle);
  await writeFile(
    path.join(outDir, "draft-response.json"),
    JSON.stringify(draftResponse, null, 2),
    "utf8",
  );

  console.log(`WeChat draft created: ${JSON.stringify(draftResponse)}`);
  console.log(`Artifacts: ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
