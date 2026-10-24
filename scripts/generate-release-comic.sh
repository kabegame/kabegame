#!/usr/bin/env bash
#
# 发布漫画单格出图脚本。
#
# 前置：已经用 scripts/generate-release-comic-prompts.sh 生成好剧情 JSON
#     versions/v<version>/4koma/generated-prompts.json
# JSON 是唯一事实来源。每次运行先调用 scripts/regenerate-comic-prompts.py，把 JSON 重新拆成
#     versions/v<version>/4koma/generated-prompts/comic-XX-slug/<剧情编号>-<剧情名>.prompt.md
# 再取第 COMIC 部漫画、第 STORY 个剧情（JSON 里候选的顺序，从 1 起）的 prompt.md，
# 交给 codex 的图片生成工具，只画第 IMAGE 格。
#
# 附给 codex 的图片按以下顺序排列，prompt 里会逐张说明是什么：
#     1. candidate.characters 里的角色参考图（JSON 中的 {name, image}）
#     2. 加 --ig 时，同一剧情已生成的上一格 story<STORY>-image<IMAGE-1>.png，用来保持画风一致
#        （为了省 token 只带上一格，不带更早的格子）
#
# codex 把生成的图写到 $CODEX_HOME/generated_images/<session id>/ 下（默认 ~/.codex）。
# 脚本从 codex 输出里读出 session id，取回该目录里最新的 png，复制成
#     versions/v<version>/4koma/generated-prompts/comic-XX-slug/story<STORY>-image<IMAGE>.png
# 已存在就直接覆盖；--ig 回头找上一格也只按这个文件名约定找。
#
# --comb 不调用 codex：把同一剧情的 story<STORY>-image1..4.png 交给 scripts/compose-comic.py，
# 套 4koma/template.psd 的边框拼成 3072x2048 的 2x2 成品 story<STORY>-image.png（已存在就覆盖）。
#
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/generate-release-comic.sh VERSION [COMIC] [STORY] [IMAGE] [options]

Examples:
  scripts/generate-release-comic.sh 4.6.0                # comic 1, story 1, panel 1
  scripts/generate-release-comic.sh v4.6.0 2 1 3 --ig   # comic 2, story 1, panel 3, attach story1-image2.png
  scripts/generate-release-comic.sh 4.6.0 1 2           # comic 1, story 2, panel 1
  scripts/generate-release-comic.sh 4.6.0 1 1 --comb    # compose story1-image1..4.png into story1-image.png

Arguments:
  VERSION          Release version, e.g. 4.6.0 or v4.6.0.
  COMIC            1-based comic index in generated-prompts.json. Defaults to 1.
  STORY            1-based story (candidate) within the comic; the N- prefix of the
                   prompt.md file name. Defaults to 1.
  IMAGE            Panel number to draw, 1-4 (1 左上, 2 右上, 3 左下, 4 右下). Defaults to 1.

Options:
  --ig             Attach the previous panel of the same story (story<STORY>-image<IMAGE-1>.png)
                   as a style reference.
  --comb           Do not call codex. Compose story<STORY>-image1..4.png onto 4koma/template.psd
                   into story<STORY>-image.png (3072x2048). IMAGE must not be given.
  --model MODEL   Codex model. Defaults to gpt-5.6-sol.
  --reasoning-effort EFFORT
                   Codex reasoning effort. Defaults to high.
  --dry-run        Regenerate prompts and build the codex prompt, but do not call codex.
  -h, --help       Show this help.

Output:
  versions/vVERSION/4koma/generated-prompts/<comic-id>/story<STORY>-image<IMAGE>.png (overwritten if it exists)
  versions/vVERSION/4koma/generated-prompts/<comic-id>/story<STORY>-image.png         (--comb)
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || die "must be run inside a git repository"
cd "$repo_root"

