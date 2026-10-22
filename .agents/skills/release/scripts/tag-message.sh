#!/usr/bin/env bash
# 生成 annotated tag 的说明：标题、发布说明的第一段摘要、本版的需求说明清单和 Release 链接。
# 完整说明以 GitHub Release 为准；tag 里只放摘要，方便 git show / git tag -n 时也能看到改了什么。
# 用法: bash .agents/skills/release/scripts/tag-message.sh <X.Y.Z> <发布说明.md> [提交，默认 HEAD]
set -euo pipefail

version="${1:?用法: tag-message.sh <X.Y.Z> <发布说明.md> [提交]}"
notes="${2:?需要发布说明文件}"
head="${3:-HEAD}"
tag="v$version"
cd "$(git rev-parse --show-toplevel)"

# 摘要：第一个标题之后的第一段正文（跳过标题、空行和表格）
summary="$(awk '
  /^#/ { if (started) exit; seen = 1; next }
  !seen { next }
  /^[[:space:]]*$/ { if (started) exit; next }
  /^\|/ { next }
  { started = 1; print }
' "$notes")"

prev="$(git describe --tags --abbrev=0 "$head^" 2>/dev/null || true)"
specs="$(git diff --name-only --diff-filter=AM ${prev:+"$prev"} "$head" -- 'docs/specs/*.md' | grep -v '/README\.md$' || true)"
repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"

echo "vibeview $tag"
echo
if [[ -n "$summary" ]]; then
  # 去掉 Markdown 的粗体和行内代码标记；不折行（fold 按字节截断，会切坏中文）
  printf '%s\n' "$summary" | sed 's/\*\*//g; s/`//g; s/[[:space:]]*$//'
  echo
fi
if [[ -n "$specs" ]]; then
  echo "需求说明:"
  while read -r spec; do
    # 只取状态的第一句（不含日期、依赖）
    status="$(git show "$head:$spec" 2>/dev/null | grep -m1 '^状态：' | sed 's/^状态：//; s/。.*$//' || true)"
    printf -- '- %s%s\n' "$spec" "${status:+（$status）}"
  done <<<"$specs"
  echo
fi
if [[ -n "$repo" ]]; then
  echo "完整说明: https://github.com/$repo/releases/tag/$tag"
fi
