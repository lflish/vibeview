# vibeview 使用指南

[← README](../README.zh-CN.md) · [English](user-guide.en.md)

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

浏览器打开 `url`，输入 `accessCode` 即可预览。**保存访问码和到期时间，建议将访问码与链接分开分享。** 服务端用哈希验证访问码，另存一份加密副本供管理员在管理端查看；上传 token 的 API 只在生成时返回访问码。

## 上传与分享

### CLI

在仓库内使用 `bash bin/dview`，或执行 `npm link` 将命令注册为 `dview`（同时注册等价的别名 `vibeview`）。CLI 通过本仓库或安装脚本分发，尚未发布到 npm registry。

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

可选表单字段：`access_days=7` 指定访问码有效天数，`access_mode=public` 明确开放公开访问。未指定时按服务端默认配置处理。分类字段见下一节。

### 分类、项目与标签

每个资源可以记录「这是什么页面、属于哪个项目、由哪个 agent 生成」，便于在资源很多时筛选和整理：

| 字段 | 说明 |
| --- | --- |
| `category` | 页面用途，固定取值：`doc` 开发文档、`report` 报告、`dashboard` 数据看板、`prototype` 原型、`game` 游戏、`slides` 幻灯片、`tool` 工具、`demo` 演示、`screenshot` 截图、`other` 其他。未知值归为 `other`，不传为未分类 |
| `project` | 所属项目；CLI 默认取文件或当前目录所在 git 仓库的目录名 |
| `agent` / `model` | 生成文件的 agent 与模型；CLI 默认从 `AI_AGENT`、`CLAUDECODE` 等环境变量识别 agent |
| `tags` | 自由标签，逗号分隔或重复传入，最多 8 个 |

```bash
dview upload ./snake.html --json --category game --tag h5,canvas --model claude-opus-5-5
dview list --category report --project vibeview   # 按分类 / 项目 / --tag 筛选
dview edit Ab3xK9mP2qR7sT1v --category doc --tag onboarding
dview edit Ab3xK9mP2qR7sT1v --tag ''               # 清空标签
```

`DVIEW_AGENT`、`DVIEW_MODEL`、`DVIEW_PROJECT` 可设置默认值，`--no-detect` 关闭自动识别。curl 上传使用同名表单字段；HTML 也可以在页面中声明 `<meta name="dview:category" content="game">`、`dview:tags` 等，作为未传字段时的兜底。值会统一转为小写短横线形式。

这些字段由上传方自报，只用于整理和筛选，不参与权限判断；可信的上传身份仍是「来源」（token 对应的账户）。上传后可在管理端或用 `dview edit` 修改。

### AI Skill 与工具接入

- **Claude Code**：运行 `bash install-skill.sh --url "$DVIEW_URL" --token "$DVIEW_TOKEN"`，安装上传 Skill、`/dview` 命令及 CLI。安装器默认将环境变量写入 shell 配置文件。
- **Codex / Cursor / 其他 Agent**：参考 [AGENTS.md](../AGENTS.md) 和 [上传 Skill](../skill/dview-upload/SKILL.md)，生成文件后使用 CLI 或 `bash skill/dview-upload/upload.sh <文件> --json`。本仓库的 `install-skill.sh` 默认安装到 Claude 目录，其他工具可按各自目录约定安装 Skill。
- **生成页面**：上传 Skill 默认使用浅色风格；仅上传已有文件时保留原样。
- **GitHub Actions**：参考 [工作流示例](../examples/github-actions/upload-preview.yml)，配置 Secrets `DVIEW_URL`、`DVIEW_TOKEN`。该示例目前只评论链接；接入受保护预览时，还需要保存上传响应中的访问码，并选择合适的分享渠道。

## 页面管理

访问 `/admin` 可以：

