#!/usr/bin/env bash
# vibeview 上传脚本（Skill 内置；完整能力见仓库 bin/dview）
# 用法: ./upload.sh <文件路径>
# 依赖环境变量:
#   DVIEW_URL    服务地址 (如 https://view.example.com)
#   DVIEW_TOKEN  上传 token (来自服务端 config.yaml 的 tokens 列表)
# 成功后在 stdout 打印预览 URL。
# 列表/删除/用量请用: dview list | dview delete <id> | dview me

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "用法: $0 <文件路径>" >&2
  exit 1
fi

FILE="$1"
if [ ! -f "$FILE" ]; then
  echo "错误: 文件不存在: $FILE" >&2
  exit 1
fi

: "${DVIEW_URL:?请设置环境变量 DVIEW_URL}"
: "${DVIEW_TOKEN:?请设置环境变量 DVIEW_TOKEN}"

BASE="${DVIEW_URL%/}"

RESP=$(curl -fsS -X POST "${BASE}/upload" \
  -H "Authorization: Bearer ${DVIEW_TOKEN}" \
  -F "file=@${FILE}")

# 提取返回 JSON 里的 url 字段
URL=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['url'])" 2>/dev/null || true)

if [ -z "$URL" ]; then
  echo "上传失败，服务返回: $RESP" >&2
  exit 1
fi

echo "$URL"
