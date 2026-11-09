#!/usr/bin/env bash
# 启动一个隔离的 vibeview 实例：临时目录、随机空闲端口、独立的数据和统计目录，不碰 config.yaml 和 data/。
# 用法：bash .agents/skills/verify-vibeview/scripts/start.sh [实例目录]
# 输出实例目录；其中 instance.env 有 BASE、PID、ADMIN_USER、ADMIN_PASS、TOKEN_A、TOKEN_B。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/verify-vibeview-XXXXXX")}"
mkdir -p "$DIR"
PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
PASS="verify-$(node -e "console.log(require('crypto').randomBytes(9).toString('hex'))")"
cat > "$DIR/config.json" <<JSON
{ "server": { "port": $PORT, "base_url": "http://127.0.0.1:$PORT", "trust_proxy": false },
  "storage": { "retention_days": 0 }, "statistics": { "timezone": "Asia/Shanghai" },
  "admin": { "user": "verify", "password": "$PASS", "session_secret": "verify-$PORT-secret" },
  "tokens": [ { "name": "alice", "token": "verify-token-alice" }, { "name": "bob", "token": "verify-token-bob" } ] }
JSON
cd "$REPO"
# $! 必须是 node 本身：用子 shell 包起来时 $! 是子 shell，它会占住调用方的输出管道，stop.sh 也关不掉 node。
DVIEW_CONFIG_PATH="$DIR/config.json" DVIEW_PREVIEW_PROXY=false nohup node server.js > "$DIR/server.log" 2>&1 < /dev/null &
echo $! > "$DIR/pid"
for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$(cat "$DIR/pid")" 2>/dev/null; then echo "server exited:" >&2; tail -20 "$DIR/server.log" >&2; exit 1; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { echo "not ready" >&2; tail -20 "$DIR/server.log" >&2; exit 1; }
cat > "$DIR/instance.env" <<ENV
BASE=http://127.0.0.1:$PORT
PID=$(cat "$DIR/pid")
ADMIN_USER=verify
ADMIN_PASS=$PASS
TOKEN_A=verify-token-alice
TOKEN_B=verify-token-bob
ENV
echo "$DIR"
