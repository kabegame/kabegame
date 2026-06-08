#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/generate-release-comic-prompts.sh VERSION [options]

Examples:
  scripts/generate-release-comic-prompts.sh 4.1.1
  scripts/generate-release-comic-prompts.sh v4.1.0 --count 5
  scripts/generate-release-comic-prompts.sh 4.1.1 --count 4 --story-candidates 1 --gag-candidates 2
  scripts/generate-release-comic-prompts.sh 4.1.1 --base v4.1.0 --head v4.1.1 --out-dir 4masu/v4.1.1/comics

Options:
  --base REF       Base git ref. Defaults to the previous v* tag before VERSION.
  --head REF       Head git ref. Defaults to vVERSION if the tag exists, otherwise HEAD.
  --count N        Number of comic prompts to generate. Defaults to 4.
  --story-candidates N
                   Number of no-gag/explanatory story candidates per comic. Defaults to 1 and must be >= 1.
  --gag-candidates N
                   Number of gag / 小コント candidates per comic. Defaults to 1 and may be 0.
  --out FILE       Raw Codex JSON response. Defaults to 4masu/vVERSION/generated-prompts.json.
  --out-dir DIR    Directory for split prompts. Defaults to 4masu/vVERSION/generated-prompts.
  --model MODEL    Model for codex exec. Defaults to gpt-5.5.
  --reasoning-effort EFFORT
                   Reasoning effort / thinking level for codex exec. Defaults to high.
  --dry-run        Build context and print the codex command, but do not call codex.
  -h, --help       Show this help.

The script combines:
  - CHANGELOG.md section for the requested version
  - git commits and diff stats between base..head
  - selected git patches for changed source/docs files
  - 4masu base character/UI/layout prompt files

It then calls codex exec, stores the raw JSON response, and splits each comic into:
  OUT_DIR/comic-XX-slug/具体剧情名称.prompt.md
  ...
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || die "must be run inside a git repository"
cd "$repo_root"

version="${1:-}"
[[ -n "$version" ]] || { usage; exit 1; }
shift || true
[[ "$version" != "-h" && "$version" != "--help" ]] || { usage; exit 0; }

version="${version#v}"
tag="v${version}"
base_ref=""
head_ref=""
count="4"
story_candidates="1"
gag_candidates="1"
out_file="4masu/${tag}/generated-prompts.json"
out_dir="4masu/${tag}/generated-prompts"
model="gpt-5.5"
reasoning_effort="high"
dry_run="0"
panel_width="1536"
panel_height="1024"
final_width="3072"
final_height="2048"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      base_ref="${2:-}"
      [[ -n "$base_ref" ]] || die "--base requires a ref"
      shift 2
      ;;
    --head)
      head_ref="${2:-}"
      [[ -n "$head_ref" ]] || die "--head requires a ref"
      shift 2
      ;;
    --count)
      count="${2:-}"
      [[ "$count" =~ ^[0-9]+$ ]] || die "--count requires a positive integer"
      shift 2
      ;;
    --story-candidates)
      story_candidates="${2:-}"
      [[ "$story_candidates" =~ ^[0-9]+$ ]] || die "--story-candidates requires a positive integer"
      [[ "$story_candidates" -ge 1 ]] || die "--story-candidates must be >= 1"
      shift 2
      ;;
    --gag-candidates)
      gag_candidates="${2:-}"
      [[ "$gag_candidates" =~ ^[0-9]+$ ]] || die "--gag-candidates requires a non-negative integer"
      shift 2
      ;;
    --out)
      out_file="${2:-}"
      [[ -n "$out_file" ]] || die "--out requires a file path"
      shift 2
      ;;
    --out-dir)
      out_dir="${2:-}"
      [[ -n "$out_dir" ]] || die "--out-dir requires a directory path"
      shift 2
      ;;
    --model)
      model="${2:-}"
      [[ -n "$model" ]] || die "--model requires a model name"
      shift 2
      ;;
    --reasoning-effort)
      reasoning_effort="${2:-}"
      [[ "$reasoning_effort" =~ ^(none|minimal|low|medium|high|xhigh)$ ]] || die "--reasoning-effort must be one of: none, minimal, low, medium, high, xhigh"
      shift 2
      ;;
    --dry-run)
      dry_run="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

candidates=$((story_candidates + gag_candidates))

command -v codex >/dev/null 2>&1 || die "codex command not found"
command -v node >/dev/null 2>&1 || die "node command not found"
[[ -f CHANGELOG.md ]] || die "CHANGELOG.md not found"
[[ -d 4masu ]] || die "4masu directory not found"

