#!/usr/bin/env bash
# 把某个提交或 tag 的运行时文件打成发布包，并生成 SHA-256。
# 输出是确定的：同一个 ref 在任何机器上打出来的包，哈希都一样（文件时间取提交时间，gzip 不写时间戳）。
#
# 用法: bash scripts/package-release.sh <ref> [输出目录]
#   ref       tag（如 v1.2.0）或提交号；必须是已提交的内容
#   输出目录  缺省为 ./dist
# 产出: <输出目录>/vibeview-<名称>.tar.gz 和同名 .sha256；包内顶层目录为 vibeview-<名称>/
set -euo pipefail

ref="${1:?用法: bash scripts/package-release.sh <ref> [输出目录]}"
out="${2:-dist}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

commit="$(git rev-parse --verify --quiet "$ref^{commit}")" || { echo "找不到提交: $ref" >&2; exit 1; }
if git rev-parse --verify --quiet "refs/tags/$ref" >/dev/null; then name="$ref"; else name="$(git rev-parse --short=12 "$commit")"; fi

# 清单以该提交里的版本为准，旧提交也能正确打包。
mapfile -t paths < <(git show "$commit:scripts/runtime-files.txt" 2>/dev/null | grep -vE '^\s*(#|$)' ||
  printf '%s\n' server.js render-server.js package.json package-lock.json Dockerfile.render docker-compose.yml lib views scripts bin)
present=()
for p in "${paths[@]}"; do git cat-file -e "$commit:$p" 2>/dev/null && present+=("$p"); done

mkdir -p "$out"
archive="$out/vibeview-$name.tar.gz"
git archive --format=tar --prefix="vibeview-$name/" "$commit" -- "${present[@]}" | gzip -n -9 > "$archive"
(cd "$out" && sha256sum "vibeview-$name.tar.gz" > "vibeview-$name.tar.gz.sha256")
echo "$archive"
