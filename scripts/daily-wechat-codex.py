#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


def join_provider_path(*segments: str) -> str:
    return "/".join(segment.strip("/") for segment in segments if segment.strip("/"))


def write_utf8_no_bom(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")


def read_utf8(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_date(value: str) -> datetime:
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass
    raise argparse.ArgumentTypeError(
        f"invalid date {value!r}; expected YYYY-MM-DD, YYYY/MM/DD, or YYYYMMDD"
    )


def resolve_command(command: str) -> str | None:
    expanded = os.path.expandvars(os.path.expanduser(command)).strip()
    if expanded:
        command_path = Path(expanded)
        if command_path.is_file():
            return str(command_path)
        found = shutil.which(expanded)
        if found:
            return found

    for candidate in (
        os.environ.get("CODEX_COMMAND", ""),
        "/Applications/Codex.app/Contents/Resources/codex",
    ):
        candidate = os.path.expandvars(os.path.expanduser(candidate)).strip()
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def build_schema(max_images: int) -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "required": [
            "status",
            "run_date",
            "target_path",
            "source_paths",
            "mcp_reads",
            "fallback_used",
            "fallback_reason",
            "candidate_count",
            "usable_count",
            "title",
            "digest",
            "theme",
            "cover_image_id",
            "opening",
            "selected_images",
            "closing",
            "risk_summary",
            "article_markdown",
            "error_message",
        ],
        "properties": {
            "status": {
                "type": "string",
                "enum": ["ok", "insufficient_data", "mcp_error"],
            },
            "run_date": {"type": "string"},
            "target_path": {"type": "string"},
            "source_paths": {
                "type": "array",
                "items": {"type": "string"},
            },
            "mcp_reads": {
                "type": "array",
                "items": {"type": "string"},
            },
            "fallback_used": {"type": "boolean"},
            "fallback_reason": {"type": ["string", "null"]},
            "candidate_count": {"type": "integer", "minimum": 0},
            "usable_count": {"type": "integer", "minimum": 0},
            "title": {"type": "string"},
            "digest": {"type": "string"},
            "theme": {"type": "string"},
            "cover_image_id": {"type": ["string", "null"]},
            "opening": {"type": "string"},
            "selected_images": {
                "type": "array",
                "minItems": 0,
                "maxItems": max_images,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "id",
                        "image_uri",
                        "provider_path",
                        "display_name",
                        "plugin_id",
                        "local_path",
                        "metadata_summary",
                        "source_url",
                        "author",
                        "caption",
                        "selection_reason",
                        "risk_level",
                        "risk_notes",
                    ],
                    "properties": {
                        "id": {"type": "string"},
                        "image_uri": {"type": "string"},
                        "provider_path": {"type": "string"},
                        "display_name": {"type": ["string", "null"]},
                        "plugin_id": {"type": ["string", "null"]},
                        "local_path": {"type": ["string", "null"]},
                        "metadata_summary": {"type": "string"},
                        "source_url": {"type": ["string", "null"]},
                        "author": {"type": ["string", "null"]},
                        "caption": {"type": "string"},
                        "selection_reason": {"type": "string"},
                        "risk_level": {
                            "type": "string",
                            "enum": ["ok", "review", "reject"],
                        },
                        "risk_notes": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
            },
            "closing": {"type": "string"},
            "risk_summary": {
                "type": "array",
                "items": {"type": "string"},
            },
            "article_markdown": {"type": "string"},
            "error_message": {"type": ["string", "null"]},
        },
    }


def build_prompt(
    run_date: str,
    target_path: str | None,
    base_path: str,
    min_images: int,
    max_images: int,
    page_size: int,
    max_fallback_days: int,
) -> str:
    target_setting = target_path or f"auto: latest available date under {base_path}"
    if target_path:
        workflow = f"""1. First read the requested date path:
   provider://{target_path}/desc/x{page_size}x/1/?without=children
2. If this path has fewer than {min_images} usable images, discover recent available date folders yourself:
   - read provider://{base_path}/?without=images for years
   - read provider://{base_path}/{{year}}/?without=images for months
   - read provider://{base_path}/{{year}}/{{month}}/?without=images for days
   - scan newest days first with provider://{base_path}/{{year}}/{{month}}/{{day}}/desc/x{page_size}x/1/?without=children
   - stop once you have enough good candidates or after {max_fallback_days} day folders"""
    else:
        workflow = f"""1. Do not assume today's folder has images. Discover the latest available date folders first:
   - read provider://{base_path}/?without=images for years
   - read provider://{base_path}/{{year}}/?without=images for months
   - read provider://{base_path}/{{year}}/{{month}}/?without=images for days
   - sort date folders by actual date descending
2. Starting with the newest available day, scan recent dated image paths:
   provider://{base_path}/{{year}}/{{month}}/{{day}}/desc/x{page_size}x/1/?without=children
   Continue newest-to-older until you have enough good candidates or after {max_fallback_days} day folders.
3. Set target_path in the JSON output to the newest dated provider path that contributed candidates."""

    return f"""You are the daily editor for a WeChat Official Account that shares curated visual-asset/image posts from a local Kabegame gallery.

Use the configured Kabegame MCP server. Read only. Do not run shell commands, do not edit files, do not call WeChat APIs, and do not publish anything.

Your output must be valid JSON matching the provided schema. Do not wrap it in Markdown fences.

Run settings:
- run_date: {run_date}
- target_path: {target_setting}
- minimum useful images: {min_images}
- maximum selected images: {max_images}
- page size for MCP image reads: {page_size}
- maximum recent date folders to scan: {max_fallback_days}

Kabegame MCP provider rules:
- Use provider:// paths.
- The shorthand provider://hide/date/... maps to the gallery path /gallery/hide/date/... and excludes hidden images.
- To get image entries from a dated path, use an explicit paged image slice:
  provider://<path>/desc/x{page_size}x/1/?without=children
- To inspect folders only, use:
  provider://<path>/?without=images
- Directory names are date segments such as 2026y, 05m, 09d. Sort them numerically, not lexicographically by the whole string.
- For selected images, read image://{{id}}/metadata to summarize source/author/tags when available.
- Do not request provider://plugin/*.

Workflow:
{workflow}
4. Prefer images that are local, exist locally, are type=image, have reasonable dimensions, and have usable source metadata.
5. Exclude or mark as reject/review anything that appears unsafe for a public WeChat post, has missing or suspicious source data, appears NSFW, or looks like it may involve minors.
6. Do not invent author names, source URLs, titles, or licensing. Use null when unknown.
7. Produce a concise Chinese article plan:
   - natural title, not clickbait
   - digest under 54 Chinese characters when possible
   - opening paragraph
   - one short caption per selected image
   - closing paragraph
   - article_markdown that can later be rendered into WeChat HTML
8. Include every MCP URI you read in mcp_reads. Include every dated provider image path that contributed candidates in source_paths.

If MCP access fails, output status="mcp_error" and put the error in error_message. If there are not enough acceptable images after recent-day scanning, output status="insufficient_data", keep the usable selections, and explain the shortfall in fallback_reason.
"""


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a daily WeChat article JSON with Codex and Kabegame MCP."
    )
    parser.add_argument(
        "--date",
        type=parse_date,
        default=datetime.now(),
        help="Run date for artifact naming; gallery selection uses recent folders unless --target-path is set.",
    )
    parser.add_argument("--base-path", default="hide/date")
    parser.add_argument("--target-path", default="")
    parser.add_argument("--min-images", type=int, default=6)
    parser.add_argument("--max-images", type=int, default=10)
    parser.add_argument("--page-size", type=int, default=40)
    parser.add_argument("--max-fallback-days", type=int, default=7)
    parser.add_argument("--output-root", default="ignore/wechat-daily-codex")
    parser.add_argument("--codex-command", default="codex")
    parser.add_argument("--model", default="")
    parser.add_argument("--skip-mcp-check", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent

    target_path = args.target_path.strip("/") or None
    run_date = f"{args.date:%Y-%m-%d}"
    run_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = repo_root / args.output_root / f"{run_date}-{run_stamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    schema_path = output_dir / "daily-wechat.schema.json"
    prompt_path = output_dir / "daily-wechat.prompt.md"
    article_path = output_dir / "article.json"

    write_utf8_no_bom(
        schema_path,
        json.dumps(build_schema(args.max_images), ensure_ascii=False, indent=2),
    )
    write_utf8_no_bom(
        prompt_path,
        build_prompt(
            run_date,
            target_path,
            args.base_path,
            args.min_images,
            args.max_images,
            args.page_size,
            args.max_fallback_days,
        ),
    )

    print(f"Prompt: {prompt_path}")
    print(f"Schema: {schema_path}")
    print(f"Output: {article_path}")

    if args.dry_run:
        print("Dry run only. Codex was not invoked.")
        return 0

    codex = resolve_command(args.codex_command)
    if not codex:
        raise RuntimeError(
            f"Codex command not found: {args.codex_command}. "
            "Shell aliases are not visible to Python; pass "
            "--codex-command /Applications/Codex.app/Contents/Resources/codex "
            "or set CODEX_COMMAND to the real executable path."
        )

    if not args.skip_mcp_check:
        mcp_check = subprocess.run(
            [codex, "mcp", "get", "kabegame"],
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
        if mcp_check.returncode != 0:
            print(
                "Warning: Could not confirm Codex MCP server 'kabegame'. "
                "Codex may fail to read Kabegame resources.",
                file=sys.stderr,
            )
            print((mcp_check.stdout + mcp_check.stderr).strip(), file=sys.stderr)

    codex_args = [
        codex,
        "--ask-for-approval",
        "never",
        "exec",
        "-C",
        str(repo_root),
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--color",
        "never",
        "--output-schema",
        str(schema_path),
        "-o",
        str(article_path),
    ]
    if args.model.strip():
        codex_args.extend(["-m", args.model])
    codex_args.append("-")

    result = subprocess.run(
        codex_args,
        cwd=repo_root,
        input=read_utf8(prompt_path),
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"codex exec failed with exit code {result.returncode}")

    try:
        article = json.loads(read_utf8(article_path))
    except json.JSONDecodeError as exc:
        error_path = output_dir / "article.validation-error.txt"
        write_utf8_no_bom(error_path, str(exc))
        raise RuntimeError(
            f"Codex wrote a non-JSON result to {article_path}. "
            f"Parser details were saved to {error_path}"
        ) from exc

    selected_count = len(article.get("selected_images") or [])
    if article.get("status") == "ok" and selected_count < args.min_images:
        print(
            f"Warning: Codex returned status=ok but selected only {selected_count} "
            f"images; expected at least {args.min_images}.",
            file=sys.stderr,
        )

    print(f"Codex article status: {article.get('status')}")
    print(f"Selected images: {selected_count}")
    print(f"Article JSON: {article_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