if [[ -z "$head_ref" ]]; then
  if git rev-parse --verify --quiet "refs/tags/${tag}" >/dev/null; then
    head_ref="$tag"
  else
    head_ref="HEAD"
  fi
fi

if [[ -z "$base_ref" ]]; then
  prev=""
  found="0"
  while IFS= read -r t; do
    if [[ "$t" == "$tag" ]]; then
      found="1"
      break
    fi
    prev="$t"
  done < <(git tag --list 'v[0-9]*' --sort=v:refname)
  if [[ "$found" == "1" && -n "$prev" ]]; then
    base_ref="$prev"
  else
    die "could not infer previous tag for ${tag}; pass --base REF"
  fi
fi

git rev-parse --verify --quiet "$base_ref^{commit}" >/dev/null || die "base ref not found: $base_ref"
git rev-parse --verify --quiet "$head_ref^{commit}" >/dev/null || die "head ref not found: $head_ref"

mkdir -p "$(dirname "$out_file")" "$out_dir"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/kabegame-release-comics.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

changelog_file="$tmp_dir/changelog-${tag}.md"
diffstat_file="$tmp_dir/diffstat-${base_ref//\//_}-${head_ref//\//_}.txt"
commits_file="$tmp_dir/commits-${base_ref//\//_}-${head_ref//\//_}.txt"
patch_file="$tmp_dir/selected-patch-${base_ref//\//_}-${head_ref//\//_}.diff"
prompt_file="$tmp_dir/codex-prompt.md"
parser_file="$tmp_dir/parse-release-comic-prompts.js"

awk -v ver="$version" '
  $0 ~ "^## \\[?" ver "\\]?" { in_section=1; print; next }
  in_section && /^## / { exit }
  in_section { print }
' CHANGELOG.md > "$changelog_file"

if [[ ! -s "$changelog_file" ]]; then
  echo "No CHANGELOG.md section found for ${version}." > "$changelog_file"
fi

git log --oneline --decorate --no-merges "${base_ref}..${head_ref}" > "$commits_file" || true
git diff --stat "${base_ref}..${head_ref}" > "$diffstat_file"

# Keep the patch useful but bounded. Binary files, locks, generated build outputs, and media are
# not useful for prompt writing and can make the context too noisy.
changed_files=()
while IFS= read -r changed_file; do
  changed_files+=("$changed_file")
done < <(
  git diff --name-only "${base_ref}..${head_ref}" |
    grep -Ev '(^bun\.lock$|(^|/)package-lock\.json$|(^|/)target/|(^|/)dist/|(^|/)node_modules/|(^|/)third/|\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.mp4$|\.mov$|\.dmg$|\.deb$|\.exe$)' |
    head -n 80
)

{
  echo "Selected patch from ${base_ref}..${head_ref}"
  echo
  if [[ "${#changed_files[@]}" -eq 0 ]]; then
    echo "No selected text patches."
  else
    git diff --unified=80 --no-ext-diff "${base_ref}..${head_ref}" -- "${changed_files[@]}"
  fi
} > "$patch_file"

if [[ "$(wc -c < "$patch_file")" -gt 220000 ]]; then
  head -c 220000 "$patch_file" > "${patch_file}.truncated"
  {
    cat "${patch_file}.truncated"
    echo
    echo "[patch truncated by script at 220000 bytes]"
  } > "$patch_file"
fi

cat > "$prompt_file" <<EOF
你是一个严谨的软件发布漫画 prompt 策划助手。请为 Kabegame ${tag} 生成一组“发布漫画”的最终图片生成 prompts。

