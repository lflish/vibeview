# vibeview

通用预览服务。把 AI 在各台机器上生成的 **HTML / 图片 / 视频** 上传到一个公网服务，服务渲染后返回一个随机、不可猜测的预览链接，浏览器打开即可查看。配套 **CLI / Skill / Agent 说明 / GitHub Action 示例**，方便各路 AI 与 CI 一行命令完成上传。

```
本地文件 ──(带 token 上传)──► vibeview 服务 ──► 渲染存储 ──► 返回随机预览链接 /v/<id>
                                              └─► 管理端 /admin（资源 + 账户用量/停用）
```

- **HTML**：直接渲染为网页
- **图片**（png/jpg/gif/webp/svg）：预览页居中展示
- **视频**（mp4/webm）：预览页用播放器展示

---

## 部署

```bash
git clone git@github.com:lflish/vibeview.git
cd vibeview
npm install
cp config.example.yaml config.yaml   # 然后编辑 config.yaml 填入真实值
npm start
```

生产环境建议用 `pm2` 或 systemd 守护，并在前面挂 Nginx/Caddy 反向代理 + HTTPS。

> `config.yaml` 含 token / 管理密码 / session 密钥，已被 `.gitignore` 忽略，**切勿提交**。

### 渲染 Sidecar（可选，推荐生产）

主服务继续在**宿主机**跑（上传 / 管理 / 账户）。另起**一个** Docker 容器只负责 `GET /v/*`，只读挂载 `./data`，**不挂** `config.yaml`。详见 [`docs/design-render-sidecar.md`](docs/design-render-sidecar.md)。

```bash
# 1) 起渲染容器（仅 render；绑定 127.0.0.1:3001）
docker compose up -d --build
curl -sS http://127.0.0.1:3001/healthz

# 2) config.yaml 打开反代（或环境变量）
# preview:
#   proxy_to_render: true
#   render_url: "http://127.0.0.1:3001"
# 等价：DVIEW_PREVIEW_PROXY=true DVIEW_RENDER_URL=http://127.0.0.1:3001

# 3) 宿主机主服务
npm start
```

本地开发默认 `proxy_to_render: false`，主服务直出 `/v`，无需 Docker。  
启用反代后若容器挂了，`/v/*` 返回 **502**（不会静默回退到主进程直出）。

环境变量（容器侧）：`RENDER_PORT`（默认 3001）、`RENDER_DATA_ROOT`（默认 `/data`）。

也可用无 compose 的等价命令：

```bash
docker build -f Dockerfile.render -t vibeview-render .
docker run -d --name vibeview-render --read-only --tmpfs /tmp \
  -p 127.0.0.1:3001:3001 -v "$(pwd)/data:/data:ro" \
  -e RENDER_DATA_ROOT=/data vibeview-render
```

前置 Caddy/nginx 分流示例见设计文档；默认也可用主服务内嵌反代（`preview.proxy_to_render`）。

安全边界：sidecar **隔离的是预览进程与挂载面**，不能阻止访客浏览器执行上传 HTML 中的脚本——请只上传可信内容。

### 配置说明（`config.yaml`）

| 字段 | 说明 |
| --- | --- |
| `server.port` | 监听端口 |
| `server.base_url` | 对外地址，用于拼接预览链接（不要带结尾斜杠） |
| `storage.html_dir` / `image_dir` / `video_dir` | 按类型分目录的文件存储路径 |
| `storage.meta_dir` | 元数据存储目录 |
| `storage.retention_days` | 文件保留天数，超过自动清理（设 0 表示不清理） |
| `storage.max_size_mb` | 单文件大小上限（MB） |
| `tokens` | 上传账户列表：每个 token = 一个账户（`name` 唯一标识） |
| `tokens[].max_files` | 可选，该账户最多保留的文件数 |
| `tokens[].max_storage_mb` | 可选，该账户总存储上限（MB） |
| `tokens[].retention_days` | 可选，覆盖全局保留天数；`0` = 不自动清理 |
| `tokens[].disabled` | 可选，配置级停用；也可用管理端运行时停用 |
| `admin.user` / `password` | 管理端登录账号密码 |
| `admin.session_secret` | session 加密密钥 |
| `preview.proxy_to_render` | `true` 时把 `/v/*` 反代到 sidecar（默认 `false`） |
| `preview.render_url` | sidecar 基址，仅 host 可达，默认 `http://127.0.0.1:3001` |
| `preview.proxy_timeout_ms` | 反代超时毫秒，默认 30000 |

生成随机 token / secret：`openssl rand -hex 24`

---

## 生态接入

