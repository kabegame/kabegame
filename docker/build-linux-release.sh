#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${ROOT}/docker/docker-compose.linux-release.yml"
PROJECT="${COMPOSE_PROJECT_NAME:-kabegame-linux-release}"
OUT="${KABEGAME_LINUX_RELEASE_OUT:-${ROOT}/release-linux-docker}"

export KABEGAME_LINUX_BUILD_IMAGE="${KABEGAME_LINUX_BUILD_IMAGE:-kabegame-linux-release:latest}"

dc() {
  docker compose -f "${COMPOSE}" -p "${PROJECT}" "$@"
}

UP_ARGS=(up)
[[ -z "${SKIP_LINUX_IMAGE_BUILD:-}" ]] && UP_ARGS+=(--build)

dc "${UP_ARGS[@]}"
mkdir -p "${OUT}"
dc cp pack-standard:/src/release/. "${OUT}/"
dc cp pack-light:/src/release/. "${OUT}/"
dc down