目标：
- 结合 CHANGELOG 和真实代码改动两方信息，不要只复述 changelog。
- 输出 ${count} 个不同主题的漫画，每个漫画主题下生成 ${candidates} 个剧情候选 prompt，并严格输出 JSON。
- 每个 comic 下必须包含 ${story_candidates} 个无笑点/说明型 story candidate，和 ${gag_candidates} 个有笑点/小コント gag candidate。story candidate 至少一个，用来清楚讲明更新内容，不强制制造笑点。
- 同一个 comic 下的所有 candidates 必须讲同一件更新内容、使用同一组核心更新点；candidate 之间只改变四格剧情的演出方式、误会点、吐槽点、オチ/落ち，不要把候选写成不同功能主题。
- 每个剧情候选都应该能拆成 4 张单格图片逐张生成，而不是一次生成整张四格。
- 单格固定为横向 3:2，推荐尺寸 ${panel_width}x${panel_height} px；最终 2x2 拼图推荐尺寸 ${final_width}x${final_height} px，阅读顺序为左上、右上、左下、右下。
- 多个漫画组成同一次发布的系列，主题不要重复。
- 每个 candidate 的 prompt 字段必须是可直接复制给图片生成 AI 的最终 prompt 正文。
- 脚本会自动把 4masu/bo.prompt.md、4masu/app-ui-setting.prompt.md、以及 layouts 字段引用的布局文件全文复制到每个 prompt.md 头部。
- 因为脚本会复制布局文件全文，所以不要在 title、reason、prompt、dialogue 里提到布局文件名，例如不要写“layout-01-gallery.prompt.md”。如果需要描述布局，请直接说“画廊页”“插件页”“任务详情页”等自然语言。
- 你输出的每个 candidate.prompt 字段不要重复 bo.prompt.md 的通用四格格式和角色固定段落，也不要重复布局文件全文；只写该剧情候选独有的应用场景、版本主题、四格剧情、对白建议、避免项。
- 同一 comic 的不同 candidate.prompt 里，版本主题和对应更新点要保持一致。story candidate 的最后一格可以是温柔收束、说明完成或轻微反差，不需要搞笑；gag candidate 的最后一格需要有明确笑点、吐槽、误会或反差オチ。
- 每个 candidate.prompt 的四格剧情必须逐格说明登场人物、站位、动作、表情、UI 背景、画面变化，以及每格在最终 2x2 中的位置。每一格都要能作为一张 ${panel_width}x${panel_height} px 单格图独立生成；不要只写台词。对白只能作为补充。
- 不要要求用户再补充“这是吉祥物”“请画四格漫画”“参考之前的角色”等前置语。
- 尽量把技术更新转译为普通用户和二次元用户能理解的视觉梗。
- 如果某个改动只适合开发者，明确把它包装成“后台整理仓库 / 路径树 / 小龟工程师”等隐喻。
- 不要实际生成图片，不要修改仓库文件，只输出 JSON。

必须参考的本地 prompt 文件：
- 4masu/bo.prompt.md
- 4masu/worldview.prompt.md
- 4masu/app-ui-setting.prompt.md
- 4masu/layout-00-app-shell.prompt.md
- 4masu/layout-01-gallery.prompt.md
- 4masu/layout-02-filter-preview.prompt.md
- 4masu/layout-03-albums.prompt.md
- 4masu/layout-04-plugins.prompt.md
- 4masu/layout-05-tasks-auto-configs.prompt.md
- 4masu/layout-06-settings-help.prompt.md
- 4masu/layout-07-mobile-compact.prompt.md
- 4masu/ui-comic-variants.prompt.md

参考角色图：
- 4masu/chara/kamechan.png

版本范围：
- base: ${base_ref}
- head: ${head_ref}
- version: ${tag}

请先在仓库里读取上面列出的 prompt 文件，再结合下面的上下文文件：
- ${changelog_file}
- ${commits_file}
- ${diffstat_file}
- ${patch_file}

输出格式必须是严格 JSON。不要使用 Markdown 代码块，不要输出 JSON 之外的解释。

JSON 结构：
{
  "series": "用 1 段话说明这一组漫画如何覆盖本次发布",
  "comics": [
    {
      "id": "comic-01-short-slug",
      "title": "漫画标题",
      "layouts": [
        "4masu/layout-00-app-shell.prompt.md",
        "4masu/layout-01-gallery.prompt.md"
      ],
      "updates": [
        "来自 changelog 或代码 diff 的具体更新点 1",
        "来自 changelog 或代码 diff 的具体更新点 2"
      ],
      "reason": "为什么适合画，1-2 句话。不要提布局文件名。",
      "candidates": [
        {
          "id": "short-candidate-slug",
          "tone": "story",
          "title": "具体剧情候选标题",
          "angle": "无笑点/说明型短故事。说明同一更新内容如何发生，最后一格温柔收束或说明完成。",
          "prompt": "完整可复制的最终图片生成 prompt 的剧情候选正文。不要提布局文件名。不要重复 bo.prompt.md 和布局文件全文。必须包含 Kabegame 是什么、本漫画主题、四格剧情、版本更新点、对白建议、避免项。",
          "dialogue": [
            "第 1 格：...",
            "第 2 格：...",
            "第 3 格：...",
            "第 4 格：..."
          ]
        },
        {
          "id": "another-candidate-slug",
          "tone": "gag",
          "title": "另一个具体剧情候选标题",
          "angle": "有笑点/小コント。讲同一更新内容，但最后一格有明显误会、吐槽或反差オチ。",
          "prompt": "第二个完整可复制的最终图片生成 prompt 的剧情候选正文。",
          "dialogue": [
            "第 1 格：...",
            "第 2 格：...",
            "第 3 格：...",
            "第 4 格：..."
          ]
        }
      ]
    }
  ]
}

