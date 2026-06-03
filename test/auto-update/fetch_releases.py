#!/usr/bin/env python3
"""Fetch kabegame GitHub releases and dump their shape.

Purpose: verify the real GitHub API response (field names, asset naming)
that the Rust `updater::github` parser (Phase 1) must match.

Usage:
    python3 test/auto-update/fetch_releases.py            # human table
    python3 test/auto-update/fetch_releases.py --json     # trimmed raw JSON
    python3 test/auto-update/fetch_releases.py --token $GITHUB_TOKEN
    python3 test/auto-update/fetch_releases.py --repo owner/name --per-page 10
"""
import argparse
import json
import sys
import urllib.request
import urllib.error

DEFAULT_REPO = "kabegame/kabegame"
API = "https://api.github.com/repos/{repo}/releases?per_page={per_page}"


def fetch_releases(repo: str, per_page: int, token: str | None):
    url = API.format(repo=repo, per_page=per_page)
    req = urllib.request.Request(url)
    # GitHub rejects requests without a User-Agent (403). Mirror the Rust client.
    req.add_header("User-Agent", "kabegame-updater")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} {e.reason}: {e.read().decode('utf-8', 'replace')[:300]}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error: {e.reason}")


def trim(release: dict) -> dict:
    """Keep only the fields Phase 1's RawRelease/RawAsset care about."""
    return {
        "tag_name": release.get("tag_name"),
        "name": release.get("name"),
        "draft": release.get("draft"),
        "prerelease": release.get("prerelease"),
        "published_at": release.get("published_at"),
        "html_url": release.get("html_url"),
        "body_len": len(release.get("body") or ""),
        "assets": [
            {
                "name": a.get("name"),
                "size": a.get("size"),
                "browser_download_url": a.get("browser_download_url"),
            }
            for a in release.get("assets", [])
        ],
    }


def print_table(releases: list[dict]) -> None:
    for r in releases:
        flags = []
        if r.get("draft"):
            flags.append("draft")
        if r.get("prerelease"):
            flags.append("prerelease")
        flag_str = f"  [{','.join(flags)}]" if flags else ""
        print(f"\n=== {r.get('tag_name')}  ({r.get('name') or '-'}){flag_str}")
        print(f"    published_at: {r.get('published_at')}")
        print(f"    html_url:     {r.get('html_url')}")
        print(f"    body length:  {len(r.get('body') or '')} chars")
        assets = r.get("assets", [])
        if not assets:
            print("    assets:       (none)")
            continue
        print("    assets:")
        for a in assets:
            size = a.get("size") or 0
            print(f"      - {a.get('name')}  ({size/1_048_576:.1f} MiB)")
            print(f"        {a.get('browser_download_url')}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Dump kabegame GitHub releases")
    ap.add_argument("--repo", default=DEFAULT_REPO, help=f"owner/name (default {DEFAULT_REPO})")
    ap.add_argument("--per-page", type=int, default=30)
    ap.add_argument("--token", default=None, help="GitHub token to raise rate limit")
    ap.add_argument("--json", action="store_true", help="print trimmed raw JSON instead of table")
    args = ap.parse_args()

    releases = fetch_releases(args.repo, args.per_page, args.token)
    if not isinstance(releases, list):
        sys.exit(f"Unexpected response: {json.dumps(releases)[:300]}")

    if args.json:
        print(json.dumps([trim(r) for r in releases], indent=2, ensure_ascii=False))
    else:
        print(f"Fetched {len(releases)} release(s) from {args.repo}")
        print_table(releases)


if __name__ == "__main__":
    main()