- 查看文件名、简介、来源、大小、创建时间、持续时长；「访问」列显示保护状态与剩余有效期。
- 每行显示分类、项目、agent / 模型与标签，点击即可只看同类；未分类的资源可直接点「未分类」补充。
- 勾选多项后，底部操作栏可批量设置分类与项目、追加标签或删除。
- 窄屏下资源以卡片显示，筛选项收进「筛选」按钮。
- 搜索文件名、简介、项目、标签或 ID，按类型 / 来源 / 分类 / 项目 / agent / 标签筛选（下拉框显示各值数量），排序和分页浏览。
- 「复制分享」一键复制页面简介、链接、访问码与有效期，可直接发送；「⋯」菜单中可仅复制链接、打开访问设置、编辑分类或删除。
- 在「访问」列查看 / 复制访问码；在访问设置中生成 / 重置访问码，设置到期时间、不过期或免验证。升级前生成的访问码无法查看，重置后即可查看。
- 查看各账户的用量与配额，停用 / 启用账户，切换管理页面主题。

上传账户在 `config.yaml` 的 `tokens` 中维护；管理端目前不提供创建账户或轮换 token 的功能。修改配置后需要重启主服务。

### 管理端登录保护

管理登录与页面访问码使用独立计数。默认同一客户端 10 分钟内最多失败 10 次，全站共享上限为 100 次，以限制更换 IP 的分布式猜测。超限返回 `429` 和 `Retry-After`，登录页显示冷却倒计时。计数保存在权限为 `600` 的文件中，只记录客户端 IP 的哈希，不记录用户名、密码或上传 token；重启保留限制，冷却后恢复。成功登录清除本客户端失败计数，全站失败计数继续保留。

| 字段 | 默认值 |
| --- | --- |
| `admin.login_max_attempts` | `10`，每个客户端的失败上限 |
| `admin.login_global_max_attempts` | `100`，所有客户端共享的失败上限 |
| `admin.login_retry_window_minutes` | `10`，计数窗口 / 冷却时间 |
| `admin.login_attempts_file` | `./data/admin-login-attempts.json` |
| `server.trust_proxy` | `loopback`，只信任本机反向代理 |

反向代理须正确覆盖或追加实际客户端地址，例如本机 Nginx 的 `X-Forwarded-For $proxy_add_x_forwarded_for`。其他代理部署明确配置其 IP / CIDR；直连部署可设 `server.trust_proxy: false`。不要直接设为 `true` 并信任任意客户端的 IP 请求头。

共享上限触发时，所有访客的新登录都会暂时受限，已登录会话不受影响。计数由单个主服务进程维护；多进程部署需要共享且原子的计数存储。

## 管理统计

从资源管理的「统计」入口进入 `/admin/statistics`。页面提供今日上传、近 7 / 30 天或本月上传、当前文件数和占用空间、每日趋势、月历、类型分布、来源排行以及最近上传/删除活动。来源和类型会联动筛选；点击趋势柱或日历日期可查看当日记录，并分页浏览。

- **累计上传与当前存量分开计算**：成功上传计数一次；文件删除后，上传历史继续保留，当前文件数和占用空间减少。访问码变更不产生上传事件。
- **时间范围**影响累计上传、趋势、类型/来源分布和活动；当前存量不受日期范围影响。月历按所显示月份统计，并共享来源/类型筛选。
- **历史覆盖**：首次启用按现存文件的创建时间回填，此前已删除的文件无法恢复。页面显示开始记录时间、历史可能不完整的提示，以及无效元数据的跳过数量；无上传日期显示 0，未来日期不可选。
- **删除记录**区分管理员删除、上传账户删除和到期清理。已删除文件的原名称不会在统计明细中显示；统计日志不保存原文件名、简介、内容、密码、token 或访问码。
- **权限**：页面与统计接口仅限已登录的管理员。上传 token 不授予统计访问权限。浅色、深色、跟随系统与其他管理页面共享设置。
- **按项目**：项目由上传方自报（默认取 git 仓库名）。统计页可按项目筛选，并列出各项目的上传数、当前文件数和打开次数；仍保留的资源按当前项目统计，已删除的按上传时的项目统计。资源管理页顶部的项目导航可以像目录一样切换项目。

### 访问统计

