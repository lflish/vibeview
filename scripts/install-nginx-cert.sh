#!/usr/bin/env bash
set -euo pipefail

# Run on the host that terminates HTTPS. The caller must be able to use sudo
# for installing files and reloading nginx.
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"
ACME_DOMAIN="${ACME_DOMAIN:-tmux.lflish.fun}"
NGINX_CERT="${NGINX_CERT:-/etc/nginx/ssl/lflish.fun.pem}"
NGINX_KEY="${NGINX_KEY:-/etc/nginx/ssl/lflish.fun.key}"

ACME="$ACME_HOME/acme.sh"
if [[ ! -x "$ACME" ]]; then
  echo "找不到 acme.sh: $ACME" >&2
  exit 1
fi
if ! sudo -n true 2>/dev/null; then
  if [[ -t 0 ]]; then
    sudo -v
  else
    echo "需要 sudo 权限。请在 TX 的交互终端运行本脚本，并在 sudo 提示时输入密码。" >&2
    exit 2
  fi
fi

sudo mkdir -p "$(dirname "$NGINX_CERT")"
sudo "$ACME" --home "$ACME_HOME" \
  --install-cert -d "$ACME_DOMAIN" --ecc \
  --key-file "$NGINX_KEY" \
  --fullchain-file "$NGINX_CERT" \
  --reloadcmd "sudo -n nginx -t && sudo -n systemctl reload nginx"
sudo nginx -t
sudo systemctl reload nginx
openssl x509 -in "$NGINX_CERT" -noout -dates -subject
echo "Nginx 证书已安装并 reload。"
