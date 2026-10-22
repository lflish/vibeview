#!/usr/bin/env bash
# 发布第一步：检查能否发布 vX.Y.Z，改版本号并在本地提交，打印发布说明素材。不推送、不打 tag。
# 用法: bash .agents/skills/release/scripts/prepare.sh <X.Y.Z>
set -euo pipefail

version="${1:?用法: prepare.sh <X.Y.Z>}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号格式应为 X.Y.Z: $version" >&2; exit 2; }
tag="v$version"
cd "$(git rev-parse --show-toplevel)"
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

[[ "$(git branch --show-current)" == main ]] || fail "不在 main 分支"
[[ -z "$(git status --porcelain)" ]] || fail "工作区不干净，先提交或暂存改动"
git fetch -q --tags origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || fail "本地 main 与 origin/main 不一致，先同步"
pass "main 干净且与远端一致"

git rev-parse -q --verify "refs/tags/$tag" >/dev/null && fail "tag $tag 已存在"
git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 && fail "远端已有 tag $tag"
current="$(node -p "require('./package.json').version")"
node -e '
  const [a, b] = process.argv.slice(1).map(v => v.split(".").map(Number));
  const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  process.exit(cmp > 0 ? 0 : 1);
' "$version" "$current" || fail "新版本 $version 必须大于当前版本 $current"
pass "版本 $current → $version，tag $tag 未被使用"

gh auth status >/dev/null 2>&1 || fail "gh 未登录（gh auth login）"
pass "gh 已登录"
bash scripts/scan-sensitive.sh >/dev/null || { bash scripts/scan-sensitive.sh; fail "敏感信息扫描未通过"; }
pass "敏感信息扫描"

npm version "$version" --no-git-tag-version >/dev/null
git add package.json package-lock.json
git commit -q -m "chore(release): $tag"
pass "已在本地提交 chore(release): $tag（未推送）"

last="$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)"
echo
echo "== 发布说明素材：${last:-首个版本} 以来的提交 =="
git log --no-merges --format='- %s (%h)' ${last:+"$last"..}HEAD^
echo
echo "== 本版新增或改动的需求说明（发布说明的「需求说明」一节要逐个链接到 blob/$tag/...） =="
specs="$(git diff --name-only --diff-filter=AM ${last:+"$last"} HEAD -- 'docs/specs/*.md' | grep -v '/README\.md$' || true)"
if [[ -n "$specs" ]]; then
  while read -r spec; do
    printf -- '- %s：%s\n' "$spec" "$(grep -m1 '^状态：' "$spec" | sed 's/^状态：//' || true)"
  done <<<"$specs"
else
  echo "（没有）"
fi
echo
echo "下一步：写发布说明 → git push origin main → 等 CI 通过 → publish.sh $version <说明文件>"
