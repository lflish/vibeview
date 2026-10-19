#!/usr/bin/env bash
# 扫描将要公开的内容里有没有敏感信息：真实 IP、私钥、常见云服务和 GitHub token。
# 发布前（release）、部署前（deploy-view）和 CI 都会运行；发现问题就以非零退出。
#
# 用法: bash scripts/scan-sensitive.sh [ref]
#        bash scripts/scan-sensitive.sh --files <文件>...
#   ref 缺省为工作区（含未提交的已跟踪文件）；给出 tag 或提交号时扫描该提交的内容。
#   --files 扫描指定文件，例如还没提交的发布说明。
#
# 额外规则：每行一个扩展正则，写在不提交的 .sensitive-patterns.local（例如主机名、内部域名）。
# 允许的例外：每行一个扩展正则，写在 .sensitive-allow（提交到仓库，只放明确无害的内容）。
set -uo pipefail

ref="${1:-}"
files=()
if [[ "$ref" == --files ]]; then shift; files=("$@"); ref=""; (( ${#files[@]} )) || { echo "--files 需要文件" >&2; exit 2; }; fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for i in "${!files[@]}"; do
  [[ -f "${files[$i]}" ]] || { echo "找不到要扫描的文件: ${files[$i]}" >&2; exit 2; }
  files[$i]="$(realpath -- "${files[$i]}")"
done
cd "$root"

# 允许出现的 IPv4：回环、0.0.0.0、广播，以及 RFC 5737 文档示例段。
ALLOWED_IP='^(127\.|0\.0\.0\.0$|255\.255\.255\.255$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)'
PATTERNS=(
  'ipv4|\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'
  'private key|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'
  'github token|\b(gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})\b'
  'aws key|\bAKIA[0-9A-Z]{16}\b'
  'slack token|\bxox[abpr]-[A-Za-z0-9-]{10,}\b'
  'anthropic/openai key|\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,})\b'
)
if [[ -f .sensitive-patterns.local ]]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    PATTERNS+=("local rule|$line")
  done < .sensitive-patterns.local
fi
allow=()
[[ -f .sensitive-allow ]] && mapfile -t allow < <(grep -vE '^\s*(#|$)' .sensitive-allow)

grep_tree() {
  # package-lock.json 只有依赖哈希，不扫描以免误报。git grep 无匹配返回 1，出错返回 >1。
  local rc
  if (( ${#files[@]} )); then
    grep -n -I -E -o -H -e "$1" -- "${files[@]}"
    rc=$?
  elif [[ -n "$ref" ]]; then
    git grep -n -I -E -o -e "$1" "$ref" -- . ':!package-lock.json' ':!.sensitive-allow' | sed "s#^$ref:##"
    rc=${PIPESTATUS[0]}
  else
    git grep -n -I -E -o -e "$1" -- . ':!package-lock.json' ':!.sensitive-allow'
    rc=$?
  fi
  (( rc <= 1 )) || { echo "SCAN-ERROR grep 失败（$rc）" ; return 0; }
}

found=0
for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"; regex="${entry#*|}"
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    if [[ "$hit" == SCAN-ERROR* ]]; then echo "$hit（规则：$label）" >&2; found=1; continue; fi
    match="${hit#*:*:}"
    if [[ "$label" == ipv4 ]]; then
      # 每段都要在 0-255，排除版本号之类的误报
      IFS=. read -r a b c d <<<"$match"
      (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) 2>/dev/null || continue
      [[ "$match" =~ $ALLOWED_IP ]] && continue
    fi
    skip=0
    for rule in "${allow[@]}"; do [[ "$hit" =~ $rule ]] && { skip=1; break; }; done
    (( skip )) && continue
    # 只显示位置和类型，不回显完整的疑似秘密
    printf 'FOUND %-22s %s\n' "$label" "${hit%%:*}:$(cut -d: -f2 <<<"$hit") ${match:0:4}…"
    found=1
  done < <(grep_tree "$regex")
done

if (( found )); then
  echo "敏感信息扫描未通过：确认后删除这些内容；确实无害的写进 .sensitive-allow。" >&2
  exit 1
fi
echo "敏感信息扫描通过${ref:+（$ref）}"