version=""
comic="1"
story="1"
image="1"
include_generated="0"
combine="0"
model="gpt-5.6-sol"
reasoning_effort="high"
dry_run="0"
positional=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ig)
      include_generated="1"
      shift
      ;;
    --comb)
      combine="1"
      shift
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
    -*)
      die "unknown option: $1"
      ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done

[[ "${#positional[@]}" -ge 1 ]] || { usage; exit 1; }
[[ "${#positional[@]}" -le 4 ]] || die "too many arguments: ${positional[*]}"
version="${positional[0]}"
[[ "${#positional[@]}" -ge 2 ]] && comic="${positional[1]}"
[[ "${#positional[@]}" -ge 3 ]] && story="${positional[2]}"
[[ "${#positional[@]}" -ge 4 ]] && image="${positional[3]}"

version="${version#v}"
tag="v${version}"
[[ "$comic" =~ ^[1-9][0-9]*$ ]] || die "COMIC must be a positive integer: $comic"
[[ "$story" =~ ^[1-9][0-9]*$ ]] || die "STORY must be a positive integer: $story"
[[ "$image" =~ ^[1-4]$ ]] || die "IMAGE must be 1-4: $image"
if [[ "$combine" == "1" ]]; then
  [[ "${#positional[@]}" -le 3 ]] || die "--comb composes all 4 panels; do not pass IMAGE"
  [[ "$include_generated" == "0" ]] || die "--comb cannot be combined with --ig"
fi

json_file="versions/${tag}/4koma/generated-prompts.json"
out_dir="versions/${tag}/4koma/generated-prompts"
[[ -f "$json_file" ]] || die "prompts JSON not found: ${json_file} (run scripts/generate-release-comic-prompts.sh ${version} first)"

[[ "$dry_run" == "1" || "$combine" == "1" ]] || command -v codex >/dev/null 2>&1 || die "codex command not found"
python_cmd="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
[[ -n "$python_cmd" ]] || die "python3/python command not found"

# 以 JSON 为准，先把 prompt.md 全部重新拆一遍。
"$python_cmd" "$repo_root/scripts/regenerate-comic-prompts.py" "$version" \
  --raw "$json_file" \
  --out-dir "$out_dir" >/dev/null

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/kabegame-release-comic.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

# 复用 regenerate-comic-prompts.py 的 id / 文件名规则定位漫画目录与 prompt.md。
# 输出：第 1 行 KEY=VALUE 形式的元信息，之后每行一个「角色名<TAB>参考图路径」。
locate_file="$tmp_dir/locate.txt"
"$python_cmd" - "$repo_root" "$json_file" "$out_dir" "$comic" "$story" "$combine" > "$locate_file" <<'PY'
import importlib.util
import sys
from pathlib import Path

repo_root, json_file, out_dir, comic_no, cand_no, combine = sys.argv[1:7]
repo = Path(repo_root)
spec = importlib.util.spec_from_file_location(
    "regenerate_comic_prompts", repo / "scripts/regenerate-comic-prompts.py"
)
rcp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rcp)

comics = rcp.load_comics_json(repo / json_file)["comics"]
ci = int(comic_no) - 1
if ci >= len(comics):
    sys.exit(f"error: COMIC {comic_no} out of range: JSON has {len(comics)} comic(s)")
comic = comics[ci]
comic_id = rcp.safe_id(str(comic.get("id") or ""), ci)

candidates = comic.get("candidates") if isinstance(comic.get("candidates"), list) else []
ki = int(cand_no) - 1
if ki >= len(candidates):
    sys.exit(f"error: STORY {cand_no} out of range: {comic_id} has {len(candidates)} story(ies)")
cand = candidates[ki]
where = f"{comic_id}/story {cand_no}"

characters = rcp.candidate_characters(repo, cand, where)
# 拼图不需要角色参考图，只有出图时才要求 characters。
if not characters and combine != "1":
    sys.exit(
        f"error: {where}: JSON has no characters field; add "
        '"characters": [{"name": "kamechan", "image": "4koma/chara/kamechan-sette.png"}] to the candidate'
    )

