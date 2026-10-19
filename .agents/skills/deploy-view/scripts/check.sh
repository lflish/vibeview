#!/usr/bin/env bash
# Read-only deployment checks. No credentials, restarts or writes.
# 目标由 VIEW_* 环境变量或 local.env 决定，见 local.env.example。
set -uo pipefail

if [[ $# -gt 0 ]]; then
  echo "Usage: bash .agents/skills/deploy-view/scripts/check.sh" >&2
  exit 2
fi
source "$(dirname "$0")/env.sh" || exit 2

echo "target: ${VIEW_DEPLOY_HOST:-local} $VIEW_DEPLOY_DIR ($VIEW_SERVICE_MANAGER)"
result=0
on_target <<'REMOTE' || result=1
set -uo pipefail
cd "$VIEW_DEPLOY_DIR" || { echo "FAIL service directory missing" >&2; exit 1; }
failed=0
check() {
  local label="$1"
  shift
  if "$@"; then
    printf 'PASS %s\n' "$label"
  else
    printf 'FAIL %s\n' "$label" >&2
    failed=1
  fi
}
# 读取 healthz JSON，检查 ok 和 role（以及主服务的 previewProxy）。
health() {
  curl --connect-timeout 5 --max-time 10 -fsS "http://127.0.0.1:$1/healthz" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let h;try{h=JSON.parse(s)}catch{process.exit(1)}const role=process.argv[1];process.exit(h.ok===true&&h.role===role&&(role!=="main"||h.previewProxy===true)?0:1)})' "$2"
}
service_online() {
  if [[ "$VIEW_SERVICE_MANAGER" == pm2 ]]; then
    pm2 jlist | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).filter(p=>p.name===process.argv[1]);process.exit(p.length>0&&p.every(p=>p.pm2_env.status==="online")?0:1)})' "$VIEW_SERVICE_NAME"
  else
    systemctl --user is-active --quiet "$VIEW_SERVICE_NAME.service"
  fi
}
if [ -f RELEASE ]; then
  printf 'INFO deployed %s (commit %s, %s, at %s)\n' "$(sed -n 's/^version=//p' RELEASE)" "$(sed -n 's/^commit=//p' RELEASE | cut -c1-12)" \
    "$(sed -n 's/^source=//p' RELEASE)" "$(sed -n 's/^deployed_at=//p' RELEASE)"
else
  echo 'INFO deployed version not recorded (no RELEASE file)'
fi
check 'config exists' test -f config.yaml
check 'data exists' test -d data
check "$VIEW_SERVICE_MANAGER $VIEW_SERVICE_NAME online" service_online
check 'main health and preview proxy' health "$VIEW_MAIN_PORT" main
check 'render health' health "$VIEW_RENDER_PORT" render
check 'Docker render healthy' bash -o pipefail -c '
  container_id=$(RENDER_HOST_PORT=$VIEW_RENDER_PORT docker compose ps -q render) || exit 1
  test -n "$container_id" || exit 1
  state=$(docker inspect --format "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" "$container_id") || exit 1
  test "$state" = "running healthy"
'
exit "$failed"
REMOTE

# Validate the public certificate from the caller, independently of loopback.
if curl --connect-timeout 10 --max-time 20 -fsS -o /dev/null "$VIEW_PUBLIC_URL/admin/login"; then
  echo 'PASS public HTTPS /admin/login (certificate verified)'
else
  echo 'FAIL public HTTPS /admin/login (certificate verification enabled)' >&2
  result=1
fi
exit "$result"
