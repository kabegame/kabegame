#!/usr/bin/env python3
"""Reference implementation / oracle for Phase 1's `check_for_updates`.

Reimplements the Rust `updater::{github::compute_missed, asset::match_asset}`
logic in Python and prints a JSON object whose shape matches the Rust
`UpdateCheckResult` (serde camelCase). Use it to diff against what the Tauri
command returns for the same args.

Usage:
    python3 test/auto-update/check_update.py --current 4.0.0 --platform macos --mode standard --arch aarch64
    python3 test/auto-update/check_update.py --current 4.1.1 --platform windows --mode light --arch x64
    python3 test/auto-update/check_update.py --current 3.9.0   # platform/arch auto-detected
"""
import argparse
import json
import platform as _platform
import sys
import urllib.request
import urllib.error

DEFAULT_REPO = "kabegame/kabegame"
API = "https://api.github.com/repos/{repo}/releases?per_page={per_page}"
MAX_RELEASES = 5


# --- env detection (mirrors updater/mod.rs cfg helpers) ----------------------

def detect_platform() -> str:
    s = sys.platform
    if s.startswith("win"):
        return "windows"
    if s == "darwin":
        return "macos"
    return "linux"


def detect_arch() -> str:
    m = _platform.machine().lower()
    if m in ("x86_64", "amd64"):
        return "x64"
    if m in ("arm64", "aarch64"):
        return "aarch64"
    return m


# --- network (same headers as fetch_releases.py / the Rust client) -----------

def fetch_releases(repo: str, per_page: int, token: str | None):
    url = API.format(repo=repo, per_page=per_page)
    req = urllib.request.Request(url)
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


# --- Phase 1 logic (must match asset.rs / github.rs) -------------------------

def match_asset(assets: list[dict], plat: str, mode: str, arch: str):
    """Return (name, url) of the asset for this platform/mode/arch, else None."""
    mode_token = "-light_" if mode == "light" else "-standard_"
    for a in assets:
        name = a.get("name") or ""
        if mode_token not in name:
            continue
        if plat == "windows":
            ok = name.endswith("-setup.exe") and arch in name
        elif plat == "macos":
            ok = name.endswith(".dmg") and arch in name
        elif plat == "linux":
            ok = name.endswith(".deb") and "amd64" in name
        else:
            ok = False
        if ok:
            return name, a.get("browser_download_url")
    return None


def to_release_info(r: dict, plat: str, mode: str, arch: str) -> dict:
    matched = match_asset(r.get("assets", []), plat, mode, arch)
    tag = r.get("tag_name") or ""
    return {
        "tag": tag,
        "name": r.get("name") or tag,
        "body": r.get("body") or "",
        "htmlUrl": r.get("html_url") or "",
        "publishedAt": r.get("published_at") or "",
        "assetUrl": matched[1] if matched else None,
        "assetName": matched[0] if matched else None,
    }


def norm_tag(tag: str) -> str:
    """Tags are `v4.1.1`; CARGO_PKG_VERSION is `4.1.1`. Compare without the `v`."""
    return tag[1:] if tag.startswith("v") else tag


def compute_missed(current: str, raw_list: list[dict], plat: str, mode: str,
                   arch: str, max_releases: int) -> list[dict]:
    cur = norm_tag(current)
    out: list[dict] = []
    for r in raw_list:                 # GitHub returns newest first
        if r.get("draft"):
            continue                   # skip drafts
        if norm_tag(r.get("tag_name") or "") == cur:
            break                      # reached the running version; older ones follow
        out.append(to_release_info(r, plat, mode, arch))
        if len(out) == max_releases:
            break
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Oracle for check_for_updates (Phase 1)")
    ap.add_argument("--current", required=True, help="current app version, e.g. 4.0.0")
    ap.add_argument("--platform", choices=["windows", "macos", "linux"], default=detect_platform())
    ap.add_argument("--mode", choices=["standard", "light"], default="standard")
    ap.add_argument("--arch", choices=["x64", "aarch64"], default=detect_arch())
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--per-page", type=int, default=30)
    ap.add_argument("--max", type=int, default=MAX_RELEASES)
    ap.add_argument("--token", default=None)
    args = ap.parse_args()

    raw = fetch_releases(args.repo, args.per_page, args.token)
    if not isinstance(raw, list):
        sys.exit(f"Unexpected response: {json.dumps(raw)[:300]}")

    releases = compute_missed(args.current, raw, args.platform, args.mode, args.arch, args.max)
    result = {
        "currentVersion": args.current,
        "platform": args.platform,
        "mode": args.mode,
        "arch": args.arch,
        "hasUpdate": len(releases) > 0,
        "downloadable": bool(releases and releases[0]["assetUrl"]),
        "releases": releases,
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
