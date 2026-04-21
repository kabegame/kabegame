#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="cmtheit.com"
REMOTE_USER="cmtheit"
REMOTE_DIR="/home/${REMOTE_USER}/kabegame"
SERVICE_NAME="kabegame"
LOCAL_BIN="dist-web/kabegame"

if [[ ! -f "${LOCAL_BIN}" ]]; then
  echo "Error: ${LOCAL_BIN} not found. Build it first." >&2
  exit 1
fi

echo "==> Stopping ${SERVICE_NAME} on ${REMOTE_HOST}"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "sudo systemctl stop ${SERVICE_NAME}"

echo "==> Uploading ${LOCAL_BIN} to ${REMOTE_HOST}:${REMOTE_DIR}/"
scp "${LOCAL_BIN}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> Setting executable permission"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "chmod +x ${REMOTE_DIR}/kabegame"

echo "==> Starting ${SERVICE_NAME} on ${REMOTE_HOST}"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "sudo systemctl start ${SERVICE_NAME}"

echo "==> Done"