stem = rcp.candidate_stems(comic, candidates)[ki]
comic_dir = Path(out_dir) / comic_id

def one_line(value) -> str:
    return " ".join(str(value or "").split())

print(f"comic_dir={comic_dir}")
print(f"prompt_md={comic_dir / (stem + '.prompt.md')}")
print(f"comic_title={one_line(comic.get('title'))}")
print(f"candidate_title={one_line(cand.get('title'))}")
print("---")
for c in characters:
    print(f"{one_line(c['name'])}\t{c['image']}")
PY

comic_dir=""
prompt_md=""
comic_title=""
candidate_title=""
attach_files=()
attach_notes=()
in_chars="0"
while IFS= read -r line; do
  if [[ "$in_chars" == "0" ]]; then
    case "$line" in
      comic_dir=*) comic_dir="${line#comic_dir=}" ;;
      prompt_md=*) prompt_md="${line#prompt_md=}" ;;
      comic_title=*) comic_title="${line#comic_title=}" ;;
      candidate_title=*) candidate_title="${line#candidate_title=}" ;;
      ---) in_chars="1" ;;
    esac
  else
    name="${line%%$'\t'*}"
    path="${line#*$'\t'}"
    attach_files+=("$path")
    attach_notes+=("角色「${name}」的参考图（${path}）。角色外观、服装、配色以这张图为准；如果是设定图，图上的说明文字、三视图排版、色卡不要画进画面。")
  fi
done < "$locate_file"

[[ -f "$prompt_md" ]] || die "prompt file not found: ${prompt_md}"

if [[ "$combine" == "1" ]]; then
  panels=()
  missing=()
  for k in 1 2 3 4; do
    p="${comic_dir}/story${story}-image${k}.png"
    panels+=("$p")
    [[ -f "$p" ]] || missing+=("$p")
  done
  if [[ "${#missing[@]}" -gt 0 ]]; then
    for p in "${missing[@]}"; do
      echo "missing: ${p}" >&2
    done
    die "--comb needs all 4 panels of story ${story}"
  fi

  comb_out="${comic_dir}/story${story}-image.png"
  echo "version:   ${tag}"
  echo "comic:     ${comic} (${comic_dir})"
  echo "story:     ${story} (${candidate_title})"
  echo "output:    ${comb_out}"
  if [[ "$dry_run" == "1" ]]; then
    printf '%q' "$python_cmd"
    printf ' %q' "$repo_root/scripts/compose-comic.py" "${panels[@]}" --out "$comb_out" --output-size 3072x2048
    echo
    exit 0
  fi
  "$python_cmd" "$repo_root/scripts/compose-comic.py" "${panels[@]}" \
    --out "$comb_out" \
    --output-size 3072x2048
  exit 0
fi

# 为了省 token，--ig 只带同一剧情的上一格。
if [[ "$include_generated" == "1" ]]; then
  if [[ "$image" -eq 1 ]]; then
    echo "warning: --ig: panel 1 has no previous panel, skipped" >&2
  else
    k=$((image - 1))
    prev="${comic_dir}/story${story}-image${k}.png"
    if [[ -f "$prev" ]]; then
      attach_files+=("$prev")
      attach_notes+=("同一篇漫画已经生成好的上一格，第 ${k} 格（story${story}-image${k}.png）。用来保持角色形象、配色、线稿、边框和 UI 简化程度一致；不要照搬它的构图和内容，这次要画的是第 ${image} 格。")
    else
      echo "warning: --ig: ${prev} not found, skipped" >&2
    fi
  fi
fi

case "$image" in
  1) position="左上" ;;
  2) position="右上" ;;
  3) position="左下" ;;
  4) position="右下" ;;
esac

