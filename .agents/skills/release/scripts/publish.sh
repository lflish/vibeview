#!/usr/bin/env bash
# 发布第二步：确认版本提交已推送且 CI 通过，打 tag、打发布包并创建 GitHub Release。不部署。
# 用法: bash .agents/skills/release/scripts/publish.sh <X.Y.Z> <发布说明.md>
set -euo pipefail

version="${1:?用法: publish.sh <X.Y.Z> <发布说明.md>}"
notes="${2:?需要发布说明文件}"
tag="v$version"
[[ -f "$notes" ]] || { echo "找不到发布说明: $notes" >&2; exit 2; }
notes="$(realpath "$notes")"
cd "$(git rev-parse --show-toplevel)"
fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

[[ "$(git branch --show-current)" == main && -z "$(git status --porcelain)" ]] || fail "需要在干净的 main 分支上"
git fetch -q --tags origin main
head="$(git rev-parse HEAD)"
[[ "$head" == "$(git rev-parse origin/main)" ]] || fail "版本提交还没推送（git push origin main）"
[[ "$(node -p "require('./package.json').version")" == "$version" ]] || fail "package.json 版本不是 $version，先运行 prepare.sh"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && fail "tag $tag 已存在"
pass "提交 ${head:0:7} 已推送，版本 $version"

# 这个提交的 CI 必须成功
run="$(gh run list --commit "$head" --workflow ci.yml --json status,conclusion,url --limit 1 --jq '.[0] | "\(.status) \(.conclusion) \(.url)"' 2>/dev/null || true)"
[[ -n "$run" ]] || fail "没找到这个提交的 CI 运行，稍等再试"
read -r status conclusion url <<<"$run"
[[ "$status" == completed ]] || fail "CI 还在运行（$status）：$url；可用 gh run watch 等待"
[[ "$conclusion" == success ]] || fail "CI 未通过（$conclusion）：$url"
pass "CI 通过 $url"

bash scripts/scan-sensitive.sh HEAD >/dev/null || { bash scripts/scan-sensitive.sh HEAD; fail "敏感信息扫描未通过"; }
bash scripts/scan-sensitive.sh --files "$notes" >/dev/null || { bash scripts/scan-sensitive.sh --files "$notes"; fail "发布说明里有敏感信息"; }
grep -qE '__[A-Z]+__|TODO|TBD' "$notes" && fail "发布说明里还有占位符"
pass "代码和发布说明的敏感信息扫描"

# 先在本地打 tag，再按 tag 打包（包名和包内顶层目录都用 tag 命名）；推送失败会删掉本地 tag。
git tag -a "$tag" -m "vibeview $tag" "$head"
out="dist/$tag"
rm -rf "$out"
archive="$(bash scripts/package-release.sh "$tag" "$out")" || { git tag -d "$tag" >/dev/null; fail "打包失败，已删除本地 tag"; }
(cd "$out" && sha256sum -c --quiet "$(basename "$archive").sha256") || { git tag -d "$tag" >/dev/null; fail "发布包校验失败"; }
pass "发布包 $archive"

git push -q origin "refs/tags/$tag" || { git tag -d "$tag" >/dev/null; fail "推送 tag 失败，已删除本地 tag"; }
pass "已推送 tag $tag"
gh release create "$tag" --verify-tag --title "vibeview $tag" --notes-file "$notes" --latest \
  "$archive" "$archive.sha256" ||
  fail "tag 已推送，但创建 Release 失败。不要删 tag；修复后运行: gh release create $tag --verify-tag --title 'vibeview $tag' --notes-file <说明> $archive $archive.sha256"
echo
echo "完成。部署这个版本：使用 \$deploy-view 部署 $tag"
