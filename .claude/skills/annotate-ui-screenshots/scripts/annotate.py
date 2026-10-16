#!/usr/bin/env python3
"""用 ImageMagick 为真实 UI 截图叠加标签和箭头。"""

from __future__ import annotations

import argparse
import glob
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_STYLE: dict[str, Any] = {
    "label_fill": "#7c3aedE8",
    "label_border": "#ffffff66",
    "text_fill": "white",
    "arrow_fill": "#ff4fa3",
    "point_size": 34,
    "border_width": 2,
    "stroke_width": 6,
    "radius": 24,
    "arrowhead_length": 26,
    "arrowhead_width": 14,
}


def fail(message: str) -> None:
    raise SystemExit(f"错误：{message}")


def run(command: list[str]) -> str:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return result.stdout.strip()


def image_size(magick: str, path: Path) -> tuple[int, int]:
    raw = run([magick, "identify", "-format", "%w %h", str(path)])
    width, height = raw.split()
    return int(width), int(height)


def resolve_font(explicit: str | None) -> str | None:
    if explicit:
        font = Path(explicit).expanduser()
        if not font.is_file():
            fail(f"字体不存在：{font}")
        return str(font)

    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
    ]
    candidates.extend(
        glob.glob("/System/Library/AssetsV2/com_apple_MobileAsset_Font8/*/AssetData/PingFang.ttc")
    )
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate

    fc_match = shutil.which("fc-match")
    if fc_match:
        for family in ("Noto Sans CJK SC", "Source Han Sans SC", "sans-serif"):
            matched = run([fc_match, "-f", "%{file}", family])
            if matched and Path(matched).is_file():
                return matched
    return None


def numbers(value: Any, count: int, field: str) -> list[float]:
    if not isinstance(value, list) or len(value) != count:
        fail(f"{field} 必须是包含 {count} 个数字的数组")
    if not all(isinstance(item, (int, float)) for item in value):
        fail(f"{field} 只能包含数字")
    return [float(item) for item in value]


def point_in_canvas(point: list[float], width: int, height: int, field: str) -> None:
    x, y = point
    if not 0 <= x <= width or not 0 <= y <= height:
        fail(f"{field} 坐标 {point} 超出画布 {width}×{height}")


def fmt(value: float) -> str:
    return str(int(round(value)))


def arrow_draw(start: list[float], end: list[float], length: float, half_width: float) -> str:
    x1, y1 = start
    x2, y2 = end
    dx, dy = x2 - x1, y2 - y1
    distance = math.hypot(dx, dy)
    if distance == 0:
        fail("箭头起点和终点不能相同")

    ux, uy = dx / distance, dy / distance
    base_x, base_y = x2 - ux * length, y2 - uy * length
    perp_x, perp_y = -uy * half_width, ux * half_width
    left = (base_x + perp_x, base_y + perp_y)
    right = (base_x - perp_x, base_y - perp_y)

    return (
        f"line {fmt(x1)},{fmt(y1)} {fmt(x2)},{fmt(y2)} "
        f"polygon {fmt(x2)},{fmt(y2)} {fmt(left[0])},{fmt(left[1])} "
        f"{fmt(right[0])},{fmt(right[1])}"
    )


