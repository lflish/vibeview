# vibeview 使用指南

[← README.md](../README.md) · [English](user-guide.en.md)

服务名是 **vibeview**，命令行工具名是 **`dview`**。支持 HTML、PNG / JPG / GIF / WebP / SVG 等图片，以及 MP4 / WebM 视频。HTML 简介优先读取上传的 `description`，否则从 `<meta name="description">`、`<title>` 或标题提取。默认单文件上限 50 MB，文件永久保留。

## 快速开始

### 1. 安装并准备配置

使用 **Node.js 22** 和 npm，与项目的 render 镜像版本一致。上传 CLI 需要 Bash、curl，以及 Python 3 或 Node.js；Skill 上传脚本需要 Python 3。Docker 仅在使用 sidecar 时需要。

```bash
git clone https://github.com/lflish/vibeview.git
cd vibeview
npm ci
cp config.example.yaml config.yaml
```

编辑 `config.yaml`，至少设置这些字段：

| 字段 | 本地运行时的设置 |
| --- | --- |
| `server.base_url` | `http://localhost:3000`；上线时改为实际 HTTPS 地址 |
| `tokens[].name` | 唯一的上传来源名，例如 `my-machine` |
| `tokens[].token` | 自己生成的随机上传 token |
| `admin.user` / `admin.password` | 管理员用户名和自己的密码 |
| `admin.session_secret` | 自己生成的随机 session 签名密钥 |

可以用 `openssl rand -hex 24` 分别生成 token 和 session secret。`config.yaml` 已被 Git 忽略，其中的凭据不要提交到仓库。

### 2. 启动服务

```bash
npm start
```

