#!/usr/bin/env bash
# 把目标机代码恢复到某次部署前的备份。config.yaml、.env 和 data/ 始终不动。
# 用法: bash .agents/skills/deploy-view/scripts/rollback.sh <release_id>
#   release_id 是 deploy.sh 输出的备份目录名（$VIEW_RELEASES_DIR 下）。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
export VIEW_RELEASE_ID="${1:?用法: rollback.sh <release_id>}"
export VIEW_RESTART="$(service_ctl restart)"

on_target <<'EOF'
set -euo pipefail
b="$VIEW_RELEASES_DIR/$VIEW_RELEASE_ID"
[ -f "$b/code.tar.gz" ] || { echo "找不到备份 $b/code.tar.gz" >&2; exit 1; }
tar -tzf "$b/code.tar.gz" >/dev/null
cd "$VIEW_DEPLOY_DIR"
wait_health() { for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$1/healthz" >/dev/null 2>&1 && return 0; sleep 2; done; echo "端口 $1 健康检查超时" >&2; return 1; }

# 当前代码移到 failed-code/，这样本次新增的文件不会残留
failed="$b/failed-code-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$failed"
list="$(grep -vE '^\s*(#|$)' scripts/runtime-files.txt 2>/dev/null || true)"
for p in $list server.js render-server.js package.json package-lock.json Dockerfile.render docker-compose.yml lib views scripts bin RELEASE; do
  [ -e "$p" ] && mv "$p" "$failed/"
done
tar -xzf "$b/code.tar.gz"
npm ci --omit=dev --no-audit --no-fund >/dev/null
echo "代码已恢复（当前失败的代码在 $failed）"

if [ "$(cat "$b/render-rebuilt" 2>/dev/null)" = 1 ] && docker image inspect "vibeview-render:rollback-$VIEW_RELEASE_ID" >/dev/null 2>&1; then
  override="$b/compose-rollback.yml"
  printf 'services:\n  render:\n    image: vibeview-render:rollback-%s\n' "$VIEW_RELEASE_ID" > "$override"
  RENDER_HOST_PORT=$VIEW_RENDER_PORT docker compose -f docker-compose.yml -f "$override" up -d --no-build --pull never render >/dev/null 2>&1
  wait_health "$VIEW_RENDER_PORT"
  cid="$(RENDER_HOST_PORT=$VIEW_RENDER_PORT docker compose ps -q render)"
  for _ in $(seq 1 45); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = healthy ] && break; sleep 2; done
  echo "sidecar 已恢复为旧镜像"
fi
$VIEW_RESTART
wait_health "$VIEW_MAIN_PORT"
echo "主服务已重启"
EOF
bash "$here/check.sh"
echo "回滚完成：$VIEW_RELEASE_ID"