让任意 AI / 脚本 / CI 上传产物并拿到预览链接。统一环境变量：`DVIEW_URL`、`DVIEW_TOKEN`。更完整的对照表见 [`docs/integrations.md`](docs/integrations.md)；给 Agent 读的短说明见 [`AGENTS.md`](AGENTS.md)。

### 一键安装（Skill + CLI）

```bash
# 交互式
curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh | bash

# 非交互（环境变量）
DVIEW_URL=https://your-domain.com DVIEW_TOKEN=<token> \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh)"

# 非交互（参数）；只要 CLI、不要 Claude Skill：
bash install-skill.sh --url https://your-domain.com --token <token> --no-claude --cli
```

默认会：

- 安装 Claude Skill → `~/.claude/skills/dview-upload/`
- 安装 `/dview` 命令 → `~/.claude/commands/dview.md`
- 安装 CLI → `~/.local/bin/dview`（并写入 PATH）
- 把 `DVIEW_*` 写入 shell rc

### CLI

```bash
# 仓库内 / 全局
npm link                    # 注册 bin: dview
# 或安装脚本已装到 ~/.local/bin

dview upload /path/to/chart.html
dview list
dview me
dview delete <id>
```

### Claude Code

装好后可用 Skill `dview-upload`，或对话里 `/dview <页面描述>`。也可手动：

```bash
bash ~/.claude/skills/dview-upload/upload.sh /path/to/chart.html
```

### Cursor / Codex / 其它 Agent

打开本仓库（或拷贝 `AGENTS.md` 要点到你的项目 agent 说明），生成预览产物后执行 `dview upload <file>`（或 curl），把返回的 URL 给用户。

### GitHub Actions

示例：[`examples/github-actions/upload-preview.yml`](examples/github-actions/upload-preview.yml) — 上传 HTML 并在 PR 评论预览链接。仓库 Secrets 配置 `DVIEW_URL`、`DVIEW_TOKEN`。

### curl

```bash
curl -fsS -X POST "$DVIEW_URL/upload" \
  -H "Authorization: Bearer $DVIEW_TOKEN" \
  -F "file=@/path/to/chart.html"
# => {"url":"https://your-domain.com/v/<id>", ...}
```

---

## API 参考

### 账户模型

每个 `tokens[]` 条目视为一个**账户**：`name` 写入资源的 `source`，用于隔离自助管理、用量统计与配额。全局 `admin` 仍可管理全部资源；机器侧用自己的 Bearer token 只能操作本账户资源。

### `POST /upload`

上传文件，需有效且未停用的账户 token。超出 `max_files` / `max_storage_mb` 时返回 `429`。

```bash
curl -X POST "$DVIEW_URL/upload" \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/file.html"
```

响应：

```json
{ "url": "https://your-domain.com/v/<id>", "id": "<id>", "source": "example-machine" }
```

### 账户自助（Bearer token）

```bash
# 查看本账户信息与用量
curl -H "Authorization: Bearer <token>" "$DVIEW_URL/api/me"

# 列出本账户资源
curl -H "Authorization: Bearer <token>" "$DVIEW_URL/api/me/items"

# 删除本账户下的一条资源
curl -X DELETE -H "Authorization: Bearer <token>" "$DVIEW_URL/api/me/items/<id>"
```

### `GET /v/:id`

公开预览页（HTML 直接渲染，图片/视频用 viewer 包裹）。

### `GET /v/:id/raw`

返回原始文件。

### 管理端 API

- `GET /admin/api/list` — 全部资源
- `DELETE /admin/api/item/:id` — 删除任意资源
- `GET /admin/api/accounts` — 账户列表 + 用量 / 配额
- `POST /admin/api/accounts/:name/disable|enable` — 运行时停用/启用（写入 `data/account-state.json`，不改 `config.yaml`）

---

## 管理端

浏览器打开 `https://your-domain.com/admin`，用 `config.yaml` 中的 `admin` 账号登录：

- **资源**：搜索 / 类型与来源筛选 / 排序 / 复制链接 / 删除
- **账户**：各 token 账户的文件数与占用、配额进度条、一键停用/启用，并可跳转到该账户资源

---

## 安全说明

- 上传需有效且未停用的账户 token；预览靠 16 位随机地址保护。
- 账户可设配额与独立保留期；管理端可运行时停用账户。
- HTML 会在访问者浏览器中执行脚本，**只上传可信内容**。渲染 sidecar（Docker）隔离的是预览进程与宿主机密钥面，**不能**阻止访客浏览器侧 XSS；当前预览页仅加了基础安全响应头（`nosniff` / `Referrer-Policy` / `X-Frame-Options`）。
- 健康检查：主服务 `GET /healthz`（浅检查）；容器内亦有 `/healthz`。
- 文件默认保留 7 天后自动清理（可按账户覆盖）。