打开 [http://localhost:3000/admin](http://localhost:3000/admin)，用配置中的管理员账号登录。健康检查：

```bash
curl -fsS http://localhost:3000/healthz
```

### 3. 上传一个文件

在另一个终端设置上传凭据：

```bash
export DVIEW_URL="http://localhost:3000"
export DVIEW_TOKEN="你的上传 token"

bash bin/dview upload /path/to/report.html --json
```

示例响应（访问码与时间以实际响应为准）：

```json
{
  "url": "http://localhost:3000/v/Ab3xK9mP2qR7sT1v",
  "id": "Ab3xK9mP2qR7sT1v",
  "source": "my-machine",
  "description": "季度报告",
  "access": {
    "required": true,
    "configured": true,
    "expiresAt": "2026-10-19T12:00:00.000Z",
    "expired": false
  },
  "accessCode": "G7mK9pRX4aQ2"
}
```

浏览器打开 `url`，输入 `accessCode` 即可预览。**保存访问码和到期时间，建议将访问码与链接分开分享。** 服务端只保存访问码哈希，忘记后需要重置，不能查询原码。

## 上传与分享

### CLI

在仓库内使用 `bash bin/dview`，或执行 `npm link` 将命令注册为 `dview`。CLI 通过本仓库或安装脚本分发，尚未发布到 npm registry。

```bash
dview upload ./report.html --json                 # 链接、访问码、到期时间
dview upload ./report.html --json --access-days 1 # 访问码有效期 1 天
dview upload ./public.html --public               # 显式设为免验证
dview list                                       # 本账户资源
dview me                                         # 本账户用量与配置
dview delete Ab3xK9mP2qR7sT1v                      # 删除本账户资源
```

普通上传的 stdout 只输出 URL，访问码输出到 stderr。**AI、脚本和 CI 应使用 `--json`，保留 `url`、`accessCode`、`access.expiresAt` 三个字段。** 访问码不要放进 URL 或生成的 HTML 中。

### curl

```bash
curl -fsS -X POST "${DVIEW_URL%/}/upload" \
  -H "Authorization: Bearer $DVIEW_TOKEN" \
  -F "file=@./report.html" \
  --form-string "description=季度报告与关键指标"
```

可选表单字段：`access_days=7` 指定访问码有效天数，`access_mode=public` 明确开放公开访问。未指定时按服务端默认配置处理。

### AI Skill 与工具接入

- **Claude Code**：运行 `bash install-skill.sh --url "$DVIEW_URL" --token "$DVIEW_TOKEN"`，安装上传 Skill、`/dview` 命令及 CLI。安装器默认将环境变量写入 shell 配置文件。
- **Codex / Cursor / 其他 Agent**：参考 [AGENTS.md](../AGENTS.md) 和 [上传 Skill](../skill/dview-upload/SKILL.md)，生成文件后使用 CLI 或 `bash skill/dview-upload/upload.sh <文件> --json`。本仓库的 `install-skill.sh` 默认安装到 Claude 目录，其他工具可按各自目录约定安装 Skill。
- **生成页面**：上传 Skill 默认使用浅色风格；仅上传已有文件时保留原样。
- **GitHub Actions**：参考 [工作流示例](../examples/github-actions/upload-preview.yml)，配置 Secrets `DVIEW_URL`、`DVIEW_TOKEN`。该示例目前只评论链接；接入受保护预览时，还需要保存上传响应中的访问码，并选择合适的分享渠道。

## 页面管理

访问 `/admin` 可以：

- 查看文件名、简介、来源、大小、创建时间、持续时长和访问保护状态。
- 搜索文件名、简介、来源或 ID，按类型 / 来源筛选，排序和分页浏览。
- 复制预览链接，删除单条资源或批量删除当前页选中资源。
- 在「访问保护」中生成 / 重置访问码，设置到期时间、不过期或免验证。
- 查看各账户的用量与配额，停用 / 启用账户，切换管理页面主题。

上传账户在 `config.yaml` 的 `tokens` 中维护；管理端目前不提供创建账户或轮换 token 的功能。修改配置后需要重启主服务。

## 访问保护与文件保留

这三个概念各有用途：

| 配置 / 凭据 | 用途 | 默认行为 |
| --- | --- | --- |
| 上传 token | 允许机器或用户上传、管理本账户文件 | 必须在服务端配置 |
| 页面访问码 | 允许访客查看某个预览及其原文件 | 新上传随机生成，默认有效期 7 天 |
| 文件保留期 | 控制文件是否被自动删除 | `storage.retention_days: 0`，永久保留 |

访问码过期只限制访问，**不会删除文件**。历史页面默认也加锁，需要在管理端生成访问码或显式设为公开。重置访问码或调整保护设置会撤销已有访问授权；主服务重启也会撤销已授权的预览 cookie，访问码本身仍有效。

默认每个页面 **10 分钟内最多失败 10 次**，超限返回 `429` 和 `Retry-After`。失败计数跨 IP 累计、持久化保存，重启不能清空限制；冷却期结束后恢复。持续猜码会暂时限制该页面的所有访客。当前计数实现由单个主服务进程维护。

个人使用可以只配置一个上传 token，省略 `max_files` 和 `max_storage_mb`；账户配额是可选的本机文件数 / 存储限制。配额不涉及付费账户或外部 AI 服务额度。

完整配置见 [config.example.yaml](../config.example.yaml)，常用选项如下：

| 字段 | 默认值 / 说明 |
| --- | --- |
| `server.port` / `server.base_url` | `3000` / 对外预览地址 |
| `storage.max_size_mb` | `50`，单文件大小上限 |
| `storage.retention_days` | `0`；正数会自动删除超过该天数的文件 |
| `tokens[].max_files` / `max_storage_mb` | 不设则不限制该账户用量 |
| `tokens[].retention_days` | 覆盖全局保留期；`0` 为永久保留 |
| `access.default_required` / `protect_legacy` | `true` / `true`，新文件与历史文件默认加锁 |
| `access.default_days` / `grant_minutes` | `7` 天 / `30` 分钟的预览授权 |
| `access.max_attempts` / `retry_window_minutes` | `10` 次 / `10` 分钟 |
| `access.attempts_file` | `./data/preview-attempts.json`，失败计数文件 |
| `preview.proxy_to_render` / `render_url` | `false` / `http://127.0.0.1:3001` |

配置默认从项目根目录的 `config.yaml` 读取，可通过 `DVIEW_CONFIG_PATH`（或 `CONFIG_PATH`）指定其他文件。相对存储路径按**配置文件所在目录**解析。启用自动清理时，主服务启动即清理一次，之后每 6 小时执行一次；已删除的文件无法通过调整配置恢复。

## 部署

### 主服务

主服务负责上传、访问验证、管理、账户和清理，可用 PM2 或 systemd 守护。对外服务需要反向代理和 HTTPS，并将 `server.base_url` 设置为实际域名。

备份 `config.yaml`、上传数据及受限环境文件。JSON 元数据是资源的权威记录，`data/resources.sqlite` 是可重建的查询索引。配置中的 token、密码和 session secret 不要公开；上传凭据应只发给需要上传的机器或用户。

### Docker render sidecar

Sidecar 只负责渲染预览，主服务继续运行在宿主机。容器只读挂载 `./data`，不挂载 `config.yaml`；受保护预览必须经主服务验证后进入 sidecar。

停止已运行的主服务后，在同一终端执行：

```bash
mkdir -p data/html data/images data/videos data/meta
export DVIEW_RENDER_GATEWAY_TOKEN="$(openssl rand -hex 32)"

RENDER_HOST_PORT=3001 docker compose up -d --build render
curl -fsS http://127.0.0.1:3001/healthz

DVIEW_PREVIEW_PROXY=true \
DVIEW_RENDER_URL=http://127.0.0.1:3001 \
npm start
```

主服务与 Compose 必须使用**同一个** gateway 密钥。正式部署应将密钥保存到受限的环境配置中，保证重启时仍一致；主服务也可使用 `preview.gateway_token`，Compose 则读取 `DVIEW_RENDER_GATEWAY_TOKEN`。该密钥不要提交到仓库。

端口被占用时，可设置其他 `RENDER_HOST_PORT`，同时修改主服务的 `preview.render_url` 或 `DVIEW_RENDER_URL`。Sidecar 端口只绑定 loopback；容器不可用时预览会报错，不会静默回退到主服务直接渲染。启用 sidecar 时，主服务的存储目录必须与容器挂载的 `./data` 一致。

[Sidecar 设计](../docs/design-render-sidecar.md) · [本项目的 TX 发布 Skill](../.agents/skills/deploy-tx/SKILL.md)

### HTML 的浏览器行为

只上传可信内容。受保护 HTML 使用 `sandbox allow-scripts` 隔离同源权限；脚本可以运行，但浏览器存储和同源请求可能不可用，依赖这些能力的页面需要适配。显式公开的 HTML 不应用该隔离。Docker sidecar 提供服务端进程隔离，不能代替浏览器端隔离。

浏览器提示 `NET::ERR_CERT_DATE_INVALID` 时，检查实际对外证书的有效期；续期后还需安装证书并重新加载反向代理。项目提供 [Nginx 证书安装辅助脚本](../scripts/install-nginx-cert.sh)，其目标路径需要与部署配置一致，执行需要管理员的 sudo 权限。

## API

| 方法与路径 | 认证 | 用途 |
| --- | --- | --- |
| `POST /upload` | Bearer 上传 token | 上传文件，返回链接、访问状态和新访问码 |
| `GET /api/me` | Bearer 上传 token | 本账户信息、用量与配额 |
| `GET /api/me/items` | Bearer 上传 token | 列出本账户资源 |
| `DELETE /api/me/items/:id` | Bearer 上传 token | 删除本账户资源 |
| `PATCH /api/me/items/:id/access` | Bearer 上传 token | 修改本账户资源的访问保护 |
| `GET /v/:id` | 公开，或已验证的预览 cookie | 预览页面；未授权时显示访问码表单 |
| `POST /v/:id/unlock` | 表单中的 `code` | 验证访问码并设置预览 cookie |
| `GET /v/:id/raw` | 与预览页相同 | 获取原文件，支持 Range 请求 |
| `GET /admin/api/list` | 管理员 session | 分页、搜索、筛选和排序 |
| `PATCH /admin/api/item/:id/access` | 管理员 session | 生成 / 重置 / 修改访问保护 |
| `DELETE /admin/api/item/:id` | 管理员 session | 删除单条资源 |
| `DELETE /admin/api/items` | 管理员 session | 批量删除，JSON 为 `{"ids":["id1","id2"]}`，最多 100 条 |
| `GET /admin/api/accounts` | 管理员 session | 账户列表与用量 |
| `POST /admin/api/accounts/:name/disable` 或 `/enable` | 管理员 session | 停用或启用账户 |
| `GET /healthz` | 无 | 主服务或 sidecar 的浅健康检查 |

访问保护的 PATCH body 使用 `mode: "code"` 或 `"public"`、`expiresAt`（ISO 时间或 `null` 表示不过期）、`reset: true`（重新生成）。新访问码仅在生成响应中返回，列表不会返回原码或哈希。

管理列表支持 `page`、`pageSize`（最大 100）、`q`、`type`、`source`、`sort=time|name|size|type|source`、`order=asc|desc`；响应包含 `items`、`total`、`page`、`pageSize`、`totalPages`、`sources`。

## 开发与测试

```bash
npm test                          # 保留期、简介、索引、上传与管理冒烟
npm run test:access                # 访问保护、重试限制、Sidecar 防绕过
npm run smoke:render               # 渲染测试；Docker 可用时额外验证真实容器

# 以下需要环境中可用的 Playwright 和 Chromium
npm run test:admin
npm run test:theme
npm run test:access -- --browser
```

测试使用临时配置与数据，不操作现有资源。`SMOKE_SKIP_RENDER=1 npm test` 可跳过默认测试中的渲染检查；浏览器测试依赖需要自行准备。

```text
server.js            主服务：上传、验证、管理与账户 API
render-server.js     可选的渲染 sidecar
lib/                 存储、索引、访问保护、清理与预览逻辑
views/               管理页、登录页与主题
bin/dview            上传 / 管理 CLI
skill/ + command/    上传 Skill 与 Claude 命令
.agents/skills/      本项目的 TX 发布 Skill
scripts/             回归测试与部署辅助脚本
```

## 项目范围与参与

目前支持单管理员、本地文件存储和单个主服务进程；不包含多管理员 RBAC、管理端 token 创建 / 轮换、对象存储后端或整套 Docker 化主服务。

欢迎提交 Issue 或 PR。反馈问题时可附上 Node.js 版本、部署方式、复现步骤和脱敏日志；更改默认行为时同步更新中英文 README、配置示例和相关测试。

- [完整配置](../config.example.yaml)
- [Agent 使用说明](../AGENTS.md) · [上传 Skill](../skill/dview-upload/SKILL.md)
- [Sidecar 设计](../docs/design-render-sidecar.md) · [TX 发布 Skill](../.agents/skills/deploy-tx/SKILL.md)
- [需求与设计记录](../docs/SPEC.md)
