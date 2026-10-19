# 部署与回滚操作

仅在用户要求部署时执行，从仓库根目录运行。部署目标来自 `VIEW_*` 变量或 `local.env`（见 SKILL.md）。

## 选择要部署的内容

| 命令 | 用途 |
| --- | --- |
| `scripts/deploy.sh vX.Y.Z` | **默认**。部署正式版本：下载 GitHub Release 附件，并与本地按 tag 重新打包的结果比对 SHA-256；没有附件时（如早期版本）用本地按 tag 打包的结果，并给出提示 |
| `scripts/deploy.sh --commit <ref>` | 部署某个已提交但未发版的提交。部署后提醒用户补发版本 |
| `scripts/deploy.sh --worktree` | 紧急修复：部署工作区，包括未提交的改动。只在用户明确要求时使用，事后补发版本 |

用户没说部署哪个版本时，用最新的 tag（`git describe --tags --abbrev=0`），并在执行前告诉用户。

## 执行

1. 先不带 `--yes` 运行，得到预演：目标机、当前版本 → 新版本、发布包 SHA-256、新增/修改/删除的文件、是否需要 `npm ci` 和重建 sidecar。预演不改动目标机。把预演结果告诉用户，确认无误后再执行。
2. 加 `--yes` 执行。脚本依次：
   - 在 `$VIEW_RELEASES_DIR/<release_id>`（权限 700）备份：运行时代码 `code.tar.gz`、原 `RELEASE` 记录、`scripts/backup.js` 打的数据包（含配置）、当前 sidecar 镜像（打上 `vibeview-render:rollback-<release_id>` 标签）。备份失败就停止，目标机不变。
   - 把目标机上本次要删除的代码文件移到备份目录的 `removed/`，再解压发布包覆盖运行时文件。`config.yaml`、`.env`、`data/`、`node_modules/` 不动。
   - `package.json` / 锁文件变了才 `npm ci --omit=dev`；sidecar 相关文件变了才重建 sidecar，并等到 HTTP 健康和 Docker 健康状态都正常。
   - 重启主服务，等健康检查通过，写入 `RELEASE`（版本、提交、来源、SHA-256、部署时间、release_id）。
   - 运行 `scripts/check.sh`。
3. 安装、重启或上线检查任一步失败，脚本**自动回滚**到本次备份并重新检查，最后以失败退出。报告时说明当前运行的是旧版本，以及失败原因（失败代码保存在备份目录的 `failed-code-*`）。

## 手动回滚

```bash
bash .agents/skills/deploy-view/scripts/rollback.sh <release_id>
```

`release_id` 是部署输出里的备份目录名。它把当前运行时代码移到 `failed-code-*`，恢复 `code.tar.gz`，执行 `npm ci`；若该次部署重建过 sidecar，就用保存的旧镜像恢复；最后重启并检查。回滚只恢复代码，不恢复数据。

如本次版本引入不可逆的数据格式变更，部署前先制定迁移和回退方案；代码回滚不能恢复旧数据结构。备份和旧镜像不要自动清理。

## 首次部署到新目标机

`deploy.sh` 要求服务目录里已有 `config.yaml` 和 `data/`。新机器先手动准备：建服务目录，**先以服务用户创建 `data/`**（否则 `docker compose up` 会以 root 身份创建它，主服务随后无法写入），放好 `config.yaml`（`server.host`、`base_url`、gateway 密钥）和权限 600 的 `.env`，配置 systemd 用户服务或 pm2，然后再用 `deploy.sh` 部署版本。