def default_output(input_path: Path) -> Path:
    suffix = input_path.suffix or ".png"
    stem = input_path.stem
    next_stem = f"{stem}-v2" if stem.endswith("-annotated") else f"{stem}-annotated"
    return input_path.with_name(f"{next_stem}{suffix}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="原始截图")
    parser.add_argument("--spec", required=True, type=Path, help="标注 JSON 配置")
    parser.add_argument("--output", type=Path, help="输出图片，默认添加 -annotated 后缀")
    parser.add_argument("--font", help="字体文件路径；不传时自动探测中文字体")
    args = parser.parse_args()

    magick = shutil.which("magick")
    if not magick:
        fail("未找到 ImageMagick；请先安装并确保 magick 在 PATH 中")

    input_path = args.input.expanduser().resolve()
    spec_path = args.spec.expanduser().resolve()
    output_path = (args.output or default_output(input_path)).expanduser().resolve()
    if not input_path.is_file():
        fail(f"输入图片不存在：{input_path}")
    if not spec_path.is_file():
        fail(f"spec 不存在：{spec_path}")
    if input_path == output_path:
        fail("输出路径不能覆盖输入图片")

    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"无法读取 spec：{error}")
    if not isinstance(spec, dict):
        fail("spec 顶层必须是对象")

    labels = spec.get("labels")
    if not isinstance(labels, list) or not labels:
        fail("spec.labels 必须是非空数组")
    raw_style = spec.get("style", {})
    if not isinstance(raw_style, dict):
        fail("spec.style 必须是对象")
    style = DEFAULT_STYLE | raw_style
    width, height = image_size(magick, input_path)
    font = resolve_font(args.font)
    if not font:
        fail("未找到可用中文字体；请通过 --font 指定字体文件")

    command = [magick, str(input_path)]
    for index, label in enumerate(labels):
        if not isinstance(label, dict):
            fail(f"labels[{index}] 必须是对象")
        text = label.get("text")
        if not isinstance(text, str) or not text.strip():
            fail(f"labels[{index}].text 必须是非空字符串")

        box = numbers(label.get("box"), 4, f"labels[{index}].box")
        x1, y1, x2, y2 = box
        if x1 >= x2 or y1 >= y2:
            fail(f"labels[{index}].box 必须满足 x1 < x2 且 y1 < y2")
        point_in_canvas([x1, y1], width, height, f"labels[{index}].box")
        point_in_canvas([x2, y2], width, height, f"labels[{index}].box")

        text_at = numbers(label.get("text_at"), 2, f"labels[{index}].text_at")
        point_in_canvas(text_at, width, height, f"labels[{index}].text_at")
        radius = float(style["radius"])
        command.extend(
            [
                "-fill",
                str(style["label_fill"]),
                "-stroke",
                str(style["label_border"]),
                "-strokewidth",
                str(style["border_width"]),
                "-draw",
                (
                    f"roundrectangle {fmt(x1)},{fmt(y1)} {fmt(x2)},{fmt(y2)} "
                    f"{fmt(radius)},{fmt(radius)}"
                ),
                "-font",
                font,
                "-pointsize",
                str(style["point_size"]),
                "-fill",
                str(style["text_fill"]),
                "-stroke",
                "none",
                "-annotate",
                f"+{fmt(text_at[0])}+{fmt(text_at[1])}",
                text,
            ]
        )

        arrow = label.get("arrow")
        if arrow is not None:
            if not isinstance(arrow, dict):
                fail(f"labels[{index}].arrow 必须是对象")
            start = numbers(arrow.get("from"), 2, f"labels[{index}].arrow.from")
            end = numbers(arrow.get("to"), 2, f"labels[{index}].arrow.to")
            point_in_canvas(start, width, height, f"labels[{index}].arrow.from")
            point_in_canvas(end, width, height, f"labels[{index}].arrow.to")
            draw = arrow_draw(
                start,
                end,
                float(style["arrowhead_length"]),
                float(style["arrowhead_width"]),
            )
            command.extend(
                [
                    "-stroke",
                    str(style["arrow_fill"]),
                    "-strokewidth",
                    str(style["stroke_width"]),
                    "-fill",
                    str(style["arrow_fill"]),
                    "-draw",
                    draw,
                ]
            )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    command.append(str(output_path))
    subprocess.run(command, check=True)

    output_size = image_size(magick, output_path)
    if output_size != (width, height):
        output_path.unlink(missing_ok=True)
        fail(f"输出尺寸 {output_size} 与输入尺寸 {(width, height)} 不一致")
    print(f"已生成：{output_path}（{width}×{height}）")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        print(f"错误：ImageMagick 执行失败（退出码 {error.returncode}）", file=sys.stderr)
        raise SystemExit(error.returncode) from error
