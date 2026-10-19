#!/usr/bin/env python3
"""
Regenerate comic prompt .md files from an existing generated-prompts.json.

The JSON is produced by the AI step in generate-release-comic-prompts.sh.
This script is the post-processing step: it reads the JSON + current layout/
worldview/bo source files from disk, then writes one .prompt.md per candidate.

Because layout files are re-read on every run, you can update them and
re-run this script to refresh all prompts without touching the JSON.

Usage:
  python scripts/regenerate-comic-prompts.py 4.2.0
  python scripts/regenerate-comic-prompts.py v4.2.0 --raw versions/v4.2.0/4koma/generated-prompts.json
  python scripts/regenerate-comic-prompts.py 4.2.0 --out-dir versions/v4.2.0/4koma/generated-prompts
  python scripts/regenerate-comic-prompts.py 4.2.0 --expected-candidates 2 --expected-story 1 --expected-gag 1
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


ALLOWED_LAYOUTS = {
    "4koma/layout-00-app-shell.prompt.md",
    "4koma/layout-01-gallery.prompt.md",
    "4koma/layout-02-filter-preview.prompt.md",
    "4koma/layout-03-albums.prompt.md",
    "4koma/layout-04-plugins.prompt.md",
    "4koma/layout-05-tasks-auto-configs.prompt.md",
    "4koma/layout-06-settings-dialog.prompt.md",
    "4koma/layout-07-mobile-compact.prompt.md",
    "4koma/layout-08-image-preview.prompt.md",
    "4koma/layout-09-webpage-collect.prompt.md",
}

# 布局文件改名后，旧版本 JSON 里的文件名映射到新文件，保证历史版本仍能重新生成。
LAYOUT_ALIASES = {
    "4koma/layout-06-settings-help.prompt.md": "4koma/layout-06-settings-dialog.prompt.md",
}

# Strip duplicate dialogue suggestions that the model may embed inside the
# prompt field (dialogue is already appended separately from candidate.dialogue).
_DIALOGUE_RE = re.compile(
    r'\n对白建议（[^）\n]*）：\n(?:[-•] 第 \d+ 格[^\n]*\n)+',
    re.MULTILINE,
)


def find_repo_root() -> Path:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
        )
        return Path(out.decode().strip())
    except subprocess.CalledProcessError:
        sys.exit("error: must be run inside a git repository")


def safe_id(raw: str, index: int) -> str:
    fallback = f"comic-{index + 1:02d}"
    value = re.sub(r"[^a-z0-9-]+", "-", (raw or fallback).lower()).strip("-")[:80]
    return value or fallback


def safe_file_stem(title: str, fallback: str) -> str:
    value = re.sub(r'[\\/:*?"<>|]+', "-", (title or fallback).strip())
    value = re.sub(r"\s+", "-", value).strip("-")[:80]
    return value or fallback


def as_list(value) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v]
    return []


CHARA_DIR = "4koma/chara/"


def candidate_characters(repo_root: Path, candidate: dict, where: str) -> list[dict]:
    """校验并返回 candidate.characters：[{name, image}]，image 必须是 4koma/chara/ 下存在的文件。

    老版本 JSON 没有这个字段时返回空列表，不报错；出图脚本自己决定缺字段怎么处理。
    """
    raw = candidate.get("characters")
    if raw is None:
        return []
    if not isinstance(raw, list):
        sys.exit(f"error: {where}: characters must be an array")
    out: list[dict] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            sys.exit(f"error: {where}: characters[{i}] must be an object")
        name = str(item.get("name") or "").strip()
        image = str(item.get("image") or "").strip()
        if not name or not image:
            sys.exit(f"error: {where}: characters[{i}] needs both name and image")
        if not image.startswith(CHARA_DIR) or not (repo_root / image).is_file():
            sys.exit(f"error: {where}: character image not found under {CHARA_DIR}: {image}")
        out.append({"name": name, "image": image})
    return out


def candidate_stems(comic: dict, candidates: list) -> list[str]:
    """每个候选对应的 .prompt.md 文件名（不含扩展名），形如「<剧情编号>-<剧情名>」，编号从 1 起。

    剧情编号就是候选在 JSON 里的顺序，出图脚本按同一编号找文件、命名 story<编号>-image<格>.png。
    """
    stems: list[str] = []
    for ci, candidate in enumerate(candidates):
        title = str(
            candidate.get("title") or comic.get("title") or f"剧情{ci + 1}"
        ).strip()
        stem = safe_file_stem(title, str(candidate.get("id") or f"candidate-{ci + 1}"))
        stems.append(f"{ci + 1}-{stem}")
    return stems


def read_src(repo_root: Path, rel: str) -> str:
    return (repo_root / rel).read_text(encoding="utf-8").rstrip()


def strip_dialogue(prompt: str) -> str:
    """Remove duplicate 对白建议 blocks embedded inside the prompt text."""
    return _DIALOGUE_RE.sub("\n", prompt).strip()


def extract_json(raw: str) -> dict:
    s = raw.strip()
    fence = re.match(r"^```(?:json)?\s*([\s\S]*?)\s*```$", s)
    if fence:
        s = fence.group(1).strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        start, end = s.find("{"), s.rfind("}")
        if start >= 0 and end > start:
            return json.loads(s[start : end + 1])
        raise


def load_comics_json(raw_path: Path) -> dict:
    if not raw_path.exists():
        sys.exit(f"error: JSON file not found: {raw_path}")

    raw = raw_path.read_text(encoding="utf-8")
    # Strip leading prose the model sometimes prepends before the JSON object
    brace = raw.find("{")
    if brace > 0:
        raw = raw[brace:]

    try:
        data = extract_json(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        sys.exit(f"error: could not parse JSON: {exc}")

    comics = data.get("comics")
    if not isinstance(comics, list) or not comics:
        sys.exit("error: JSON must contain a non-empty 'comics' array")
    return data


STORY_BEGIN ="━" * 24 + " 正式剧情 · 开始 " + "━" * 24
STORY_END = "━" * 24 + " 正式剧情 · 结束 " + "━" * 24


def build_body(
    *,
    worldview: str,
    layout_text: str,
    comic: dict,
    candidate: dict,
    updates: list[str],
    characters: list[dict],
    prompt_text: str,
    dialogue: list[str],
    bo: str,
    title: str,
    tone: str,
) -> str:
    tone_label = {
        "story": "无笑点说明型短故事",
        "gag": "有笑点小コント",
    }.get(tone, "")

    parts: list[str] = []
    if worldview:
        parts += [worldview, "", "---", ""]
    parts += [layout_text, f"\n{STORY_BEGIN}\n", f"# {title}", ""]
    if comic.get("title"):
        parts.append(f"漫画主题：{str(comic['title']).strip()}\n")
    if tone_label:
        parts.append(f"候选类型：{tone_label}\n")
    if comic.get("reason"):
        parts.append(f"为什么适合画：{str(comic['reason']).strip()}\n")
    if candidate.get("angle"):
        parts.append(f"剧情角度：{str(candidate['angle']).strip()}\n")
    if updates:
        parts.append("对应更新点：\n" + "\n".join(f"- {u}" for u in updates) + "\n")
    if characters:
        parts.append(
            "出场角色参考图（角色外观以参考图为准）：\n"
            + "\n".join(f"- {c['name']}：{c['image']}" for c in characters)
            + "\n"
        )
    parts += ["```text", prompt_text, "```", ""]
    if dialogue:
        parts.append("对白：\n" + "\n".join(f"- {d}" for d in dialogue) + "\n")
    parts += [f"\n{STORY_END}\n", bo, ""]

    return "\n".join(p for p in parts if p != "") + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Regenerate comic .prompt.md files from a generated-prompts.json"
    )
    ap.add_argument("version", help="Release version, e.g. 4.2.0 or v4.2.0")
    ap.add_argument(
        "--raw",
        metavar="FILE",
        help="Path to raw JSON file (default: versions/vVERSION/4koma/generated-prompts.json)",
    )
    ap.add_argument(
        "--out-dir",
        metavar="DIR",
        help="Output directory (default: versions/vVERSION/4koma/generated-prompts)",
    )
    ap.add_argument(
        "--expected-candidates",
        type=int,
        default=None,
        metavar="N",
        help="Validate that every comic has exactly N candidates",
    )
    ap.add_argument("--expected-story", type=int, default=None, metavar="N")
    ap.add_argument("--expected-gag", type=int, default=None, metavar="N")
    args = ap.parse_args()

    version = args.version.lstrip("v")
    tag = f"v{version}"

    repo_root = find_repo_root()

    raw_path = (
        Path(args.raw)
        if args.raw
        else repo_root / f"versions/{tag}/4koma/generated-prompts.json"
    )
    out_dir = (
        Path(args.out_dir)
        if args.out_dir
        else repo_root / f"versions/{tag}/4koma/generated-prompts"
    )

    data = load_comics_json(raw_path)
    comics = data["comics"]

    out_dir.mkdir(parents=True, exist_ok=True)

    series_text = str(data.get("series", "")).strip()
    (out_dir / "series.md").write_text(
        f"# {tag} 发布漫画系列\n\n{series_text}\n", encoding="utf-8"
    )

    wv_path = repo_root / "4koma/prompt-01.worldview.prompt.md"
    worldview = wv_path.read_text(encoding="utf-8").rstrip() if wv_path.exists() else ""
    bo = read_src(repo_root, "4koma/prompt-04.bo.prompt.md")

    written: list[Path] = []

    for idx, comic in enumerate(comics):
        comic_id = safe_id(str(comic.get("id") or ""), idx)
        comic_dir = out_dir / comic_id
        comic_dir.mkdir(parents=True, exist_ok=True)

        layouts = [LAYOUT_ALIASES.get(l, l) for l in as_list(comic.get("layouts"))]
        if not layouts:
            sys.exit(f"error: {comic_id}: layouts must contain at least one layout file")
        for layout in layouts:
            if layout not in ALLOWED_LAYOUTS:
                sys.exit(f"error: {comic_id}: unsupported layout file: {layout}")

        layout_text = "## 页面布局设定\n\n" + "\n\n---\n\n".join(
            read_src(repo_root, layout) for layout in layouts
        )

        updates = as_list(comic.get("updates"))
        candidates = comic.get("candidates")
        if not isinstance(candidates, list):
            candidates = []

        if args.expected_candidates is not None:
            if len(candidates) != args.expected_candidates:
                sys.exit(
                    f"error: {comic_id}: expected {args.expected_candidates} "
                    f"candidate(s), got {len(candidates)}"
                )
        if args.expected_story is not None:
            story_n = sum(
                1 for c in candidates if str(c.get("tone") or "").lower() == "story"
            )
            gag_n = sum(
                1 for c in candidates if str(c.get("tone") or "").lower() == "gag"
            )
            exp_gag = args.expected_gag or 0
            if story_n != args.expected_story or gag_n != exp_gag:
                sys.exit(
                    f"error: {comic_id}: expected {args.expected_story} story and "
                    f"{exp_gag} gag, got {story_n} story and {gag_n} gag"
                )

        # JSON 是唯一事实来源：先清掉旧的 prompt.md（改标题或改编号规则后会残留），生成的图片不动。
        for stale in comic_dir.glob("*.prompt.md"):
            stale.unlink()

        stems = candidate_stems(comic, candidates)
        for ci, candidate in enumerate(candidates):
            title = str(
                candidate.get("title") or comic.get("title") or f"剧情{ci + 1}"
            ).strip()
            tone = str(candidate.get("tone") or "").lower()
            dialogue = as_list(candidate.get("dialogue"))
            prompt_text = str(candidate.get("prompt") or "").strip()
            where = f"{comic_id}/candidate {ci + 1}"

            if not prompt_text:
                sys.exit(f"error: {where}: prompt is empty")

            prompt_text = strip_dialogue(prompt_text)
            characters = candidate_characters(repo_root, candidate, where)

            body = build_body(
                worldview=worldview,
                layout_text=layout_text,
                comic=comic,
                candidate=candidate,
                updates=updates,
                characters=characters,
                prompt_text=prompt_text,
                dialogue=dialogue,
                bo=bo,
                title=title,
                tone=tone,
            )

            stem = stems[ci]
            out_path = comic_dir / f"{stem}.prompt.md"
            out_path.write_text(body, encoding="utf-8")
            written.append(out_path)

    out = f"\nSplit prompt files ({len(written)}):\n"
    out += "\n".join(str(p) for p in sorted(written))
    sys.stdout.buffer.write((out + "\n").encode("utf-8", errors="replace"))


if __name__ == "__main__":
    main()
