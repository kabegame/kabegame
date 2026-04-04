#!/usr/bin/env bash
# 使用 sidecar 编译好的 ffmpeg 测试「视频缩放 + mov/mp4 压缩」。
# 用法: scripts/test-ffmpeg-compress.sh <输入视频> [输出路径]
# 若未指定输出，则输出为同目录下的 <原名>.compressed.mp4。
set -e

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SIDECAR_DIR="${REPO_ROOT}/src-tauri/app-main/sidecar"

# Windows/Git Bash/MSYS2：让 ffmpeg 能找到同目录的 libx264-165.dll
export PATH="${SIDECAR_DIR}:$PATH"

echo $PATH;

# 智能选择当前平台可用的 ffmpeg 二进制
choose_ffmpeg() {
  if [[ ! -d "$SIDECAR_DIR" ]]; then
    echo "sidecar 目录不存在: $SIDECAR_DIR（请先执行 scripts/build-ffmpeg.sh）" >&2
    return 1
  fi

  # 优先使用与当前 host 一致的 ffmpeg-kb-{target_triple}
  TARGET_TRIPLE="${CARGO_BUILD_TARGET:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
  case "$(uname -s)" in
    Darwin)   EXE_SUF="" ;;
    Linux)    EXE_SUF="" ;;
    MINGW*|MSYS*|CYGWIN*) EXE_SUF=".exe" ;;
    *)        EXE_SUF="" ;;
  esac

  if [[ -n "$TARGET_TRIPLE" ]]; then
    PREFERRED="${SIDECAR_DIR}/ffmpeg-kb-${TARGET_TRIPLE}${EXE_SUF}"
    if [[ -f "$PREFERRED" && -x "$PREFERRED" ]]; then
      echo "$PREFERRED"
      return 0
    fi
  fi

  # 否则取 sidecar 下任意一个 ffmpeg-kb-* 可执行文件（例如只编了当前平台）
  for f in "$SIDECAR_DIR"/ffmpeg-kb-*; do
    if [[ -f "$f" && -x "$f" ]]; then
      echo "$f"
      return 0
    fi
  done

  echo "未在 $SIDECAR_DIR 找到可执行的 ffmpeg-kb sidecar（请先执行 scripts/build-ffmpeg.sh）" >&2
  return 1
}

INPUT="${1:-}"
OUTPUT="${2:-}"

if [[ -z "$INPUT" ]]; then
  echo "用法: $0 <输入视频> [输出路径]" >&2
  echo "示例: $0 ./demo.mov" >&2
  echo "      $0 ./demo.mov ./out.mp4" >&2
  exit 1
fi

if [[ ! -f "$INPUT" ]]; then
  echo "输入文件不存在: $INPUT" >&2
  exit 1
fi

# 未指定输出时：同目录，文件名为 <原名>.compressed.mp4
if [[ -z "$OUTPUT" ]]; then
  DIR=$(dirname "$INPUT")
  BASE=$(basename "$INPUT" | sed 's/\.[^.]*$//')
  OUTPUT="${DIR}/${BASE}.compressed.mp4"
fi

FFMPEG=$(choose_ffmpeg) || exit 1
echo "使用: $FFMPEG"
echo "输入: $INPUT"
echo "输出: $OUTPUT"
echo "---"

"$FFMPEG" -y \
  -i "$INPUT" \
  -vf "scale='min(1280,iw)':-2" \
  -c:v libx264 \
  -preset veryfast \
  -crf 30 \
  -movflags +faststart \
  -an \
  -f mov \
  "$OUTPUT"

echo "---"
echo "完成: $OUTPUT"