统计页的「访问情况」与资源管理的「打开」列展示预览链接的使用情况：

- **打开次数**：访客打开预览页（`GET /v/:id`）计 1 次。原文件请求（`/raw`）不计；管理员登录后的预览、链接预览爬虫与脚本客户端（如 Slackbot、curl）单独计数，不计入打开次数。
- **访问码验证**：分别统计验证页展示、验证成功、失败、被限流，以及打开已过期链接的次数，用于判断访问码是否发出、是否有人猜码、哪些链接需要续期。
- **从未打开**：资源管理可按「从未打开 / 30 天未打开 / 7 天内打开过」筛选，也可按打开次数或最近打开时间排序，便于清理。
- **访问码状态**：汇总当前资源中有效、3 天内到期、已过期、未设置访问码和公开的数量，不受时间范围影响。
- **隐私**：只保存「资源 × 天」的计数和首次 / 最后打开时间，不记录 IP、UA 或单次访问。计数先在内存累加，每 30 秒及正常退出时写入 `statistics.directory` 下的 `visits.sqlite`；强制结束进程最多丢失 30 秒计数。按天明细保留 400 天。
- 访问统计从新版本首次启动时开始记录，此前的访问无法补录；统计开始前上传且之后未被打开的资源显示「暂无记录」，不标为「从未打开」。需要 Node.js 内置 SQLite；不可用时页面会提示，上传统计不受影响。

```yaml
statistics:
  timezone: "Asia/Shanghai"
  directory: "./data/statistics"
```

`timezone` 接受有效的 IANA 时区，默认北京时间；统计不依赖浏览器或服务器操作系统时区，夏令时按配置时区处理。相对路径按配置文件所在目录解析；省略 `directory` 时，在 `storage.meta_dir` 旁创建 `statistics/`。

统计目录是独立的持久化事件日志，需要与资源元数据一起备份；它不同于可重建的 `resources.sqlite`。代码同步、回滚和资源清理均应保留日志。该实现由单个主服务进程维护内存缓存；手工修改数据或运行不记录统计的旧版本可能造成覆盖缺口，重新启动只能回填尚存文件。上传/删除中断通过持久化意图恢复，无法解析日志时明确报错，不能清空日志来绕过恢复。详见 [统计 Spec](specs/admin-statistics.md)。

### 统计 API

- `GET /admin/api/statistics?range=30&month=2026-10&source=&type=`：`range` 为 `7`、`30`、`month`；也可显式指定 `from` / `to`（`YYYY-MM-DD`，含首尾，最多 366 天），显式日期优先。`month` 控制月历，默认当月；日期不能位于未来。`source` 为上传来源，`type` 为 `html` / `image` / `video`。
- 汇总响应包含 `timezone`、`asOf`、`today`、`filters`、`coverage`、`summary`、`daily`、`calendar`、`types`、`sources`、`availableSources`、`activities`、`deletionActivities`。`coverage.startedAt` 是记录起点，`completeFromDate` 是其下一自然日，`periodComplete` 表示所选范围是否位于完整记录期且未混入回填记录。
- `GET /admin/api/statistics/day?date=2026-10-12&page=1&pageSize=20`：支持相同来源/类型筛选，`pageSize` 最大 100。响应包含 `count`、`bytes`、`retainedCount`、`items` 和分页信息；已删除项 `retained: false`、`filename: null`。

- `GET /admin/api/statistics/visits?from=2026-09-19&to=2026-10-18&project=&source=&type=`：访问统计。`project` 传 `-` 表示未设置项目（上传统计接口同样支持 `project`）。响应包含 `totals`（`views`、`admin_views`、`bots`、`challenges`、`unlock_ok`、`unlock_fail`、`rate_limited`、`expired_hits`）、`daily`、`top`、`projects`、`neverViewed`、`viewedInRange`、`current`、`accessStatus` 和 `startedAt`。

