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
  python scripts/regenerate-comic-prompts.py v4.2.0 --raw 4masu/v4.2.0/generated-prompts.json
  python scripts/regenerate-comic-prompts.py 4.2.0 --out-dir 4masu/v4.2.0/generated-prompts
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
    "4masu/layout-00-app-shell.prompt.md",
    "4masu/layout-01-gallery.prompt.md",
    "4masu/layout-02-filter-preview.prompt.md",
    "4masu/layout-03-albums.prompt.md",
    "4masu/layout-04-plugins.prompt.md",
    "4masu/layout-05-tasks-auto-configs.prompt.md",
    "4masu/layout-06-settings-help.prompt.md",
    "4masu/layout-07-mobile-compact.prompt.md",
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


def build_body(
    *,
    worldview: str,
    layout_text: str,
    comic: dict,
    candidate: dict,
    updates: list[str],
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
    parts += [layout_text, "", "---", "", f"# {title}", ""]
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
    parts += ["```text", prompt_text, "```", ""]
    if dialogue:
        parts.append("可选对白：\n" + "\n".join(f"- {d}" for d in dialogue) + "\n")
    parts += ["---", bo, ""]

    return "\n".join(p for p in parts if p != "") + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Regenerate comic .prompt.md files from a generated-prompts.json"
    )
    ap.add_argument("version", help="Release version, e.g. 4.2.0 or v4.2.0")
    ap.add_argument(
        "--raw",
        metavar="FILE",
        help="Path to raw JSON file (default: 4masu/vVERSION/generated-prompts.json)",
    )
    ap.add_argument(
        "--out-dir",
        metavar="DIR",
        help="Output directory (default: 4masu/vVERSION/generated-prompts)",
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
        else repo_root / f"4masu/{tag}/generated-prompts.json"
    )
    out_dir = (
        Path(args.out_dir)
        if args.out_dir
        else repo_root / f"4masu/{tag}/generated-prompts"
    )

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

    out_dir.mkdir(parents=True, exist_ok=True)

    series_text = str(data.get("series", "")).strip()
    (out_dir / "series.md").write_text(
        f"# {tag} 发布漫画系列\n\n{series_text}\n", encoding="utf-8"
    )

    wv_path = repo_root / "4masu/worldview.prompt.md"
    worldview = wv_path.read_text(encoding="utf-8").rstrip() if wv_path.exists() else ""
    bo = read_src(repo_root, "4masu/bo.prompt.md")

    written: list[Path] = []

    for idx, comic in enumerate(comics):
        comic_id = safe_id(str(comic.get("id") or ""), idx)
        comic_dir = out_dir / comic_id
        comic_dir.mkdir(parents=True, exist_ok=True)

        layouts = as_list(comic.get("layouts"))
        if not layouts:
            sys.exit(f"error: {comic_id}: layouts must contain at least one layout file")
        for layout in layouts:
            if layout not in ALLOWED_LAYOUTS:
                sys.exit(f"error: {comic_id}: unsupported layout file: {layout}")

        layout_text = "\n\n---\n\n".join(
            f"## 页面布局设定\n\n{read_src(repo_root, layout)}" for layout in layouts
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

        used: set[str] = set()
        for ci, candidate in enumerate(candidates):
            title = str(
                candidate.get("title") or comic.get("title") or f"剧情{ci + 1}"
            ).strip()
            tone = str(candidate.get("tone") or "").lower()
            dialogue = as_list(candidate.get("dialogue"))
            prompt_text = str(candidate.get("prompt") or "").strip()

            if not prompt_text:
                sys.exit(f"error: {comic_id}/candidate {ci + 1}: prompt is empty")

            prompt_text = strip_dialogue(prompt_text)

            body = build_body(
                worldview=worldview,
                layout_text=layout_text,
                comic=comic,
                candidate=candidate,
                updates=updates,
                prompt_text=prompt_text,
                dialogue=dialogue,
                bo=bo,
                title=title,
                tone=tone,
            )

            fallback_stem = str(candidate.get("id") or f"candidate-{ci + 1}")
            stem = safe_file_stem(title, fallback_stem)
            if stem in used:
                stem = f"{stem}-{ci + 1}"
            used.add(stem)

            out_path = comic_dir / f"{stem}.prompt.md"
            out_path.write_text(body, encoding="utf-8")
            written.append(out_path)

    out = f"\nSplit prompt files ({len(written)}):\n"
    out += "\n".join(str(p) for p in sorted(written))
    sys.stdout.buffer.write((out + "\n").encode("utf-8", errors="replace"))


if __name__ == "__main__":
    main()
