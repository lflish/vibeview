#!/usr/bin/env bash
# 把一个版本部署到 VIEW_* 指定的目标机。默认只预演（列出变更），加 --yes 才真正执行。
#
# 用法:
#   bash .agents/skills/deploy-view/scripts/deploy.sh vX.Y.Z [--yes]       部署正式版本（推荐）
#   bash .agents/skills/deploy-view/scripts/deploy.sh --commit <ref> [--yes] 部署某个已提交的提交（非正式版本）
#   bash .agents/skills/deploy-view/scripts/deploy.sh --worktree [--yes]     紧急修复：部署工作区（含未提交改动）
#
# 正式版本优先使用 GitHub Release 附件，并与本地按 tag 重新打包的结果比对 SHA-256。
# 执行时：备份目标机代码和数据 → 同步 → 按需 npm ci / 重建 sidecar → 重启 → 写 RELEASE → 检查；
# 重启后检查失败会自动回滚到本次备份。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
source "$here/env.sh"
repo="$(cd "$here/../../../.." && pwd)"
cd "$repo"

mode="" ref="" yes=0
while (($#)); do
  case "$1" in
    v[0-9]*) mode=release; ref="$1" ;;
    --commit) mode=commit; ref="${2:?--commit 需要提交号}"; shift ;;
    --worktree) mode=worktree ;;
    --yes) yes=1 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$mode" ]] || { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

say() { printf '%s\n' "$*"; }
die() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
stage="$(mktemp -d "${TMPDIR:-/tmp}/vibeview-deploy.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

# ---- 1. 准备发布包 ----
case "$mode" in
  release)
    git fetch -q --tags origin 2>/dev/null || true
    commit="$(git rev-parse -q --verify "refs/tags/$ref^{commit}")" || die "找不到 tag $ref"
    bash scripts/package-release.sh "$ref" "$stage/local" >/dev/null
    local_sha="$(cut -d' ' -f1 "$stage/local/vibeview-$ref.tar.gz.sha256")"
    if gh release download "$ref" -p "vibeview-$ref.tar.gz" -p "vibeview-$ref.tar.gz.sha256" -D "$stage/asset" >/dev/null 2>&1; then
      (cd "$stage/asset" && sha256sum -c --quiet "vibeview-$ref.tar.gz.sha256") || die "Release 附件校验失败"
      asset_sha="$(cut -d' ' -f1 "$stage/asset/vibeview-$ref.tar.gz.sha256")"
      [[ "$asset_sha" == "$local_sha" ]] || die "Release 附件与本地按 $ref 打包的结果不一致（$asset_sha ≠ $local_sha）"
      archive="$stage/asset/vibeview-$ref.tar.gz"; source_label="release asset"
    else
      say "WARN $ref 没有 Release 附件，使用本地按 tag 打包的结果"
      archive="$stage/local/vibeview-$ref.tar.gz"; source_label="local package of tag"
    fi
    label="$ref" ;;
  commit)
    commit="$(git rev-parse -q --verify "$ref^{commit}")" || die "找不到提交 $ref"
    archive="$(bash scripts/package-release.sh "$commit" "$stage/local")"
    say "WARN 部署的是提交 ${commit:0:12}，不是正式版本；之后请补发版本"
    label="${commit:0:12}"; source_label="commit" ;;
  worktree)
    commit="$(git rev-parse HEAD)"
    dirty=""; [[ -n "$(git status --porcelain -- $(grep -vE '^\s*(#|$)' scripts/runtime-files.txt))" ]] && dirty="-dirty"
    label="${commit:0:12}$dirty"
    mapfile -t paths < <(grep -vE '^\s*(#|$)' scripts/runtime-files.txt)
    mkdir -p "$stage/local"
    archive="$stage/local/vibeview-$label.tar.gz"
    tar --transform "s,^,vibeview-$label/," -czf "$archive" -- "${paths[@]}"
    say "WARN 紧急修复模式：部署工作区${dirty:+（含未提交改动）}，不是正式版本；之后请补发版本"
    source_label="worktree" ;;