以上接口均要求管理员 session，返回 `Cache-Control: no-store`。未登录（包括只有上传 token）返回 401，非法日期、筛选或分页返回 400。

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
| `access.code_secret` | 缺省使用 `admin.session_secret`；加密访问码副本的密钥，更换后已有访问码需重置才能查看（仍可正常验证）。也可用 `DVIEW_ACCESS_CODE_SECRET` |
| `preview.proxy_to_render` / `render_url` | `false` / `http://127.0.0.1:3001` |

配置默认从项目根目录的 `config.yaml` 读取，可通过 `DVIEW_CONFIG_PATH`（或 `CONFIG_PATH`）指定其他文件。相对存储路径按**配置文件所在目录**解析。启用自动清理时，主服务启动即清理一次，之后每 6 小时执行一次；已删除的文件无法通过调整配置恢复。

## 部署

### 主服务

主服务负责上传、访问验证、管理、账户和清理，可用 PM2 或 systemd 守护。对外服务需要反向代理和 HTTPS，并将 `server.base_url` 设置为实际域名。

备份 `config.yaml`、上传数据及受限环境文件。JSON 元数据是资源的权威记录，`data/resources.sqlite` 是可重建的查询索引。配置中的 token、密码和 session secret 不要公开；上传凭据应只发给需要上传的机器或用户。

#### 数据备份

`npm run backup`（即 `node scripts/backup.js`）把上传文件、元数据、统计目录、账户与限流状态文件和 `config.yaml` 打成一个 `auto-<时间>.tar.gz`，默认放在 `data/backups/`（权限 700），只保留最近 14 份自动备份，不会删除手动备份。服务运行时也可以执行：统计事件是原子写入的单个文件，`visits.sqlite` 会先做一致快照；尚在内存中的访问计数（最多 30 秒）不会进入本次备份。

| 参数 | 说明 |
| :--- | :--- |
| `--dest DIR` | 备份目录 |
| `--keep N` | 保留最近 N 份自动备份，`0` 表示不清理 |
| `--no-config` | 不打包 `config.yaml`（它含 token 与管理员密码） |

每日自动备份可用 systemd 定时器：把 [examples/systemd](../examples/systemd/) 中两个文件的仓库路径改成实际目录，复制到 `~/.config/systemd/user/`，然后执行 `systemctl --user daemon-reload && systemctl --user enable --now vibeview-backup.timer`。用户服务需要 `loginctl enable-linger` 才能在未登录时运行。PM2 部署可改用 crontab，例如 `30 3 * * * cd /path/to/vibeview && node scripts/backup.js`。备份与数据在同一块磁盘上，重要数据请再定期复制到另一台机器。

恢复：停止主服务，把备份解包到临时目录，按包内 `manifest.json` 记录的原路径放回各目录和文件，再启动服务。`resources.sqlite` 不在备份中，启动时会自动重建。

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

只上传可信内容。所有 HTML 预览（包括显式公开的）都使用 `sandbox allow-scripts` 隔离同源权限，页面脚本无法借管理员的登录状态调用管理接口；脚本可以运行，但浏览器存储和同源请求不可用，依赖这些能力的页面需要适配。Docker sidecar 提供服务端进程隔离，不能代替浏览器端隔离。

浏览器提示 `NET::ERR_CERT_DATE_INVALID` 时，检查实际对外证书的有效期；续期后还需安装证书并重新加载反向代理。项目提供 [Nginx 证书安装辅助脚本](../scripts/install-nginx-cert.sh)，其目标路径需要与部署配置一致，执行需要管理员的 sudo 权限。

## API

