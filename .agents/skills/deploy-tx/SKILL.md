---
name: deploy-tx
description: 发布当前 vibeview 项目到 TX 服务器，包括发布前检查、代码备份与同步、PM2 重启、Docker render sidecar 更新、部署验证和故障回滚。用户要求发布到 TX、更新线上版本或检查 TX 部署时使用。
---

# 发布 vibeview 到 TX

从项目根目录执行命令。用户已经要求发布时直接完成发布流程；仅要求检查、预演或创建技能时不执行生产变更。

## 部署约定

| 项目 | 当前值 |
| --- | --- |
| SSH | `tx`，用户 `lflish`，主机 `49.232.218.170` |
| 服务目录 | `/home/lflish/vibeview` |
| 主服务 | PM2 应用 `vibeview`，端口 `3210` |
| Sidecar | Compose 服务 `render`，宿主机 `127.0.0.1:3213` → 容器 `3001` |
| 访问地址 | `https://view.lflish.fun` |
| 发布备份 | `/home/lflish/vibeview-releases/<时间戳>/` |

这些值是本项目已验证的部署约定，每次发布先核实连接和服务。不要操作同机其他 PM2 应用。

保留服务器的 `config.yaml`、`data/`、环境变量、证书和 Nginx 配置。不要把本地配置、上传数据或 `node_modules/` 覆盖到服务器。JSON 元数据在 `data/meta/`，SQLite 索引在主服务启动时重建；代码回滚不回滚用户数据。

现有配置为 `preview.proxy_to_render: true`、`preview.render_url: http://127.0.0.1:3213`、`storage.retention_days: 0`。仅在任务涉及配置时修改对应字段，不打印账号、口令和 token。

访问码版本的 Sidecar 还需要主服务与 Compose 共享随机 gateway 密钥：主服务使用 `DVIEW_RENDER_GATEWAY_TOKEN` 或 `preview.gateway_token`，Compose 将 `DVIEW_RENDER_GATEWAY_TOKEN` 传为容器的 `RENDER_GATEWAY_TOKEN`。发布该版本时核实两者一致；缺失时生成 32 字节随机密钥，保存在服务器配置及受限 `.env`，不要打印、提交或用本地文件覆盖远端 `.env`。只有修改 PM2 环境变量时才使用 `--update-env`；配置文件方式普通重启即可。密钥缺失时受保护预览会拒绝访问，不能仅凭 healthz 就报告上线通过。

## 工作流程

1. 检查 `git status --short` 和本次修改，确认用户想发布的内容。未提交的新文件也可能是发布内容，不能只用 `git archive HEAD`；保留用户工作区，不自动提交或推送。
2. 执行只读线上检查：
   ```bash
   bash .agents/skills/deploy-tx/scripts/check.sh
   ```
   区分原有故障和新回归。SSH、磁盘或备份失败时停止发布；仅公网证书失败不等于本地服务失败，也不能报告完整验证通过。
3. 本地运行 `SMOKE_SKIP_RENDER=1 npm test`。访问保护有改动时运行 `npm run test:access`，覆盖持久化重试限制、原文件授权及 Sidecar 防绕过。管理界面有改动时运行 `npm run test:admin`，需要可用的 Playwright 和 Chromium；缺失时明确记录，不声称通过。渲染相关改动需要可用 Docker 的环境运行 `npm run smoke:render`。读取测试脚本，确认使用隔离数据后再在服务器运行测试。
4. 按 [发布与回滚操作](references/release.md) 创建固定发布快照、备份线上代码、预演同步、发布、更新依赖、重建 sidecar 和重启主服务。不要在测试后继续从可能变化的工作区直接同步。
5. 再次运行只读检查，核对远端代码与发布快照的校验和。对本次功能做实际验证；页面修改还应检查服务返回的内容，不能只看磁盘文件。
6. 主服务或 sidecar 因本次发布无法恢复时，执行该次备份的代码回滚并重新验证。不要对失败发布无限重试；同一原因一次修复仍失败时保留证据并报告阻塞。

## 验证与报告

- 检查脚本验证 PM2 状态、主服务/sidecar 健康接口、Docker 健康状态和公网 TLS；它不覆盖登录、管理 API 或预览功能。
- 管理接口验证可在服务器读取配置并建立临时会话，避免在命令或输出中暴露凭据。使用 `GET /admin/api/list?pageSize=1` 检查列表；实际功能测试只使用可辨识的临时资源，清理自己创建的测试数据。
- 公网请求必须验证证书。`curl -k` 只可用于定位故障，不可作为上线成功证据。
- 访问保护上线时，确认历史资源默认加锁、新上传返回 `url`、`accessCode`、`access.expiresAt`；Skill 与 CLI 的变更也纳入快照。新访问码不写入发布日志，临时验证资源验证后删除。重试计数在 `access.attempts_file` 中，不纳入代码同步或回滚；当前计数实现要求单个主服务进程。
- 截至 2026-10-10，公网证书曾过期，SSH 用户无免密 sudo。每次实时验证，不把旧故障当作当前事实。需要安装证书时参考已有 `scripts/install-nginx-cert.sh`；需要交互 sudo 则向用户说明具体命令，不能通过 Docker 绕过权限。普通发布不顺便修改 Nginx。
- 最终报告：发布内容/版本、备份路径、服务与 sidecar 状态、实际测试结果、公网地址和未解决的问题。若回滚，明确当前运行的是旧版本。