esac
sha="$(sha256sum "$archive" | cut -d' ' -f1)"
mkdir -p "$stage/new"
tar -xzf "$archive" -C "$stage/new" --strip-components=1
mapfile -t runtime < <(grep -vE '^\s*(#|$)' "$stage/new/scripts/runtime-files.txt" 2>/dev/null || printf '%s\n' server.js render-server.js package.json package-lock.json Dockerfile.render docker-compose.yml lib views scripts bin)
(cd "$stage/new" && find . -type f -printf '%P\n' | sort | xargs -d '\n' sha256sum) > "$stage/new.sha"

# ---- 2. 目标机现状 ----
export VIEW_RUNTIME="${runtime[*]}"
on_target > "$stage/remote.sha" <<'EOF' || die "无法读取目标机 $VIEW_DEPLOY_DIR（缺目录、config.yaml 或 data/）"
set -e
cd "$VIEW_DEPLOY_DIR" && test -f config.yaml && test -d data
for p in $VIEW_RUNTIME; do [ -e "$p" ] && find "$p" -type f; done | sort | xargs -r -d '\n' sha256sum
EOF
current="$(on_target -c 'cat "$VIEW_DEPLOY_DIR/RELEASE" 2>/dev/null | sed -n "s/^version=//p"' || true)"

changed=(); removed=()
declare -A old new
while read -r h f; do old["$f"]="$h"; done < "$stage/remote.sha"
while read -r h f; do new["$f"]="$h"; [[ "${old[$f]:-}" == "$h" ]] || changed+=("$f"); done < "$stage/new.sha"
for f in "${!old[@]}"; do [[ -n "${new[$f]:-}" ]] || removed+=("$f"); done
need_npm=0; need_render=0
for f in "${changed[@]}" "${removed[@]}"; do
  case "$f" in package.json|package-lock.json) need_npm=1; need_render=1 ;; esac
  case "$f" in Dockerfile.render|docker-compose.yml|render-server.js|lib/viewer.js|lib/preview-store.js|lib/preview-routes.js) need_render=1 ;; esac
done