| 方法与路径 | 认证 | 用途 |
| --- | --- | --- |
| `POST /upload` | Bearer 上传 token | 上传文件，返回链接、访问状态和新访问码 |
| `GET /api/me` | Bearer 上传 token | 本账户信息、用量与配额 |
| `GET /api/me/items` | Bearer 上传 token | 列出本账户资源 |
| `DELETE /api/me/items/:id` | Bearer 上传 token | 删除本账户资源 |
| `PATCH /api/me/items/:id/access` | Bearer 上传 token | 修改本账户资源的访问保护 |
| `PATCH /api/me/items/:id/meta` | Bearer 上传 token | 修改本账户资源的分类、项目、agent、模型、标签或简介 |
| `GET /v/:id` | 公开，或已验证的预览 cookie | 预览页面；未授权时显示访问码表单 |
| `POST /v/:id/unlock` | 表单中的 `code` | 验证访问码并设置预览 cookie |
| `GET /v/:id/raw` | 与预览页相同 | 获取原文件，支持 Range 请求 |
| `GET /admin/api/statistics` | 管理员 session | 概览、趋势、月历、分布与活动 |
| `GET /admin/api/statistics/day` | 管理员 session | 当日上传事件与分页明细 |
| `GET /admin/api/statistics/visits` | 管理员 session | 打开次数、访问码验证、热门资源、按项目分布与访问码状态 |
| `GET /admin/api/list` | 管理员 session | 分页、搜索、筛选和排序 |
| `PATCH /admin/api/item/:id/access` | 管理员 session | 生成 / 重置 / 修改访问保护 |
| `GET /admin/api/item/:id/access-code` | 管理员 session | 读取当前访问码；公开或无法读取时返回 `409` |
| `PATCH /admin/api/item/:id/meta` | 管理员 session | 修改分类、项目、agent、模型、标签或简介 |
| `PATCH /admin/api/items/meta` | 管理员 session | 批量整理，JSON 为 `{"ids":[...],"category":"report","project":"x","addTags":"q3"}`，最多 100 条；未给出的字段保持不变，标签为追加 |
| `DELETE /admin/api/item/:id` | 管理员 session | 删除单条资源 |
| `DELETE /admin/api/items` | 管理员 session | 批量删除，JSON 为 `{"ids":["id1","id2"]}`，最多 100 条 |
| `GET /admin/api/accounts` | 管理员 session | 账户列表与用量 |
| `POST /admin/api/accounts/:name/disable` 或 `/enable` | 管理员 session | 停用或启用账户 |
| `GET /healthz` | 无 | 主服务或 sidecar 的浅健康检查 |

访问保护的 PATCH body 使用 `mode: "code"` 或 `"public"`、`expiresAt`（ISO 时间或 `null` 表示不过期）、`reset: true`（重新生成）。列表不会返回原码或哈希；管理员通过 `access-code` 接口按需读取，响应 `no-store`。

管理列表支持 `page`、`pageSize`（最大 100）、`q`、`type`、`source`、`category`（`none` 表示未分类）、`project`、`agent`、`tag`、`sort=time|name|size|type|source|category|project|agent`、`order=asc|desc`；响应包含 `items`、`total`、`page`、`pageSize`、`totalPages`、`sources`、`categories`（可选分类）与 `facets`（各分类维度的取值与数量）。`GET /api/me/items` 也接受 `q`、`type`、`category`、`project`、`agent`、`tag`。

分类 PATCH body 可包含 `category`、`project`、`agent`、`model`、`tags`（数组或逗号分隔字符串）、`description` 中的任意字段，只修改出现的字段；空字符串表示清空，`description` 清空后回退为页面标题。

## 开发与测试

```bash
npm test                          # 保留期、简介、分类、索引、上传与管理冒烟
npm run test:statistics            # 统计口径、持久化恢复与 API（含访问统计）
npm run test:visits                # 访问计数口径、筛选排序、退出时写盘
npm run test:admin-login           # 管理登录的防暴力破解与代理来源校验
npm run test:access                # 访问保护、重试限制、Sidecar 防绕过
npm run smoke:render               # 渲染测试；Docker 可用时额外验证真实容器

# 以下需要 Playwright 和 Chromium：npm install 会安装 devDependencies 中固定版本的 playwright，
# 首次使用如缺少浏览器，运行 npx playwright install chromium
npm run test:browser               # 一次运行下面全部浏览器测试（CI 同样执行）
npm run test:admin
npm run test:theme
npm run test:access -- --browser
npm run test:admin-login -- --browser
npm run test:statistics -- --browser
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
