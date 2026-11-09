#!/usr/bin/env bash
# 关掉 start.sh 启动的实例。只按 instance.env 里的 PID 关，不按进程名杀。证据不在实例目录里，可以整个删掉。
# 用法：bash .agents/skills/verify-vibeview/scripts/stop.sh <实例目录> [--keep]
set -euo pipefail
DIR="$1"; [ -f "$DIR/instance.env" ] || { echo "no instance at $DIR" >&2; exit 1; }
PID="$(grep '^PID=' "$DIR/instance.env" | cut -d= -f2)"
if kill -0 "$PID" 2>/dev/null; then kill "$PID"; for _ in $(seq 1 50); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done; fi
[ "${2:-}" = "--keep" ] || rm -rf "$DIR"
