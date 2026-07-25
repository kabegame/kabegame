#!/usr/bin/env bash
set -euo pipefail

# 部署文档站（Astro Starlight，apps/docs）到 kabegame.com。
#
# 站点由 Nginx Proxy Manager(NPM，Docker 容器 npm-app-1)对外提供，采用 nginx `root`
# 直吐静态文件的方式。因此静态产物必须放到 NPM 容器可见的路径下——即已挂载的
# host `/home/cmtheit/npm/data` → container `/data` 卷内。本脚本只负责「构建 + 同步」，
# NPM 里 kabegame.com 站点的 `root` 配置由人工在 NPM 面板的 Advanced 里维护（见文件末注释）。

REMOTE_HOST="cmtheit.com"
REMOTE_USER="cmtheit"
# host 路径；对应容器内 /data/kabegame-docs/dist
DOCS_ROOT="/home/${REMOTE_USER}/npm/data/kabegame-docs"
REMOTE_DIR="${DOCS_ROOT}/dist"
LOCAL_DIST="apps/docs/dist"

echo "==> Building docs (deno task docs:build)"
deno task docs:build

if [[ ! -d "${LOCAL_DIST}" ]]; then
  echo "Error: ${LOCAL_DIST} not found after build." >&2
  exit 1
fi

# /home/cmtheit/npm/data 归 root（NPM 容器所有）；用 sudo 建目录，再把 docs 子目录
# chown 给部署用户，之后的 rsync 就无需 sudo（容器内 nginx 以 root 运行，可读 644 文件）。
echo "==> Ensuring remote dir ${REMOTE_HOST}:${REMOTE_DIR} (sudo mkdir + chown)"
ssh "${REMOTE_USER}@${REMOTE_HOST}" \
  "sudo mkdir -p '${REMOTE_DIR}' && sudo chown -R ${REMOTE_USER}:${REMOTE_USER} '${DOCS_ROOT}'"

echo "==> Syncing ${LOCAL_DIST}/ -> ${REMOTE_HOST}:${REMOTE_DIR}/ (rsync --delete)"
rsync -az --delete "${LOCAL_DIST}/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> Done. 容器内路径: /data/kabegame-docs/dist"
echo "    NPM 里为 kabegame.com 建 Proxy Host（forward 随便填，如 http 127.0.0.1:80，"
echo "    仅占位；证书选通用证书 npm-3），在 Advanced 粘贴以下配置（与 carousel 同套路，"
echo "    用 =/^~/正则 避免与 NPM 默认的 location / 反代块冲突）："
cat <<'NGINX'
      root /data/kabegame-docs/dist;
      index index.html;

      location = / {
          try_files /index.html =404;
      }

      location ^~ /_astro/ {
          try_files $uri =404;
          access_log off;
          expires 7d;
          add_header Cache-Control "public, max-age=604800, immutable";
      }

      location ^~ /pagefind/ {
          try_files $uri =404;
      }

      location ~ ^/.+ {
          try_files $uri $uri/ /404.html;
      }
NGINX