codex_prompt="$tmp_dir/image-prompt.md"
{
  echo "请调用图片生成工具，只生成 1 张图片：Kabegame ${tag} 发布漫画「${comic_title}」中剧情「${candidate_title}」的第 ${image} 格（最终 2x2 中的${position}）。"
  echo
  echo "要求："
  echo "- 只画下方剧情里「第 ${image} 格」那一段描述的内容，不要画其他格，也不要一次画 2x2 四格。"
  echo "- 横向 3:2，尺寸 1536x1024。"
  echo "- 不要画格子边框、圆角外框或白边，画面铺满到图片边缘；之后会套模板统一加边框。"
  echo "- 只调用一次图片生成工具。生成完成后不要再做别的事，只回复生成成功或失败原因。"
  echo
  echo "附图说明（按附图顺序）："
  i=0
  while [[ "$i" -lt "${#attach_notes[@]}" ]]; do
    echo "- 附图 $((i + 1))：${attach_notes[$i]}"
    i=$((i + 1))
  done
  echo
  echo "下面是这一篇漫画的完整 prompt："
  echo
  cat "$prompt_md"
} > "$codex_prompt"

codex_args=(
  --ask-for-approval never
  --config "model_reasoning_effort=\"${reasoning_effort}\""
  exec
  --cd "$repo_root"
  --sandbox read-only
  --output-last-message "$tmp_dir/last-message.txt"
)
for f in "${attach_files[@]}"; do
  codex_args+=(--image "$f")
done
codex_args+=(--model "$model" -)

out_file="${comic_dir}/story${story}-image${image}.png"

echo "version:   ${tag}"
echo "comic:     ${comic} (${comic_dir})"
echo "story:     ${story} (${candidate_title})"
echo "image:     ${image} (${position})"
echo "prompt:    ${prompt_md}"
echo "attach:    ${#attach_files[@]} image(s)"
for f in "${attach_files[@]}"; do
  echo "           - ${f}"
done
echo "model:     ${model}"
echo "effort:    ${reasoning_effort}"
echo "output:    ${out_file}"

if [[ "$dry_run" == "1" ]]; then
  trap - EXIT
  printf 'codex'
  printf ' %q' "${codex_args[@]}"
  printf ' < %q\n' "$codex_prompt"
  echo
  echo "Codex prompt file:"
  echo "$codex_prompt"
  exit 0
fi

codex_log="$tmp_dir/codex.log"
echo
echo "generating... (usually takes about a minute)"
if ! codex "${codex_args[@]}" < "$codex_prompt" > "$codex_log" 2>&1; then
  tail -n 40 "$codex_log" >&2
  die "codex exec failed"
fi

session_id="$(grep -m1 -o 'session id: [0-9a-f-]*' "$codex_log" | awk '{print $3}' || true)"
[[ -n "$session_id" ]] || { tail -n 40 "$codex_log" >&2; die "could not find codex session id in output"; }

images_dir="${CODEX_HOME:-$HOME/.codex}/generated_images/${session_id}"
generated=()
if [[ -d "$images_dir" ]]; then
  while IFS= read -r f; do
    generated+=("$f")
  done < <(ls -t "$images_dir"/*.png 2>/dev/null || true)
fi
if [[ "${#generated[@]}" -eq 0 ]]; then
  tail -n 40 "$codex_log" >&2
  die "codex did not generate an image (looked in ${images_dir})"
fi
[[ "${#generated[@]}" -eq 1 ]] || echo "warning: codex generated ${#generated[@]} images; using the newest one" >&2

cp -f "${generated[0]}" "$out_file"

echo
echo "codex:     $(tr '\n' ' ' < "$tmp_dir/last-message.txt" 2>/dev/null || true)"
echo "source:    ${generated[0]}"
if command -v sips >/dev/null 2>&1; then
  echo "size:      $(sips -g pixelWidth -g pixelHeight "$out_file" | awk '/pixel/{print $2}' | paste -sd x -)"
fi
echo "saved:     ${out_file}"
