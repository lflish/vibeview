---
name: deploy-view
description: 把 vibeview 的某个版本部署到线上（本机或 SSH 服务器）：预演、备份、同步、按需重建 sidecar、重启、验证，失败自动回滚。默认部署已发布的 tag；出版本、打 tag 用 release skill。用户要求部署、上线、更新线上版本、回滚或检查部署时使用。
---

# 部署 vibeview

从项目根目录执行命令。用户已经要求部署时直接完成部署流程；仅要求检查或预演时不执行生产变更。这个 skill 只部署已有的版本或提交，**不打 tag、不改版本号**；出版本用 `$release`。

## 部署目标

部署目标只来自环境变量或 `.agents/skills/deploy-view/local.env`（不提交，模板见 `local.env.example`）。**仓库里不写真实主机、IP、用户名、目录或域名**；报告和提交信息里也不要写出这些值。缺少 `local.env` 时向用户要这些值，不要猜。

| 变量 | 含义 |
| --- | --- |
| `VIEW_DEPLOY_HOST` | 空 = 本机部署；否则是 SSH 目标（别名或 `user@host`） |
| `VIEW_DEPLOY_DIR` | 目标机服务目录，与开发仓库分开 |
| `VIEW_RELEASES_DIR` | 发布备份目录，缺省为服务目录旁的 `vibeview-releases/` |
| `VIEW_PUBLIC_URL` | 对外 HTTPS 地址 |
| `VIEW_MAIN_PORT` / `VIEW_RENDER_PORT` | 主服务、render sidecar 的本地端口（缺省 3000 / 3001） |
| `VIEW_SERVICE_MANAGER` / `VIEW_SERVICE_NAME` | `systemd-user` 或 `pm2`，以及服务名（缺省 `vibeview`） |

`scripts/env.sh` 读取这些变量，并提供 `on_target`（在目标机执行脚本，本机或 SSH）和 `service_ctl`（生成重启/停止命令）。下文命令里的 `$VIEW_*` 都指这些值。

每次发布先核实连接和服务。只操作本项目的服务、目录和 Compose 项目，不要动目标机上的其他应用、nginx 站点或容器。

保留目标机的 `config.yaml`、`data/`、`.env`、证书和 nginx 配置。不要把开发仓库的配置、上传数据或 `node_modules/` 覆盖到服务目录。JSON 元数据在 `data/meta/`，`resources.sqlite` 索引在主服务启动时重建；独立的 `statistics.directory` 事件日志和 `visits.sqlite` 不可重建，必须保留并备份。代码回滚不回滚用户数据。

主服务与 sidecar 共享随机 gateway 密钥：主服务使用 `DVIEW_RENDER_GATEWAY_TOKEN` 或 `preview.gateway_token`，Compose 从服务目录的 `.env` 把 `DVIEW_RENDER_GATEWAY_TOKEN` 传给容器。发布时核实两者一致；缺失时生成 32 字节随机密钥写入服务器配置和权限 600 的 `.env`，不要打印、提交或用本地文件覆盖。密钥缺失时受保护预览会拒绝访问，不能仅凭 healthz 就报告上线通过。

主服务放在反向代理后面时，配置 `server.host: 127.0.0.1` 和 `server.trust_proxy: loopback`，外部只能经代理访问。

目标机的 nginx 结构、证书方式等主机相关说明写在 `local.env` 的注释里，发布前先读。若 443 由 nginx `stream` 按 SNI 分流并开启 `proxy_protocol`，vibeview 站点必须以 `proxy_protocol` 监听并用 `real_ip_header proxy_protocol` 取访客 IP；其他后端经中转去掉 PROXY 头。改动这类 nginx 配置前备份、`nginx -t`，reload 后逐个核对所有分流目标的响应，异常立即恢复备份。

## 工作流程

1. 确认要部署的版本（见 [部署与回滚操作](references/deploy.md)）：默认是用户指定的或最新的 tag。部署未发版的提交或工作区属于例外，需要用户明确要求。
2. 执行只读检查 `bash .agents/skills/deploy-view/scripts/check.sh`，它会显示目标机当前部署的版本（`RELEASE` 记录）。区分原有故障和新回归；连接或磁盘有问题时停止。
3. 部署正式版本时，它的 CI 已经在发版时通过，不必重跑全部测试。部署 `--commit` / `--worktree` 时，先在本地跑 `SMOKE_SKIP_RENDER=1 npm test`，相关改动再跑 `npm run test:access`、`npm run test:browser` 或 `npm run smoke:render`；跑不了的明确记录。
4. 涉及统计功能时先读 [统计发布验证](references/statistics.md)。
5. 预演：`bash .agents/skills/deploy-view/scripts/deploy.sh <版本>`，把版本变化和文件变更告诉用户。然后加 `--yes` 执行。脚本会备份、同步、按需 `npm ci` / 重建 sidecar、重启、写 `RELEASE` 并检查；失败自动回滚。
6. 对本次功能做实际验证；页面修改还应检查服务返回的内容，不能只看磁盘文件。需要手动回滚时用 `scripts/rollback.sh <release_id>`。不要对失败的部署无限重试；同一原因一次修复仍失败时保留证据并报告阻塞。

## 验证与报告

- 检查脚本验证服务状态、主服务/sidecar 健康接口、Docker 健康状态和公网 TLS；它不覆盖登录、管理 API 或预览功能。
- 管理接口验证在目标机读取配置并建立临时会话，不在命令或输出中暴露凭据。用 `GET /admin/api/list?pageSize=1` 检查列表；功能测试只使用可辨识的临时资源，清理自己创建的测试数据。
- 公网请求必须验证证书。`curl -k` 只可用于定位故障，不可作为上线成功证据。
- 访问保护：确认历史资源默认加锁、新上传返回 `url`、`accessCode`、`access.expiresAt`，所有 HTML 预览（含公开）带 `sandbox` CSP。新访问码不写入发布日志，临时验证资源验证后删除。重试计数在 `access.attempts_file` 中，不纳入代码同步或回滚；计数实现要求单个主服务进程。
- 证书或 nginx 需要 sudo 时，向用户说明具体命令，不能通过 Docker 绕过权限。普通发布不顺便修改 nginx。
- 最终报告：部署的版本和提交、发布包 SHA-256、备份路径（release_id）、服务与 sidecar 状态、实际验证结果和未解决的问题（主机信息用变量名指代）。若回滚，明确当前运行的是旧版本。
