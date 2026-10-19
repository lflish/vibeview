# 发布与回滚操作

仅在用户要求发布时执行。下列操作从仓库根目录开始，先加载部署变量：

```bash
source .agents/skills/deploy-view/scripts/env.sh
```

使用本次唯一的 `release_id` 贯穿记录，确认每步成功后再继续。同步用 `tar` 管道，本机和 SSH 目标都适用，不依赖 rsync。

## 运行时文件白名单

```bash
RUNTIME="server.js render-server.js package.json package-lock.json Dockerfile.render docker-compose.yml lib views scripts bin"
```

项目新增运行时目录时，先检查用途并更新白名单；不要扩大到配置、数据或秘密文件。

## 固定本地快照并预演

```bash
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
release_stage="$(mktemp -d "${TMPDIR:-/tmp}/vibeview-release.XXXXXX")"
tar -cf - $RUNTIME | tar -xf - -C "$release_stage"
```

快照包含未提交文件并保留目录层级。记下 `git status`、提交号及快照内容。测试针对这个快照运行（先 `npm ci`）；已验证且与快照完全一致的工作区结果可以复用。在快照目录运行访问保护测试前，额外复制 `skill/` 作为测试输入（`cp -R skill "$release_stage/"`），它不进入同步白名单。

预演即比对校验和清单，列出新增、修改和删除的文件：

```bash
(cd "$release_stage" && find $RUNTIME -type f -exec sha256sum {} + | sort -k2) > "$release_stage.local.sha"
on_target <<'EOF' > "$release_stage.remote.sha"
cd "$VIEW_DEPLOY_DIR" && find server.js render-server.js package.json package-lock.json Dockerfile.render docker-compose.yml lib views scripts bin -type f -exec sha256sum {} + 2>/dev/null | sort -k2
EOF
diff "$release_stage.remote.sha" "$release_stage.local.sha"
```

只在目标机存在的白名单文件是本次要删除的代码文件，单独列出，备份后再移走；不要顺带清理不认识的文件。

## 备份与同步

统计版本还需按 [统计发布验证](statistics.md) 备份资源元数据和独立事件日志。不要把 `statistics.directory` 当作可以删除后重建的索引；它不在代码同步白名单中。

在目标机创建 `$VIEW_RELEASES_DIR/<release_id>`（权限 `700`），确认磁盘空间和备份目录不存在，拒绝覆盖旧备份。在服务目录把白名单里实际存在的路径打包为该目录下的 `code.tar.gz`，并保存文件列表/校验和、当前主服务与 sidecar 状态、当前 render 镜像 ID；给该镜像打 `vibeview-render:rollback-<release_id>` 标签以免丢失。`tar -tzf` 能读取备份后才同步。不要输出 `pm2 jlist` 或 `systemctl show` 的全量内容，里面可能含环境变量秘密。数据也可以用 `node scripts/backup.js --dest "$VIEW_RELEASES_DIR/<release_id>" --keep 0` 一并打包。

同步（覆盖白名单文件，不删除其他文件）：

```bash
(cd "$release_stage" && tar -cf - $RUNTIME) | on_target -c 'cd "$VIEW_DEPLOY_DIR" && tar -xf -'
```

> `on_target` 默认从 stdin 读脚本；同步时改用 `-c '<命令>'`，stdin 用来传 tar 数据。

依赖和构建在目标机服务目录执行：

```bash
on_target <<EOF
set -e
cd "\$VIEW_DEPLOY_DIR"
npm ci --omit=dev
RENDER_HOST_PORT=\$VIEW_RENDER_PORT docker compose up -d --build render
$(service_ctl restart)
EOF
```

锁文件未变且依赖完整时可跳过 `npm ci`。Dockerfile、Compose、render-server、其依赖的 lib 或包依赖未变时可跳过 sidecar 重建。重建 sidecar 后先验证 `127.0.0.1:$VIEW_RENDER_PORT/healthz` 再重启主服务。pm2 部署普通代码发布无需 `--update-env`。

健康检查允许有限启动时间（例如每 2 秒一次，最多 30 次）。上线后运行 `scripts/check.sh` 并验证修改的功能。用 SHA-256 清单比对快照与目标机白名单文件，不比较 `node_modules` 和数据。

## 回滚

先验证目标备份包含预期文件，保存本次失败日志。将目标机当前白名单路径移至本次备份下的 `failed-code/`，再把 `code.tar.gz` 解压到服务目录；这样新增代码文件不会残留，`config.yaml`、`.env` 和 `data/` 始终不动。移动前核对路径，只操作白名单。

1. 按恢复的锁文件执行 `npm ci --omit=dev`。
2. 若 sidecar 已更新，用保存的旧镜像标签和临时 Compose override 指定 `services.render.image`，执行 `RENDER_HOST_PORT=$VIEW_RENDER_PORT docker compose -f docker-compose.yml -f <override> up -d --no-build --pull never render`。没有保留镜像时只能按恢复后的 Dockerfile 重建，并说明该限制。
3. sidecar 健康后重启主服务（`service_ctl restart`），再次验证本地和公网。

如本次功能引入不可逆的数据格式变更，发布前先制定迁移和回退方案；通用代码回滚不能恢复旧数据结构。备份和旧镜像不要在发布后自动清理。
