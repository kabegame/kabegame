#!/usr/bin/env python3
"""
Compose 4 single-panel images onto the 4masu PSD template.

Panel slots are read from layers named '01', '02', '03', '04'.
The PSD is composited with those layers hidden to produce the frame overlay.

Usage:
  python scripts/compose-comic.py PANEL_TL PANEL_TR PANEL_BL PANEL_BR [options]

  Panels in reading order: top-left, top-right, bottom-left, bottom-right.

Options:
  --template FILE   PSD template (default: 4masu/template.psd)
  --out FILE        Output PNG (default: comic.png next to first panel)
  --fit cover|contain|stretch
                    cover   — fill slot, crop excess (default)
                    contain — fit inside, letterbox
                    stretch — ignore aspect ratio
  --output-size WxH Scale output, e.g. --output-size 3072x2048
  --tl/--tr/--bl/--br FILE
                    Name panels explicitly instead of positional args
  --show-regions    Print slot coordinates and exit
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("error: Pillow is required.\n  pip install Pillow")

try:
    import psd_tools
except ImportError:
    sys.exit("error: psd-tools is required.\n  pip install psd-tools")


# ---------------------------------------------------------------------------
# PSD loading
# ---------------------------------------------------------------------------

def load_psd(psd_path: Path) -> tuple[Image.Image, list[tuple[int,int,int,int]]]:
    """
    Open a PSD and return (frame_RGBA, [tl_bbox, tr_bbox, bl_bbox, br_bbox]).

    The frame is the PSD composited with the 4 placeholder layers hidden —
    it provides the decorative border that will float on top of the panels.
    The bboxes are the exact (left, top, right, bottom) of each placeholder layer.
    """
    psd = psd_tools.PSDImage.open(str(psd_path))

    # Find placeholder layers by name ('01'…'04', or fallback to the 4 non-canvas layers)
    slot_names = {"01", "02", "03", "04", "1", "2", "3", "4"}
    slots: list[object] = []
    for layer in psd:
        if layer.name.strip() in slot_names:
            slots.append(layer)

    if len(slots) < 4:
        canvas_area = psd.width * psd.height
        candidates = [
            l for l in psd
            if (l.right - l.left) * (l.bottom - l.top) < canvas_area
        ]
        if len(candidates) < 4:
            sys.exit(
                f"error: found only {len(candidates)} non-canvas layers in {psd_path}.\n"
                "Expected layers named 01, 02, 03, 04."
            )
        slots = sorted(candidates, key=lambda l: (l.top, l.left))[:4]

    # Sort slots in reading order
    slots = sorted(slots, key=lambda l: (l.top, l.left))
    regions: list[tuple[int,int,int,int]] = [
        (l.left, l.top, l.right, l.bottom) for l in slots
    ]

    # Render frame with slots hidden
    for layer in slots:
        layer.visible = False
    frame_img = psd.composite()
    if frame_img is None:
        frame_img = Image.new("RGBA", (psd.width, psd.height), (240, 220, 255, 255))

    return frame_img.convert("RGBA"), regions


# ---------------------------------------------------------------------------
# Image fitting
# ---------------------------------------------------------------------------

def fit_image(src: Image.Image, slot_w: int, slot_h: int, mode: str) -> Image.Image:
    sw, sh = src.size
    if mode == "stretch":
        return src.resize((slot_w, slot_h), Image.LANCZOS)
    src_ratio = sw / sh
    slot_ratio = slot_w / slot_h
    if mode == "cover":
        if src_ratio > slot_ratio:
            new_h, new_w = slot_h, int(sw * slot_h / sh)
        else:
            new_w, new_h = slot_w, int(sh * slot_w / sw)
        resized = src.resize((new_w, new_h), Image.LANCZOS)
        return resized.crop(
            ((new_w - slot_w) // 2, (new_h - slot_h) // 2,
             (new_w - slot_w) // 2 + slot_w, (new_h - slot_h) // 2 + slot_h)
        )
    # contain
    if src_ratio > slot_ratio:
        new_w, new_h = slot_w, int(sh * slot_w / sw)
    else:
        new_h, new_w = slot_h, int(sw * slot_h / sh)
    resized = src.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (slot_w, slot_h), (255, 255, 255, 0))
    canvas.paste(resized, ((slot_w - new_w) // 2, (slot_h - new_h) // 2))
    return canvas


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def find_repo_root() -> Path:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--show-toplevel"], stderr=subprocess.DEVNULL
        )
        return Path(out.decode().strip())
    except Exception:
        return Path.cwd()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Compose 4 panels into the 4masu PSD template"
    )
    ap.add_argument("panels", nargs="*", metavar="PANEL",
                    help="4 panel images: tl tr bl br")
    ap.add_argument("--tl", metavar="FILE")
    ap.add_argument("--tr", metavar="FILE")
    ap.add_argument("--bl", metavar="FILE")
    ap.add_argument("--br", metavar="FILE")
    ap.add_argument("--template", metavar="FILE",
                    help="PSD template (default: 4masu/template.psd)")
    ap.add_argument("--out", metavar="FILE", help="Output PNG")
    ap.add_argument("--fit", choices=["cover", "contain", "stretch"], default="cover")
    ap.add_argument("--output-size", metavar="WxH",
                    help="Scale output, e.g. 3072x2048")
    ap.add_argument("--show-regions", action="store_true",
                    help="Print slot regions and exit")
    args = ap.parse_args()

    # Resolve panels
    panel_paths: list[Path] = []
    if args.tl or args.tr or args.bl or args.br:
        for flag, name in [(args.tl, "tl"), (args.tr, "tr"),
                           (args.bl, "bl"), (args.br, "br")]:
            if not flag:
                sys.exit(f"error: --{name} is required when using named flags")
            panel_paths.append(Path(flag))
    elif args.panels:
        panel_paths = [Path(p) for p in args.panels]
    elif not args.show_regions:
        ap.print_help()
        sys.exit(1)

    if not args.show_regions:
        if len(panel_paths) != 4:
            sys.exit(f"error: exactly 4 panels required, got {len(panel_paths)}")
        for p in panel_paths:
            if not p.exists():
                sys.exit(f"error: panel not found: {p}")

    # Resolve template
    repo_root = find_repo_root()
    template_path = (
        Path(args.template) if args.template
        else repo_root / "4masu/template.psd"
    )
    if not template_path.exists():
        sys.exit(f"error: template not found: {template_path}")
    if template_path.suffix.lower() != ".psd":
        sys.exit(f"error: template must be a PSD file, got: {template_path}")

    # Default output
    if args.out:
        out_path = Path(args.out)
    elif panel_paths:
        out_path = panel_paths[0].parent / "comic.png"
    else:
        out_path = Path("comic.png")

    # Load PSD
    frame, regions_orig = load_psd(template_path)
    tw, th = frame.size

    # Scale
    sx = sy = 1.0
    if args.output_size:
        try:
            ow, oh = (int(x) for x in re.split(r"[xX×]", args.output_size))
        except ValueError:
            sys.exit("error: --output-size must be WxH")
        sx, sy = ow / tw, oh / th
        tw, th = ow, oh
        frame = frame.resize((tw, th), Image.LANCZOS)

    regions = [
        (int(x1*sx), int(y1*sy), int(x2*sx), int(y2*sy))
        for x1, y1, x2, y2 in regions_orig
    ]

    if args.show_regions:
        print(f"Template: {template_path}  ({tw}×{th})")
        for label, (x1, y1, x2, y2) in zip(
            ["top-left", "top-right", "bottom-left", "bottom-right"], regions
        ):
            print(f"  {label}: ({x1},{y1}) → ({x2},{y2})  slot {x2-x1}×{y2-y1}")
        rects = " ".join(f"{x1},{y1},{x2},{y2}" for x1, y1, x2, y2 in regions)
        print(f'\n  --panels-rects "{rects}"')
        sys.exit(0)

    # -----------------------------------------------------------------------
    # Composite:
    #   1. White canvas
    #   2. Paste panels at exact slot positions
    #   3. Cut panel-area holes in the frame (so panels show through)
    #   4. Alpha-composite the holey frame on top (border/flowers float above panels)
    # -----------------------------------------------------------------------
    canvas = Image.new("RGBA", (tw, th), (255, 255, 255, 255))

    for panel_path, (x1, y1, x2, y2) in zip(panel_paths, regions):
        slot_w, slot_h = x2 - x1, y2 - y1
        if slot_w <= 0 or slot_h <= 0:
            sys.exit(f"error: invalid slot ({x1},{y1})→({x2},{y2})")
        src = Image.open(panel_path).convert("RGBA")
        fitted = fit_image(src, slot_w, slot_h, args.fit)
        canvas.paste(fitted, (x1, y1))

    # Cut holes in frame at exact slot positions
    frame_overlay = frame.copy()
    for x1, y1, x2, y2 in regions:
        slot_w, slot_h = x2 - x1, y2 - y1
        frame_overlay.paste(
            Image.new("RGBA", (slot_w, slot_h), (0, 0, 0, 0)), (x1, y1)
        )

    canvas = Image.alpha_composite(canvas, frame_overlay)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out_path, "PNG", optimize=False)
    print(f"Saved: {out_path}  ({tw}×{th})")


if __name__ == "__main__":
    main()
