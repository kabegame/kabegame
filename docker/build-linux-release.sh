#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${ROOT}/docker/docker-compose.linux-release.yml"
PROJECT="${COMPOSE_PROJECT_NAME:-kabegame-linux-release}"

export KABEGAME_LINUX_BUILD_IMAGE="${KABEGAME_LINUX_BUILD_IMAGE:-kabegame-linux-release:latest}"

dc() {
  docker compose -f "${COMPOSE}" -p "${PROJECT}" "$@"
}

UP_ARGS=(up)
[[ -z "${SKIP_LINUX_IMAGE_BUILD:-}" ]] && UP_ARGS+=(--build)

# /src 是 bind mount，容器内 /src/release 即宿主机 ${ROOT}/release，无需再 docker cp
dc "${UP_ARGS[@]}"
dc down