layouts 只能从以下文件中选择，至少 1 个，最多 3 个：
- 4masu/layout-00-app-shell.prompt.md
- 4masu/layout-01-gallery.prompt.md
- 4masu/layout-02-filter-preview.prompt.md
- 4masu/layout-03-albums.prompt.md
- 4masu/layout-04-plugins.prompt.md
- 4masu/layout-05-tasks-auto-configs.prompt.md
- 4masu/layout-06-settings-help.prompt.md
- 4masu/layout-07-mobile-compact.prompt.md

继续输出直到 comics 数组有 ${count} 个漫画。每个 comic 必须有且只有 ${candidates} 个 candidates，其中 tone="story" 必须正好 ${story_candidates} 个，tone="gag" 必须正好 ${gag_candidates} 个。comic.id 使用英文小写、数字和连字符，例如 comic-01-provider-tree。candidate.title 必须是具体剧情名称，不能叫“剧情1”“候选1”“方案A”这种泛名；candidate.id 可用英文小写、数字和连字符。同一 comic 内的候选必须共享同一组 updates，只提供不同叙事方式或不同オチ。

重要约束：
- 每个漫画至少出现一个具体 Kabegame 页面或 UI 结构。
- 不要在图片 prompt 里要求生成大量小字；必要文字应短，或说明可留白后期加字。
- 不要编造不存在的大功能。如果根据代码推断，请标注为“视觉隐喻”，不要当成真实 UI 功能。
EOF

codex_args=(
  --ask-for-approval never
  --config "model_reasoning_effort=\"${reasoning_effort}\""
  exec
  --cd "$repo_root"
  --sandbox read-only
  --output-last-message "$out_file"
)

if [[ -n "$model" ]]; then
  codex_args+=(--model "$model")
fi

if [[ -f "4masu/character.png" ]]; then
  codex_args+=(--image "4masu/character.png")
fi

codex_args+=("-")

echo "version: ${tag}"
echo "base:    ${base_ref}"
echo "head:    ${head_ref}"
echo "comics:  ${count}"
echo "story:   ${story_candidates}"
echo "gag:     ${gag_candidates}"
echo "cands:   ${candidates}"
echo "panel:   ${panel_width}x${panel_height}"
echo "final:   ${final_width}x${final_height}"
echo "model:   ${model}"
echo "effort:  ${reasoning_effort}"
echo "raw:     ${out_file}"
echo "out dir: ${out_dir}"
echo "context: ${tmp_dir}"

if [[ "$dry_run" == "1" ]]; then
  trap - EXIT
  printf 'codex'
  printf ' %q' "${codex_args[@]}"
  printf ' < %q\n' "$prompt_file"
  echo
  echo "Prompt file:"
  echo "$prompt_file"
  exit 0
fi

codex "${codex_args[@]}" < "$prompt_file"

cat > "$parser_file" <<'NODE'
const fs = require("fs");
const path = require("path");

const [rawFile, outDir, tag, expectedCandidatesRaw, expectedStoryRaw, expectedGagRaw] = process.argv.slice(2);
const expectedCandidates = Number.parseInt(expectedCandidatesRaw, 10);
if (!Number.isInteger(expectedCandidates) || expectedCandidates < 1) {
  throw new Error(`invalid candidates count: ${expectedCandidatesRaw}`);
}
const expectedStory = Number.parseInt(expectedStoryRaw, 10);
const expectedGag = Number.parseInt(expectedGagRaw, 10);
if (!Number.isInteger(expectedStory) || expectedStory < 1) {
  throw new Error(`invalid story candidates count: ${expectedStoryRaw}`);
}
if (!Number.isInteger(expectedGag) || expectedGag < 0) {
  throw new Error(`invalid gag candidates count: ${expectedGagRaw}`);
}
const repoRoot = process.cwd();
const allowedLayouts = new Set([
  "4masu/layout-00-app-shell.prompt.md",
  "4masu/layout-01-gallery.prompt.md",
  "4masu/layout-02-filter-preview.prompt.md",
  "4masu/layout-03-albums.prompt.md",
  "4masu/layout-04-plugins.prompt.md",
  "4masu/layout-05-tasks-auto-configs.prompt.md",
  "4masu/layout-06-settings-help.prompt.md",
  "4masu/layout-07-mobile-compact.prompt.md",
]);

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8").trimEnd();
}