say "目标:   ${VIEW_DEPLOY_HOST:-本机} $VIEW_DEPLOY_DIR（$VIEW_SERVICE_MANAGER $VIEW_SERVICE_NAME）"
say "版本:   ${current:-未记录} → $label（$source_label，提交 ${commit:0:12}）"
say "发布包: sha256 $sha"
say "变更:   ${#changed[@]} 个新增/修改，${#removed[@]} 个删除；npm ci: $([[ $need_npm == 1 ]] && echo 是 || echo 否)；重建 sidecar: $([[ $need_render == 1 ]] && echo 是 || echo 否)"
for f in "${changed[@]}"; do say "  M $f"; done | head -40
for f in "${removed[@]}"; do say "  D $f"; done
if ((!yes)); then say "（预演，未做任何改动。确认后加 --yes 执行）"; exit 0; fi
if ((${#changed[@]} == 0 && ${#removed[@]} == 0)); then say "目标机代码已与 $label 一致，只更新 RELEASE 记录"; fi

# ---- 3. 备份 ----
export VIEW_RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${label}"
export VIEW_REMOVED="${removed[*]}" VIEW_NEED_NPM="$need_npm" VIEW_NEED_RENDER="$need_render"
on_target <<'EOF' || die "备份失败，目标机未改动"
set -euo pipefail
umask 077
b="$VIEW_RELEASES_DIR/$VIEW_RELEASE_ID"
[ ! -e "$b" ] || { echo "备份目录已存在: $b" >&2; exit 1; }
mkdir -p "$VIEW_RELEASES_DIR" && chmod 700 "$VIEW_RELEASES_DIR" && mkdir -m 700 "$b"
cd "$VIEW_DEPLOY_DIR"
existing=(); for p in $VIEW_RUNTIME RELEASE; do [ -e "$p" ] && existing+=("$p"); done
tar -czf "$b/code.tar.gz" "${existing[@]}"
tar -tzf "$b/code.tar.gz" >/dev/null
if [ -f scripts/backup.js ]; then node scripts/backup.js --dest "$b" --keep 0 >"$b/data-backup.log" 2>&1 || { cat "$b/data-backup.log" >&2; exit 1; }; fi
cid="$(RENDER_HOST_PORT=$VIEW_RENDER_PORT docker compose ps -q render 2>/dev/null || true)"
if [ -n "$cid" ]; then img="$(docker inspect -f '{{.Image}}' "$cid")"; docker tag "$img" "vibeview-render:rollback-$VIEW_RELEASE_ID"; echo "$img" > "$b/render-image"; fi
echo "$VIEW_NEED_RENDER" > "$b/render-rebuilt"
echo "备份: $b"
EOF

# ---- 4. 同步并重启；失败自动回滚 ----
rollback() {
  say "FAIL $1，开始回滚到 $VIEW_RELEASE_ID"
  bash "$here/rollback.sh" "$VIEW_RELEASE_ID" || say "FAIL 自动回滚也失败了，需要人工处理（备份在 $VIEW_RELEASES_DIR/$VIEW_RELEASE_ID）"
  exit 1
}
cat "$archive" | on_target -c '
  set -euo pipefail
  cd "$VIEW_DEPLOY_DIR"
  b="$VIEW_RELEASES_DIR/$VIEW_RELEASE_ID"
  for f in $VIEW_REMOVED; do mkdir -p "$b/removed/$(dirname "$f")"; mv "$f" "$b/removed/$f"; done
  tar -xzf - --strip-components=1
' || rollback "同步失败"

export VIEW_LABEL="$label" VIEW_COMMIT="$commit" VIEW_SHA="$sha" VIEW_SOURCE="$source_label"
export VIEW_RESTART="$(service_ctl restart)"
on_target <<'EOF' || rollback "安装或重启失败"
set -euo pipefail
cd "$VIEW_DEPLOY_DIR"
wait_health() { for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$1/healthz" >/dev/null 2>&1 && return 0; sleep 2; done; echo "端口 $1 健康检查超时" >&2; return 1; }
if [ "$VIEW_NEED_NPM" = 1 ] || [ ! -d node_modules ]; then npm ci --omit=dev --no-audit --no-fund >/dev/null; echo "npm ci 完成"; fi
# 新容器的 Docker 健康状态要等第一次探测（最多约 30 秒）才变成 healthy
wait_docker() {
  local cid; cid="$(RENDER_HOST_PORT=$VIEW_RENDER_PORT docker compose ps -q render)"
  for _ in $(seq 1 45); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null)" = healthy ] && return 0; sleep 2; done
  echo "sidecar 容器未变为 healthy" >&2; return 1
}
if [ "$VIEW_NEED_RENDER" = 1 ]; then RENDER_HOST_PORT=$VIEW_RENDER_PORT docker compose up -d --build render >/dev/null 2>&1; wait_health "$VIEW_RENDER_PORT"; wait_docker; echo "sidecar 已重建"; fi
$VIEW_RESTART
wait_health "$VIEW_MAIN_PORT"
umask 077
printf 'version=%s\ncommit=%s\nsource=%s\nsha256=%s\ndeployed_at=%s\nrelease_id=%s\n' \
  "$VIEW_LABEL" "$VIEW_COMMIT" "$VIEW_SOURCE" "$VIEW_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$VIEW_RELEASE_ID" > RELEASE
echo "主服务已重启"
EOF

bash "$here/check.sh" || rollback "上线检查失败"
say "完成：$label 已部署（备份 $VIEW_RELEASES_DIR/$VIEW_RELEASE_ID）"
