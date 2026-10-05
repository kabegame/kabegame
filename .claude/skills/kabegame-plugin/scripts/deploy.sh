#!/usr/bin/env bash
# 构建并打包插件到 dev 插件目录。
#   deploy.sh <plugin-id>
# 产物：.kabegame/debug/data/plugins-directory/<id>.kgpg
#   - dev app 直接读这个目录（app-run.sh 会 refresh_plugins）
#   - run-cli.sh 从这里取 .kgpg，import 到生产目录后再 plugin run
#
# 走 src-crawler-plugins/package-plugin.ts：它先构建 plugin-sdk（dist 过期时）与插件的
# scripts.build，再调 target/release/kabegame-cli plugin pack。
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ID="${1:?用法: deploy.sh <plugin-id>}"
DEST_DIR="$ROOT/.kabegame/debug/data/plugins-directory"

[ -d "$ROOT/src-crawler-plugins/plugins/$ID" ] || { echo "✗ 插件目录不存在: src-crawler-plugins/plugins/$ID" >&2; exit 1; }
[ -x "$ROOT/target/release/kabegame-cli" ] || { echo "✗ 缺少 release CLI —— 请用户在仓库根执行 deno task b -c kabegame-cli --release" >&2; exit 1; }

before=$(stat -f %m "$DEST_DIR/$ID.kgpg" 2>/dev/null || echo 0)
deno task --cwd "$ROOT/src-crawler-plugins" package "$ID" --out-dir "$DEST_DIR" 2>&1 | grep -E "✅|❌|rror" || true
after=$(stat -f %m "$DEST_DIR/$ID.kgpg" 2>/dev/null || echo 0)
[ "$after" != "$before" ] || { echo "✗ 打包失败（.kgpg 未更新），去掉 grep 重跑看完整输出" >&2; exit 1; }
echo "✓ 已打包 → $DEST_DIR/$ID.kgpg"
