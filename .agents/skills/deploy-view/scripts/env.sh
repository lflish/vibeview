#!/usr/bin/env bash
# deploy-view 共用设置：读取 local.env（不提交），校验变量，并提供在目标机执行命令的函数。
# 用法：source "$(dirname "$0")/env.sh"
#
# 部署目标信息只来自环境变量或 local.env，仓库里不写真实主机、目录或域名。

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$SKILL_DIR/local.env" ]]; then
  # 已经在环境里设置的变量优先，local.env 只补默认值。
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^VIEW_[A-Z_]+$ ]] || continue
    [[ -n "${!key+x}" ]] && continue
    value="${value%\"}"; value="${value#\"}"
    export "$key=$value"
  done < <(grep -E '^VIEW_[A-Z_]+=' "$SKILL_DIR/local.env")
fi

: "${VIEW_DEPLOY_HOST:=}"                 # 空 = 部署到本机；否则是 SSH 目标（别名或 user@host）
: "${VIEW_DEPLOY_DIR:?需要 VIEW_DEPLOY_DIR（目标机上的服务目录），见 local.env.example}"
: "${VIEW_PUBLIC_URL:?需要 VIEW_PUBLIC_URL（对外 HTTPS 地址），见 local.env.example}"
: "${VIEW_RELEASES_DIR:=$(dirname "$VIEW_DEPLOY_DIR")/vibeview-releases}"
: "${VIEW_MAIN_PORT:=3000}"
: "${VIEW_RENDER_PORT:=3001}"
: "${VIEW_SERVICE_MANAGER:=systemd-user}"   # systemd-user | pm2
: "${VIEW_SERVICE_NAME:=vibeview}"
export VIEW_DEPLOY_HOST VIEW_DEPLOY_DIR VIEW_PUBLIC_URL VIEW_RELEASES_DIR VIEW_MAIN_PORT VIEW_RENDER_PORT \
  VIEW_SERVICE_MANAGER VIEW_SERVICE_NAME
VIEW_PUBLIC_URL="${VIEW_PUBLIC_URL%/}"

case "$VIEW_SERVICE_MANAGER" in
  systemd-user|pm2) ;;
  *) echo "VIEW_SERVICE_MANAGER 只能是 systemd-user 或 pm2" >&2; return 2 2>/dev/null || exit 2 ;;
esac

# 在目标机执行 stdin 中的脚本；当前所有 VIEW_* 变量（除 VIEW_DEPLOY_HOST）都会带过去。
#   on_target <<'EOF' ... EOF        执行 stdin 里的脚本
#   on_target -c '<命令>'             执行一条命令，stdin 留给数据（例如 tar 管道）
on_target() {
  local vars cmd="bash -s"
  vars="$(for k in $(compgen -v VIEW_); do [[ "$k" == VIEW_DEPLOY_HOST ]] && continue; printf 'export %s=%q; ' "$k" "${!k}"; done)"
  if [[ "${1:-}" == -c ]]; then cmd="bash -c $(printf '%q' "${2:?on_target -c 需要命令}")"; fi
  if [[ -n "$VIEW_DEPLOY_HOST" ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 \
      "$VIEW_DEPLOY_HOST" "$vars $cmd"
  else
    env -i HOME="$HOME" PATH="$PATH" USER="${USER:-}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" \
      DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" bash -c "$vars $cmd"
  fi
}

# 主服务控制：restart | stop | start | status
service_ctl() {
  case "$VIEW_SERVICE_MANAGER" in
    systemd-user) echo "systemctl --user $1 $VIEW_SERVICE_NAME.service" ;;
    pm2) echo "pm2 $1 $VIEW_SERVICE_NAME" ;;
  esac
}
