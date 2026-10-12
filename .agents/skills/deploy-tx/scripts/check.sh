#!/usr/bin/env bash
# Read-only TX deployment checks. No credentials, restarts or writes.
set -uo pipefail

if [[ $# -gt 0 ]]; then
  echo "Usage: bash .agents/skills/deploy-tx/scripts/check.sh" >&2
  exit 2
fi

result=0
ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=2 tx 'bash -s' <<'REMOTE' || result=1
set -uo pipefail
cd /home/lflish/vibeview || exit 1
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
check 'remote config exists' test -f config.yaml
check 'remote data exists' test -d data
check 'PM2 vibeview online' bash -o pipefail -c 'pm2 jlist | node -e '\''let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s).filter(p=>p.name==="vibeview");process.exit(p.length>0&&p.every(p=>p.pm2_env.status==="online")?0:1)})'\'''
check 'main health and preview proxy' bash -o pipefail -c 'curl --connect-timeout 5 --max-time 10 -fsS http://127.0.0.1:3210/healthz | node -e '\''let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const h=JSON.parse(s);process.exit(h.ok===true&&h.role==="main"&&h.previewProxy===true?0:1)})'\'''
check 'render health' bash -o pipefail -c 'curl --connect-timeout 5 --max-time 10 -fsS http://127.0.0.1:3213/healthz | node -e '\''let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const h=JSON.parse(s);process.exit(h.ok===true&&h.role==="render"?0:1)})'\'''
check 'Docker render healthy' bash -o pipefail -c '
  container_id=$(RENDER_HOST_PORT=3213 docker compose ps -q render) || exit 1
  test -n "$container_id" || exit 1
  state=$(docker inspect --format "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" "$container_id") || exit 1
  test "$state" = "running healthy"
'
exit "$failed"
REMOTE

# Validate the public certificate from the caller, independently of loopback.
if curl --connect-timeout 10 --max-time 20 -fsS -o /dev/null \
  https://view.lflish.fun/admin/login; then
  echo 'PASS public HTTPS /admin/login (certificate verified)'
else
  echo 'FAIL public HTTPS /admin/login (certificate verification enabled)' >&2
  result=1
fi
exit "$result"
