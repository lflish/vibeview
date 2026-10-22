#!/usr/bin/env bash
# vibeview 上传脚本（Skill 内置；完整能力见仓库 bin/dview）
# 用法: ./upload.sh <文件路径|站点目录|站点.zip> [--json] [--category C] [--tag T] [--project P]
#                   [--agent A] [--model M] [--description D] [--id ID] [-m MSG]
# --id 更新已有资源（生成新版本，链接和访问码不变）；-m 写这次更新的说明。
# 按 .dview.json 自动更新同一个链接需要完整的 bin/dview。
# 依赖环境变量:
#   DVIEW_URL    服务地址 (如 https://view.example.com)
#   DVIEW_TOKEN  上传 token (来自服务端 config.yaml 的 tokens 列表)
# 成功后在 stdout 打印预览 URL。
# 站点目录（多页面）：根部需有 index.html，自动打包成 zip（跳过 . 开头的文件、node_modules 和符号链接）。
# 列表/删除/用量请用: dview list | dview delete <id> | dview me

set -euo pipefail

usage() {
  echo "用法: $0 <文件路径|站点目录> [--json] [--category C] [--tag T] [--project P] [--agent A] [--model M] [--description D] [--id ID] [-m MSG]" >&2
  exit 1
}

[ "$#" -ge 1 ] || usage
FILE="$1"
shift
JSON=0
FIELDS=()
AGENT="${DVIEW_AGENT:-}"
PROJECT="${DVIEW_PROJECT:-}"
MODEL="${DVIEW_MODEL:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --agent) [ "$#" -ge 2 ] || usage; AGENT="$2"; shift 2 ;;
    --project) [ "$#" -ge 2 ] || usage; PROJECT="$2"; shift 2 ;;
    --model) [ "$#" -ge 2 ] || usage; MODEL="$2"; shift 2 ;;
    --category|--description) [ "$#" -ge 2 ] || usage; FIELDS+=(--form-string "${1#--}=$2"); shift 2 ;;
    --tag|--tags) [ "$#" -ge 2 ] || usage; FIELDS+=(--form-string "tags=$2"); shift 2 ;;
    --id) [ "$#" -ge 2 ] || usage; FIELDS+=(--form-string "id=$2"); shift 2 ;;
    -m|--message) [ "$#" -ge 2 ] || usage; FIELDS+=(--form-string "message=$2"); shift 2 ;;
    *) usage ;;
  esac
done
UPLOAD=(-F "file=@${FILE}")
if [ -d "$FILE" ]; then
  if [ ! -f "$FILE/index.html" ]; then
    echo "错误: 站点目录缺少入口 index.html: $FILE" >&2
    exit 1
  fi
  command -v python3 >/dev/null 2>&1 || { echo "错误: 打包站点目录需要 python3" >&2; exit 1; }
  ZIP="$(mktemp "${TMPDIR:-/tmp}/dview-site.XXXXXX")"
  trap 'rm -f "$ZIP"' EXIT
  python3 - "$FILE" "$ZIP" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d != "node_modules" and not os.path.islink(os.path.join(base, d)))
        for name in sorted(files):
            path = os.path.join(base, name)
            if name.startswith(".") or os.path.islink(path):
                continue
            z.write(path, os.path.relpath(path, src))
PY
  NAME="$(basename "$(cd "$FILE" && pwd)" | tr -c 'A-Za-z0-9._\n-' '_')"
  UPLOAD=(-F "file=@${ZIP};filename=${NAME:-site}.zip;type=application/zip")
elif [ ! -f "$FILE" ]; then
  echo "错误: 文件不存在: $FILE" >&2
  exit 1
fi

: "${DVIEW_URL:?请设置环境变量 DVIEW_URL}"
: "${DVIEW_TOKEN:?请设置环境变量 DVIEW_TOKEN}"

BASE="${DVIEW_URL%/}"

# 未显式指定时自动识别 agent 与 project（git 仓库目录名）
if [ -z "$AGENT" ] && [ -n "${AI_AGENT:-}" ]; then AGENT="${AI_AGENT%%_*}"; fi
if [ -z "$AGENT" ] && [ -n "${CLAUDECODE:-}" ]; then AGENT="claude-code"; fi
if [ -z "$PROJECT" ] && command -v git >/dev/null 2>&1; then
  if [ -d "$FILE" ]; then GIT_DIR_HINT="$FILE"; else GIT_DIR_HINT="$(dirname "$FILE")"; fi
  TOP="$(git -C "$GIT_DIR_HINT" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$TOP" ]; then PROJECT="$(basename "$TOP")"; fi
fi
if [ -n "$AGENT" ]; then FIELDS+=(--form-string "agent=$AGENT"); fi
if [ -n "$PROJECT" ]; then FIELDS+=(--form-string "project=$PROJECT"); fi
if [ -n "$MODEL" ]; then FIELDS+=(--form-string "model=$MODEL"); fi

RESP=$(curl -fsS -X POST "${BASE}/upload" \
  -H "Authorization: Bearer ${DVIEW_TOKEN}" \
  "${UPLOAD[@]}" ${FIELDS[@]+"${FIELDS[@]}"})

# 提取返回 JSON 里的 url 字段
URL=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['url'])" 2>/dev/null || true)

if [ -z "$URL" ]; then
  echo "上传失败，服务返回: $RESP" >&2
  exit 1
fi

if [ "$JSON" = '1' ]; then
  printf '%s\n' "$RESP"
  exit 0
fi
echo "$URL"
CODE=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('accessCode',''))" 2>/dev/null || true)
if [ -n "$CODE" ]; then
  printf '访问码（请单独分享并保存）: %s\n' "$CODE" >&2
  UNTIL=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('access',{}).get('expiresAt') or '不过期')")
  printf '访问码到期时间: %s\n' "$UNTIL" >&2
fi
