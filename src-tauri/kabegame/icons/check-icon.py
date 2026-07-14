#!/usr/bin/env python3

import argparse
import sys
from pathlib import Path

from PIL import Image


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="测量 PNG 图标四周的透明缩入比例"
    )
    parser.add_argument("image", type=Path, help="输入 PNG 图片")
    parser.add_argument(
        "--threshold",
        type=float,
        default=1.0,
        help="透明度阈值百分比，低于该透明度的像素视为空白，默认 1",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.image.is_file():
        print(f"错误：文件不存在：{args.image}", file=sys.stderr)
        return 1

    if not 0 <= args.threshold <= 100:
        print("错误：--threshold 必须在 0 到 100 之间", file=sys.stderr)
        return 1

    try:
        image = Image.open(args.image).convert("RGBA")
    except Exception as exc:
        print(f"错误：无法读取图片：{exc}", file=sys.stderr)
        return 1

    canvas_width, canvas_height = image.size
    alpha = image.getchannel("A")

    threshold_value = round(args.threshold / 100 * 255)

    # 大于阈值的像素视为图标内容。
    content_mask = alpha.point(
        lambda value: 255 if value > threshold_value else 0
    )

    bbox = content_mask.getbbox()

    if bbox is None:
        print("图片在当前透明度阈值下没有可见内容。")
        return 1

    left, top, right_edge, bottom_edge = bbox

    content_width = right_edge - left
    content_height = bottom_edge - top

    right = canvas_width - right_edge
    bottom = canvas_height - bottom_edge

    left_percent = left / canvas_width * 100
    right_percent = right / canvas_width * 100
    top_percent = top / canvas_height * 100
    bottom_percent = bottom / canvas_height * 100

    centered_horizontal_inset = (
        (canvas_width - content_width) / 2 / canvas_width * 100
    )
    centered_vertical_inset = (
        (canvas_height - content_height) / 2 / canvas_height * 100
    )

    width_ratio = content_width / canvas_width * 100
    height_ratio = content_height / canvas_height * 100

    print(f"文件：{args.image}")
    print(f"画布尺寸：{canvas_width} × {canvas_height}")
    print(f"内容包围盒：{content_width} × {content_height}")
    print(f"包围盒坐标：({left}, {top}) - ({right_edge}, {bottom_edge})")
    print(f"透明度阈值：{args.threshold:.2f}%")
    print()

    print(f"左侧缩入：{left} px，{left_percent:.2f}%")
    print(f"右侧缩入：{right} px，{right_percent:.2f}%")
    print(f"顶部缩入：{top} px，{top_percent:.2f}%")
    print(f"底部缩入：{bottom} px，{bottom_percent:.2f}%")
    print()

    print(f"主体宽度占比：{width_ratio:.2f}%")
    print(f"主体高度占比：{height_ratio:.2f}%")
    print(
        f"按宽度估算的居中单边缩入："
        f"{centered_horizontal_inset:.2f}%"
    )
    print(
        f"按高度估算的居中单边缩入："
        f"{centered_vertical_inset:.2f}%"
    )

    if image.getchannel("A").getextrema() == (255, 255):
        print()
        print("提示：图片完全不透明，因此透明边界法可能测得 0%。")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())