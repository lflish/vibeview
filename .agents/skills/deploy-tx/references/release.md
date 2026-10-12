# 发布与回滚操作

仅在用户要求发布时执行。下列操作从仓库根目录开始；使用本次唯一的 `release_id` 贯穿记录，确认每步成功后再继续。

## 固定本地快照并预演

```bash
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
release_stage="$(mktemp -d "${TMPDIR:-/tmp}/vibeview-release.XXXXXX")"
rsync -aR server.js render-server.js package.json package-lock.json \
  Dockerfile.render docker-compose.yml lib views scripts bin "$release_stage/"
```

这是运行时文件白名单，包含未提交文件并保留目录层级。项目新增运行时目录时，先检查用途并更新白名单；不要扩大到配置、数据或秘密文件。记下 `git status`、提交号及快照内容，运行测试应针对这个快照（先 `npm ci`），已验证且与快照完全一致的工作区结果可以复用。

在快照目录运行访问保护测试前，额外复制仓库的 `skill/` 目录作为测试输入：`cp -R skill "$release_stage/"`。其中的上传脚本用于 CLI 兼容性验证；这个测试输入不改变下方运行时同步白名单。

```bash
(
  cd "$release_stage"
  rsync -azRnic server.js render-server.js package.json package-lock.json \
    Dockerfile.render docker-compose.yml lib views scripts bin \
    tx:/home/lflish/vibeview/
)
```

检查变更清单。使用快照目录内的相对路径：部分 macOS rsync 不支持绝对路径的 `/./` 截断，会错误复制完整本地目录树。`bin/` 是 CLI 冒烟测试所需。不要使用对整个服务目录生效的 `--delete`。已删除的代码文件需单独列出并在备份后移走；不要顺带清理不认识的远端文件。

## 备份与同步

统计版本还需按 [统计发布验证](statistics.md) 备份资源元数据和独立事件日志。不要把 `statistics.directory` 当作可以删除后重建的 SQLite 索引；它不在代码同步白名单中。

在 SSH 中创建 `/home/lflish/vibeview-releases/<release_id>`（权限 `700`），确认磁盘空间和备份目录未存在，拒绝覆盖旧备份。

进入远端 `/home/lflish/vibeview`，将以下实际存在的运行时路径打包为备份目录内的 `code.tar.gz`：

```text
server.js render-server.js package.json package-lock.json
Dockerfile.render docker-compose.yml lib views scripts bin
```

保存文件列表/校验和、当前主服务与 sidecar 状态、当前 render 镜像 ID 到备份目录，给该镜像增加 `vibeview-render:rollback-<release_id>` 标签以避免丢失。检查 `tar -tzf` 能读取备份后才同步。不要输出 `pm2 jlist` 全量内容，里面可能含环境变量秘密。

重复预演命令，去掉 `n`（`-azRic`）进行实际同步。不能使用 `rsync views/admin.html ... target/` 这类会丢失目录层级的命令。依赖和构建操作必须在远端服务目录执行：

```bash
npm ci --omit=dev
RENDER_HOST_PORT=3213 docker compose up -d --build render
pm2 restart vibeview
```

锁文件未变且依赖完整时可跳过 `npm ci`。Dockerfile、Compose、render-server、其依赖的 lib 或包依赖未变时可跳过 sidecar 重建。重建 sidecar 后先验证 `3213/healthz` 再重启主服务；不要省略 `RENDER_HOST_PORT=3213`。普通代码发布无需 `pm2 --update-env`，保留已有运行环境。

健康检查允许有限启动时间（例如每 2 秒一次，最多 30 次）。上线后运行 `scripts/check.sh`（技能目录内）并对修改功能验证。删除文件和新增文件都要核对；用 SHA-256 清单比对快照与远端白名单文件，不比较 `node_modules` 和数据。

## 回滚

先验证目标备份包含预期文件，保存本次失败日志。将远端当前白名单路径移至本次备份下的 `failed-code/`，再将 `code.tar.gz` 解压到服务目录；这样新增代码文件不会残留，`config.yaml` 和 `data/` 始终不动。移动前核对路径，只操作上述白名单。

1. 按恢复的锁文件执行 `npm ci --omit=dev`。
2. 若 sidecar 已更新，用保存的旧镜像标签和临时 Compose override 指定 `services.render.image`，执行 `RENDER_HOST_PORT=3213 docker compose -f docker-compose.yml -f <override> up -d --no-build --pull never render`。提前检查当前 Compose 支持这些参数。没有保留镜像时只能按恢复后的 Dockerfile 重建，并明确该限制。
3. sidecar 健康后 `pm2 restart vibeview`，再次验证本地和公网。

如本次功能引入不可逆的数据格式变更，发布前先制定对应迁移和回退方案；通用代码回滚不能恢复旧数据结构。备份和旧镜像不要在发布后自动清理。
