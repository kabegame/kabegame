#!/usr/bin/env bash
# scripts/utils.sh — shared helpers for the build-*.sh scripts (build-ffmpeg.sh, build-v8.sh).
#
# Source it near the top of a build script:
#   source "$(dirname "${BASH_SOURCE[0]}")/utils.sh"
#
# Sourcing enables strict mode (set -euo pipefail) for the caller and exposes:
#   ROOT                 repo root (parent of scripts/)
#   log / warn / die     stderr logging; die exits 1
#   kb_os                echoes: linux | macos | windows | unknown
#   require_linux [name] die unless host is Linux
#   require_cmd  cmd [hint]   die unless `cmd` is on PATH

# `source` runs in the caller's shell, so this turns on strict mode there too
# ("自动 set -e"). Guard against double-sourcing being harmful — it isn't, this is idempotent.
set -euo pipefail

# scripts/ dir of THIS file, then repo root one level up. Works regardless of caller's cwd.
KB_UTILS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$KB_UTILS_DIR/.." && pwd)"

# Colored tags only when stderr is a TTY (keeps logs clean when redirected to a file).
if [[ -t 2 ]]; then
  _KB_BLUE=$'\033[34m'; _KB_YELLOW=$'\033[33m'; _KB_RED=$'\033[31m'; _KB_RESET=$'\033[0m'
else
  _KB_BLUE=''; _KB_YELLOW=''; _KB_RED=''; _KB_RESET=''
fi

log()  { printf '%s[build]%s %s\n'        "$_KB_BLUE"   "$_KB_RESET" "$*" >&2; }
warn() { printf '%s[build] warn:%s %s\n'  "$_KB_YELLOW" "$_KB_RESET" "$*" >&2; }
die()  { printf '%s[build] error:%s %s\n' "$_KB_RED"    "$_KB_RESET" "$*" >&2; exit 1; }

# linux | macos | windows | unknown
kb_os() {
  case "$(uname -s)" in
    Linux)                echo linux ;;
    Darwin)               echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *)                    echo unknown ;;
  esac
}

# Abort unless running on Linux (for Linux-only build steps).
require_linux() {
  [[ "$(kb_os)" == linux ]] || die "${1:-this script} only runs on Linux (host: $(uname -s))."
}

# Abort if a command is missing; optional second arg is an install hint.
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1${2:+ — $2}"
}
