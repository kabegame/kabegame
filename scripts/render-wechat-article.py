#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import json
import shutil
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote


def read_utf8(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_utf8_no_bom(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")


def escape_html(value: Any) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def escape_attribute(value: Any) -> str:
    return escape_html(value).replace("'", "&#39;")


def latest_article_path(repo_root: Path) -> Path:
    root = repo_root / "ignore" / "wechat-daily-codex"
    found = sorted(
        root.rglob("article.json") if root.exists() else [],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not found:
        raise RuntimeError(f"No article.json found under {root}")
    return found[0]


def value_or_empty(value: Any) -> str:
    return "" if value is None else str(value)


def image_list(article: dict[str, Any]) -> list[dict[str, Any]]:
    selected = article.get("selected_images") or []
    return [item for item in selected if isinstance(item, dict)]


def asset_file_name(image: dict[str, Any], index: int) -> str:
    ext = ".jpg"
    local_path = value_or_empty(image.get("local_path"))
    if local_path:
        path_ext = Path(local_path).suffix
        if path_ext.strip():
            ext = path_ext
    return f"{index:02d}-{image.get('id')}{ext}"


def file_uri(path: Path) -> str:
    return path.resolve().as_uri()


def windows_file_uri(path_text: str) -> str:
    normalized = path_text.replace("\\", "/")
    return "file:///" + quote(normalized)


def markdown_image_path(image_src: str) -> str:
    if len(image_src) >= 3 and image_src[1:3] == ":\\" and image_src[0].isalpha():
        return windows_file_uri(image_src)
    return image_src.replace("\\", "/")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render a generated WeChat article JSON to Markdown, preview HTML, and upload manifest."
    )
    parser.add_argument("--article-path", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--no-copy-images", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent

    article_path = (
        Path(args.article_path).resolve()
        if args.article_path.strip()
        else latest_article_path(repo_root).resolve()
    )
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir.strip()
        else article_path.parent.resolve()
    )
    if not output_dir.exists():
        raise RuntimeError(f"Output directory does not exist: {output_dir}")

    article: dict[str, Any] = json.loads(read_utf8(article_path))
    assets_dir = output_dir / "assets"
    if not args.no_copy_images:
        assets_dir.mkdir(parents=True, exist_ok=True)

    render_items: list[dict[str, Any]] = []
    upload_items: list[dict[str, Any]] = []

    for index, image in enumerate(image_list(article), start=1):
        asset_name = asset_file_name(image, index)
        local_path_text = value_or_empty(image.get("local_path"))
        local_path = Path(local_path_text) if local_path_text else None
        image_src = value_or_empty(image.get("image_uri"))
        copied_path: Path | None = None
        exists = bool(local_path and local_path.exists())

        if local_path and exists:
            if args.no_copy_images:
                image_src = file_uri(local_path)
            else:
                copied_path = assets_dir / asset_name
                shutil.copy2(local_path, copied_path)
                image_src = f"assets/{asset_name}"

        render_items.append(
            {
                "image": image,
                "index": index,
                "image_src": image_src,
                "markdown_image_src": markdown_image_path(image_src),
                "local_exists": exists,
                "copied_path": str(copied_path) if copied_path else None,
            }
        )
        upload_items.append(
            {
                "id": value_or_empty(image.get("id")),
                "local_path": local_path_text,
                "copied_path": str(copied_path) if copied_path else None,
                "exists": exists,
                "caption": value_or_empty(image.get("caption")),
                "source_url": image.get("source_url"),
                "author": image.get("author"),
                "risk_level": value_or_empty(image.get("risk_level")),
                "risk_notes": image.get("risk_notes") or [],
            }
        )

    markdown_lines = [
        f"# {value_or_empty(article.get('title'))}",
        "",
        f"> {value_or_empty(article.get('digest'))}",
        "",
        value_or_empty(article.get("opening")),
        "",
    ]

    for item in render_items:
        image = item["image"]
        markdown_lines.extend(
            [
                f"![{value_or_empty(image.get('caption'))}]({item['markdown_image_src']})",
                "",
                value_or_empty(image.get("caption")),
            ]
        )
        if image.get("author") or image.get("source_url"):
            source_parts = []
            if image.get("author"):
                source_parts.append(f"Author: {image.get('author')}")
            if image.get("source_url"):
                source_parts.append(f"Source: {image.get('source_url')}")
            markdown_lines.extend(["", " | ".join(source_parts)])
        markdown_lines.append("")

    markdown_lines.append(value_or_empty(article.get("closing")))
    markdown_path = output_dir / "article.draft.md"
    write_utf8_no_bom(markdown_path, "\n".join(markdown_lines) + "\n")

    body_sections: list[str] = [f"<p>{escape_html(article.get('opening'))}</p>"]
    for item in render_items:
        image = item["image"]
        risk_class = "risk-ok" if image.get("risk_level") == "ok" else "risk-review"
        risk_notes = image.get("risk_notes") or []
        risk_text = escape_html(image.get("risk_level"))
        if risk_notes:
            risk_text = f"{risk_text} - {escape_html('; '.join(str(note) for note in risk_notes))}"
        body_sections.extend(
            [
                "<section class='image-block'>",
                f"  <img src='{escape_attribute(item['image_src'])}' alt='{escape_attribute(image.get('caption'))}' />",
                f"  <p class='caption'>{escape_html(image.get('caption'))}</p>",
                f"  <p class='source'>Author: {escape_html(image.get('author'))} | Source: {escape_html(image.get('source_url'))}</p>",
                f"  <p class='risk {risk_class}'>Risk: {risk_text}</p>",
                "</section>",
            ]
        )
    body_sections.append(f"<p>{escape_html(article.get('closing'))}</p>")
    body_html = "\n".join(body_sections)

    risk_items = "\n".join(
        f"<li>{escape_html(item)}</li>" for item in (article.get("risk_summary") or [])
    )

    html_doc = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape_html(article.get('title'))}</title>
  <style>
    :root {{ color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0; background: #f5f5f3; color: #222; }}
    main {{ max-width: 720px; margin: 0 auto; background: #fff; min-height: 100vh; padding: 32px 22px 56px; box-sizing: border-box; }}
    h1 {{ font-size: 28px; line-height: 1.32; margin: 0 0 12px; font-weight: 700; }}
    .digest {{ color: #666; font-size: 15px; line-height: 1.7; margin: 0 0 24px; }}
    p {{ font-size: 16px; line-height: 1.9; margin: 0 0 18px; }}
    .meta {{ font-size: 13px; color: #777; border-top: 1px solid #eee; border-bottom: 1px solid #eee; padding: 12px 0; margin-bottom: 24px; }}
    .image-block {{ margin: 28px 0 34px; }}
    img {{ display: block; width: 100%; height: auto; border-radius: 6px; background: #eee; }}
    .caption {{ margin: 12px 0 6px; color: #333; }}
    .source {{ margin: 0 0 6px; font-size: 13px; color: #777; word-break: break-all; }}
    .risk {{ margin: 0; font-size: 13px; }}
    .risk-ok {{ color: #4f7d4a; }}
    .risk-review {{ color: #a66600; }}
    .review-box {{ margin-top: 36px; padding: 16px; background: #fff8e5; border: 1px solid #f0d28a; border-radius: 6px; }}
    .review-box h2 {{ font-size: 16px; margin: 0 0 10px; }}
    .review-box ul {{ margin: 0; padding-left: 20px; color: #6f5200; line-height: 1.7; }}
  </style>
</head>
<body>
  <main>
    <h1>{escape_html(article.get('title'))}</h1>
    <p class="digest">{escape_html(article.get('digest'))}</p>
    <div class="meta">
      Date: {escape_html(article.get('run_date'))}<br>
      Theme: {escape_html(article.get('theme'))}<br>
      Status: {escape_html(article.get('status'))}, candidates: {escape_html(article.get('candidate_count'))}, usable: {escape_html(article.get('usable_count'))}
    </div>
    {body_html}
    <aside class="review-box">
      <h2>Pre-publish review</h2>
      <ul>
        {risk_items}
      </ul>
    </aside>
  </main>
</body>
</html>
"""

    preview_path = output_dir / "preview.html"
    write_utf8_no_bom(preview_path, html_doc)

    wechat_body = f"""<h1>{escape_html(article.get('title'))}</h1>
<p>{escape_html(article.get('opening'))}</p>
{body_html}
"""
    wechat_html_path = output_dir / "wechat-content.html"
    write_utf8_no_bom(wechat_html_path, wechat_body)

    manifest = {
        "title": value_or_empty(article.get("title")),
        "digest": value_or_empty(article.get("digest")),
        "run_date": value_or_empty(article.get("run_date")),
        "cover_image_id": value_or_empty(article.get("cover_image_id")),
        "article_json": str(article_path),
        "preview_html": str(preview_path),
        "draft_markdown": str(markdown_path),
        "wechat_content_html": str(wechat_html_path),
        "images": upload_items,
    }
    manifest_path = output_dir / "upload-manifest.json"
    write_utf8_no_bom(
        manifest_path,
        json.dumps(manifest, ensure_ascii=False, indent=2),
    )

    print("Rendered article draft:")
    print(f"  Markdown: {markdown_path}")
    print(f"  Preview:  {preview_path}")
    print(f"  WeChat HTML body: {wechat_html_path}")
    print(f"  Upload manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