function extractJson(raw) {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (_err) {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(s.slice(start, end + 1));
    }
    throw _err;
  }
}

function safeId(id, index) {
  const fallback = `comic-${String(index + 1).padStart(2, "0")}`;
  const value = String(id || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return value || fallback;
}

function safeFileStem(title, fallback) {
  let value = String(title || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return value || fallback;
}

function asList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

const raw = fs.readFileSync(rawFile, "utf8");
const data = extractJson(raw);
if (!data || !Array.isArray(data.comics) || data.comics.length === 0) {
  throw new Error("JSON must contain a non-empty comics array");
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "series.md"),
  `# ${tag} 发布漫画系列\n\n${String(data.series || "").trim()}\n`,
);

const bo = read("4masu/bo.prompt.md");
const worldview = fs.existsSync(path.join(repoRoot, "4masu/worldview.prompt.md"))
  ? read("4masu/worldview.prompt.md")
  : "";
const app = read("4masu/app-ui-setting.prompt.md");

for (const [index, comic] of data.comics.entries()) {
  const id = safeId(comic.id, index);
  const dir = path.join(outDir, id);
  fs.mkdirSync(dir, { recursive: true });

  const layouts = asList(comic.layouts);
  if (layouts.length === 0) {
    throw new Error(`${id}: layouts must contain at least one layout file`);
  }
  for (const layout of layouts) {
    if (!allowedLayouts.has(layout)) {
      throw new Error(`${id}: unsupported layout file: ${layout}`);
    }
  }

  const updates = asList(comic.updates);
  const candidates = Array.isArray(comic.candidates) ? comic.candidates : [];
  if (candidates.length !== expectedCandidates) {
    throw new Error(`${id}: candidates must contain exactly ${expectedCandidates} item(s)`);
  }
  const storyCount = candidates.filter((candidate) => String(candidate.tone || "").toLowerCase() === "story").length;
  const gagCount = candidates.filter((candidate) => String(candidate.tone || "").toLowerCase() === "gag").length;
  if (storyCount !== expectedStory || gagCount !== expectedGag) {
    throw new Error(`${id}: expected ${expectedStory} story candidate(s) and ${expectedGag} gag candidate(s), got ${storyCount} story and ${gagCount} gag`);
  }

  const layoutText = layouts
    .map((layout) => `## 页面布局设定\n\n${read(layout)}`)
    .join("\n\n---\n\n");

  const usedNames = new Set();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const title = String(candidate.title || comic.title || `剧情${candidateIndex + 1}`).trim();
    const tone = String(candidate.tone || "").toLowerCase();
    const dialogue = asList(candidate.dialogue);
    const prompt = String(candidate.prompt || "").trim();
    if (!prompt) {
      throw new Error(`${id}/剧情${candidateIndex + 1}: prompt is empty`);
    }

    const body = [
      worldview,
      "",
      "---",
      "",
      layoutText,
      "",
      "---",
      "",
      `# ${title}`,
      "",
      comic.title ? `漫画主题：${String(comic.title).trim()}\n` : "",
      tone ? `候选类型：${tone === "story" ? "无笑点说明型短故事" : "有笑点小コント"}\n` : "",
      comic.reason ? `为什么适合画：${String(comic.reason).trim()}\n` : "",
      candidate.angle ? `剧情角度：${String(candidate.angle).trim()}\n` : "",
      updates.length ? `对应更新点：\n${updates.map((u) => `- ${u}`).join("\n")}\n` : "",
      "```text",
      prompt,
      "```",
      "",
      dialogue.length ? `可选对白：\n${dialogue.map((d) => `- ${d}`).join("\n")}\n` : "",
      "---",
      bo,
      "",
    ].filter((part) => part !== "").join("\n");

    const fallbackStem = String(candidate.id || `candidate-${candidateIndex + 1}`);
    let stem = safeFileStem(title, fallbackStem);
    if (usedNames.has(stem)) {
      stem = `${stem}-${candidateIndex + 1}`;
    }
    usedNames.add(stem);
    fs.writeFileSync(path.join(dir, `${stem}.prompt.md`), body);
  }
}
NODE

node "$parser_file" "$out_file" "$out_dir" "$tag" "$candidates" "$story_candidates" "$gag_candidates"

echo
echo "Raw Codex JSON response:"
echo "$out_file"
echo
echo "Split prompt files:"
find "$out_dir" -type f -name '*.prompt.md' | sort
