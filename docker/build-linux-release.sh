#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${KABEGAME_LINUX_BUILD_IMAGE:-kabegame-linux-release:latest}"

docker build -f "${ROOT}/docker/linux-release.Dockerfile" -t "${IMAGE}" "${ROOT}"
docker run --rm -it -v "${ROOT}:/src:rw" -w /src "${IMAGE}" "$@"
