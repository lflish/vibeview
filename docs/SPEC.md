# vibeview 需求 SPEC（终检通过 · P0-10 已完成 · 可开序 C）

> 状态：**终检续评通过（可开序 C 拆 PR）** · P0-10 已实现；见 [SPEC-FINAL-CHECK.md](./SPEC-FINAL-CHECK.md)「终审续评 2026-10-08」；§9.1 默认已锁定  
> 评审依据：[docs/REQUIREMENTS-REVIEW.md](./REQUIREMENTS-REVIEW.md)（2026-10-08）  
> 仓库：`git@github.com:lflish/vibeview.git`  
> 工作区：`/workspace/vibeview`（含本地未提交改动）  
> 日期：2026-10-08（Asia/Shanghai）  
> 约定：`[已实现]` = 当前代码已有（含未提交）；`[待做]` = 计划实现；`[延期]` = 合入主线后再按需开；`[本阶段不做]` = 明确移出本轮排期；`[评估]` = 远期可选

---

## 1. 背景与目标

### 1.1 产品是什么

vibeview 是一个**通用预览服务**：各机器上的 AI / CI / 脚本把 **HTML / 图片 / 视频** 用账户 token 上传到公网实例，服务落盘后返回**不可猜测**的预览链接 `/v/<id>`，浏览器打开即可查看。配套 CLI、Claude Skill、`AGENTS.md`、GitHub Action 示例，方便生态接入。

产品名 **vibeview**；CLI / bin 名 **dview**（暂不保证 npm registry 包名，见 P2-7）。

```
本地文件 ──(Bearer token)──► Host POST /upload ──► data/ + meta
                                                    │
访客 ◄── GET /v/<id> ◄── Host 反代/转发 ──► Render 容器（只读 data）
Host 另提供：/admin · /api/me/*
```

### 1.2 目标用户

| 角色 | 诉求 |
| --- | --- |
| 自托管运维 / 开源贡献者 | 单机或小团队部署，配置简单、文档清楚 |
| 机器账户（AI Agent / CI） | 一行命令上传，拿回 URL；自管自己的资源与配额 |
| 全局管理员 | 看全部资源与账户用量，停用滥用账户，删除任意条目 |

### 1.3 本轮优化目标（按用户方向）

1. **账户对资源的管理**：token = 账户；归属、配额、自助 API、管理端账户页。  
2. **权限与预览隔离**：主服务跑宿主机；**仅一个渲染/预览容器**（路径映射 data）隔离对外 `/v` 面。  
3. **生态接入**：CLI + 多工具说明 + Action 示例，降低接入成本。  
4. **管理端体验**：可检索、可筛选、可复制链接的日常运维界面。  
5. **工程化**：**先冒烟门禁（P0-10）→ 拆 PR 合入**；再按需开可选 P1/P2。

### 1.4 成功标准（产品级）

- 新贡献者能按 README 在 10 分钟内本地跑通上传 → 打开预览。  
- 每个 token 只能管自己的资源；管理员能管全局与账户启停。  
- 超配额上传返回明确 `429`；停用账户无法上传。  
- 至少一种非 Claude 路径（CLI 或 curl）与一种 CI 路径文档齐全。  
- **`npm test` / 全链路冒烟（P0-10）绿**，再开可审 PR。  
- 安全边界写进 README：**渲染 sidecar ≠ 浏览器 XSS 防护**；只隔离预览进程面与宿主机密钥边界，不声称「可安全托管不可信 HTML」。

---

## 2. 非目标（明确不做 / 本阶段不做）

| 非目标 | 说明 |
| --- | --- |
| 完整 SaaS 多租户控制台 | 不做注册、计费、组织树、SSO |
| 多管理员 RBAC（原 P2-4） | **本阶段不做**；保持单 `admin.user`/`password` |
| 整站进 Docker（upload + admin + preview 同容器） | **否决**：主服务留宿主机；只起**一个**渲染容器 |
| 双全量栈（两套完整 Node：api + preview 各跑全功能） | **否决**：host 主服务 + 精简 preview sidecar |
| 每次预览起隔离浏览器容器 / 无头截图默认模式（原 P2-2） | **本阶段不做**；高成本、改产品形态 |
| 把不可信 HTML 变成「安全可公开执行」 | sidecar **不能**防访客浏览器 XSS；勿在叙事上夸大 |
| TypeScript 全量重写、换框架 | 保持 Express + 文件系统存储 |
| 对象存储（S3 等） | 本阶段仍用本地目录 |
| 实时协作编辑 HTML | 只做上传与预览 |
| 立刻 npm 发布 `dview`（原 P2-7） | **本阶段不做**；install 脚本 / 仓库 bin 即可 |
| UI 创建账户 / 轮换 token（P1-5）本阶段 | **本阶段不做**（评审默认）；继续 yaml 配 token + 运行时 disable |
| 在无 P0-10 冒烟的情况下巨型单 PR 直接合入 | **否决**；先门禁再交付 |

---

## 3. 角色与权限模型

### 3.1 角色

| 角色 | 凭证 | 能力 |
| --- | --- | --- |
| **账户（Account）** | `config.yaml` → `tokens[].token`，请求头 `Authorization: Bearer …` | 上传；`GET/DELETE /api/me*`；只能操作 `meta.source === 本账户 name` 的资源 |
| **管理员（Admin）** | `admin.user` + `admin.password`，Cookie session | `/admin` UI；全部资源列表/删除；账户列表/启停；**不能**用 Bearer 冒充账户（除非另配 token） |
| **访客（Visitor）** | 无 | 仅 `GET /v/:id`、`GET /v/:id/raw`、首页 |

### 3.2 账户 = token（named token）

- `tokens[].name`：**唯一**资源归属键，写入 `meta.source`。  
- 可选配额：`max_files`、`max_storage_mb`、`retention_days`（覆盖全局）。  
- 停用：`tokens[].disabled`（配置级）或管理端写入 `data/account-state.json`（运行时，**不改** `config.yaml`）。  
- 运行时停用优先于配置；`findActiveByToken` 对停用账户返回空 → 上传/`/api/me` 均 `401`。  
- 「账户」在产品用语上即 **named token**；未做独立 IAM / 账户库（P1-5 本阶段不做）。

### 3.3 权限矩阵（当前目标态）

| 操作 | 账户 token | Admin session | 访客 |
| --- | --- | --- | --- |
| `POST /upload` | ✅（未停用 + 未超配额） | ❌ | ❌ |
| `GET /api/me`、`/api/me/items` | ✅ 仅本账户 | ❌ | ❌ |
| `DELETE /api/me/items/:id` | ✅ 仅本账户资源，否则 `403` | ❌ | ❌ |
| `GET /admin/api/list`、删任意资源 | ❌ | ✅ | ❌ |
| `GET /admin/api/accounts`、disable/enable | ❌ | ✅ | ❌ |
| `GET /v/:id` | ✅ | ✅ | ✅（公开） |
| 在管理端创建/轮换 token | ❌ | **本阶段不做**（P1-5） | ❌ |

### 3.4 明确缺口（已按评审归类）

| 缺口 | 归类 |
| --- | --- |
| 多管理员 | **本阶段不做**（原 P2-4） |
| UI 内创建账户 / 轮换 token | **本阶段不做**（P1-5）；长期接受改 `config.yaml` + 重启；滥用靠运行时 disable |
| 配置热重载 / 账户库热更新 | **本阶段不做**（P1-6，绑定 P1-5 持久化模型，未定前不开工） |
| 预览鉴权 / 签名 URL | **延期评估**（P2-3）；默认预览继续公开 |
| 操作审计日志 | **延期可选**（P2-5） |

---

## 4. 功能需求（按优先级）

### P0 — 核心闭环（必须可用）

| ID | 需求 | 状态 | 关键路径 / 接口 |
| --- | --- | --- | --- |
| P0-1 | 带 token 上传 HTML/图片/视频，返回 `/v/<id>` | `[已实现]` | `POST /upload`；`lib/store.js`；类型：html / png·jpg·gif·webp·svg / mp4·webm |
| P0-2 | 公开预览：HTML `sendFile`；图/视频 viewer 壳页 | `[已实现]` | `GET /v/:id`；`GET /v/:id/raw`；`lib/viewer.js` |
| P0-3 | 单文件大小上限、保留天数清理 | `[已实现]` | `storage.max_size_mb`；`lib/cleanup.js`；账户级 `retention_days` |
| P0-4 | 管理端登录 + 资源列表删除 | `[已实现]` | `/admin`、`views/admin.html`、`views/login.html` |
| P0-5 | 配置与密钥不进仓库 | `[已实现]` | `config.example.yaml`；`.gitignore` 忽略 `config.yaml` |
| P0-6 | 账户模型 + 配额 + 自助 API + 管理端账户页 | `[已实现]`（未提交） | `lib/accounts.js`；`/api/me*`；`/admin/api/accounts*`；`data/account-state.json` |
| P0-7 | 管理端体验：搜索/筛选/排序/复制链接/分页/确认删除/toast/登录改进 | `[已实现]`（未提交） | `views/admin.html`、`views/login.html`；API `401` JSON |
| P0-8 | 生态：CLI + 安装脚本 + AGENTS + integrations + Action 示例 | `[已实现]`（未提交） | `bin/dview`；`install-skill.sh`；`AGENTS.md`；`docs/integrations.md`；`examples/github-actions/upload-preview.yml` |
| P0-9 | README 与 example 配置同步账户/生态说明 | `[已实现]`（未提交） | `README.md`；`config.example.yaml` |
| **P0-10** | **自动化全链路冒烟（upload → preview → me → delete 等）** | **`[已实现]`**（未提交） | `scripts/smoke.sh` + `npm test`（含内嵌 `smoke:render`）；`DVIEW_CONFIG_PATH` 隔离临时 config/data；§7.1 除 **#11 管理端 UI 点选** 外已覆盖；`npm test` → 45 OK / 0 FAIL |

### P1 — 部署与安全加固

| ID | 需求 | 状态 | 说明 |
| --- | --- | --- | --- |
| P1-1 | **渲染 sidecar**：单容器只服务预览；Dockerfile + compose；宿主机反代 `/v` | `[已实现]`（未提交） | 见 [design-render-sidecar.md](./design-render-sidecar.md)；`render-server.js` + `Dockerfile.render` + compose；`preview.proxy_to_render`；502 不回退。**叙事：≠ XSS 防护** |
| P1-2 | 可选「壳页 + iframe sandbox」模式 | `[延期]` | 合入主线后按需；**默认保持 `direct`**（兼容内联脚本）；`preview.mode: direct \| sandbox` |
| P1-3 | 更完整安全响应头（管理端与预览策略分离） | `[延期]`（部分基线已有） | 已有 `nosniff` / `Referrer-Policy` / `X-Frame-Options`；严格 CSP 随 P1-2 模式分支，不单独插队 |
| P1-4 | 管理端：批量删除、服务端分页/筛选 | `[延期]` | 现状客户端分页（每页 20）够用；体量上来再开 |
| P1-5 | 账户：管理端创建账户 / 轮换 token | `[本阶段不做]` | 未定持久化模型前不开工；见 §2、§9 |
| P1-6 | 配置热重载或账户库热更新 | `[本阶段不做]` | 绑定 P1-5；现状改 yaml 需重启 |

### P2 — 增强与可选（非本轮排期）

| ID | 需求 | 状态 | 说明 |
| --- | --- | --- | --- |
| P2-1 | 预览分域名（`preview.`） | `[延期]` / `[评估]` | 缓解同站 admin 风险；需 DNS/TLS，非开源默认路径 |
| P2-2 | 截图/PDF 无头渲染模式 | `[本阶段不做]` | 改产品形态；仅远期评估，不占排期 |
| P2-3 | 签名 URL / 预览需 token | `[延期]` / `[评估]` | 挑战「链接即分享」；仅明确私密预览需求后再做 |
| P2-4 | 多管理员 | `[本阶段不做]` | 与 §2 非目标一致；移出活跃 backlog |
| P2-5 | 操作审计日志 | `[延期]` | 启停/删除稳定后可选 append-only |
| P2-6 | （并入 P2-1）预览分域名与 sidecar 同开 | `[延期]` | 见 P2-1 |
| P2-7 | npm 发布 `dview` 到 registry | `[本阶段不做]` | 文档声明暂不保证 registry 包名 |
| P2-8 | 健康检查 `GET /healthz` | `[已实现]`（未提交） | host 浅检查；render 容器 `/healthz`；随 P1-1 一并交付 |

---

## 5. 安全与预览隔离（架构已拍板）

> **完整设计**：[docs/design-render-sidecar.md](./design-render-sidecar.md)（**已按默认建议确认并实现**）  
> **需求评审**：[docs/REQUIREMENTS-REVIEW.md](./REQUIREMENTS-REVIEW.md) §4 R2/R3 — 安全叙事与同站风险。  
> 实现落点：`render-server.js`、`Dockerfile.render`、`docker-compose.yml`、`lib/preview-*`、`preview.proxy_to_render`。

### 5.0 安全叙事（必读）

| 说法 | 是否成立 |
| --- | --- |
| sidecar 把预览读盘进程与 host 上的 admin/config/token **隔开** | ✅ 成立（密钥不进预览容器；data 建议 `:ro`） |
| sidecar **防止**访客打开 HTML 后的浏览器 XSS / 钓鱼 / 打访客内网 | ❌ **不成立** |
| Docker = 可安全托管不可信 HTML | ❌ **不成立**；产品默认仍是「只上传可信内容」 |
| 缓解同站「恶意预览打 `/admin` 会话」 | sidecar **单独不够**；中长期看 P2-1 分域，而非再加容器 |

README / PR 描述必须与上表同口径，避免运维高估隔离。

### 5.1 已拍板：渲染 sidecar（单容器）

**决策（用户确认）**：

- **只需一个容器**，用途是**渲染/对外提供预览页**（`GET /v/:id`、`GET /v/:id/raw`）。  
- **主服务留在宿主机**：`POST /upload`、`/admin*`、`/api/me*`、清理任务、账户逻辑均在 host 上的 Node 进程。  
- **路径映射**：宿主机 `data/`（或统一 `data_root`）挂进渲染容器，供其读文件并响应预览。  
- **目标**：缩小预览面对宿主机主服务（含 admin 会话、config、token）的牵连。  
- **明确不是**：整站 Docker；每请求浏览器容器；两套完整应用栈；访客 XSS 沙箱。

```
                    ┌─────────────────────────────────────┐
  Agent/CI ────────►│  Host: vibeview main (Node)         │
  Admin UI ────────►│  POST /upload · /admin* · /api/me*  │
                    │  写 data/ · meta · 配额 · cleanup   │
                    └──────────────┬──────────────────────┘
                                   │ bind-mount data/（建议只读进容器）
                                   ▼
                    ┌─────────────────────────────────────┐
  访客浏览器 ──────►│  Container: preview/render only     │
  （经 host 反代     │  仅服务 /v/:id 与 /v/:id/raw        │
   或直连预览端口）  │  无 admin 密钥 · 无上传 · 非 root   │
                    └─────────────────────────────────────┘
```

### 5.2 流量怎么走（host → 渲染容器）

对外仍建议**一个入口**（host 上的反代或主服务监听公网端口），避免访客绕过鉴权面直接打到容器（容器端口只绑 loopback）。

| 路径 | 落点 | 说明 |
| --- | --- | --- |
| `POST /upload`、`/api/me*`、`/admin*`、`/` | **仅宿主机主服务** | 不进渲染容器 |
| `GET /v/:id`、`GET /v/:id/raw` | **转发到渲染容器** | host 内嵌反代（已实现）；文档另写 nginx/Caddy |

渲染容器**不持有** `admin.password`、账户 token 列表；**不挂** `config.yaml`。启用 sidecar 时须**统一 `data_root`**（分散绝对路径挂载易错）。

### 5.3 设计点（已按默认建议拍板并实现）

| # | 议题 | 决定 |
| --- | --- | --- |
| D1 | data 进容器 | 共享 bind-mount **只读**；统一 `data_root` → 容器 `/data` |
| D2 | 容器内进程 | **精简 Node**（`render-server.js` + viewer），非静态-only |
| D3 | 网络 | 发布 `127.0.0.1:3001`；host 内嵌反代；compose 限出网 |
| D4 | 写权限 | data `:ro`；根 FS `read_only` + `tmpfs /tmp` |
| D5 | 生命周期 | compose **只起 render**；主服务宿主机 `node server.js` |
| — | 失败 | `proxy_to_render: true` 且容器挂 → **502**，禁止静默回退 |
| — | 默认 | `proxy_to_render: false`（本地无 Docker） |

### 5.4 风险分层（按本架构重述）

| 层 | 威胁 | 渲染 sidecar 能否挡 | 更贴切的手段 |
| --- | --- | --- | --- |
| 访客浏览器执行上传 HTML | XSS、钓鱼、挖矿、打访客内网 | **不能** | 只上传可信内容；可选 P1-2 sandbox（延期）；截图（本阶段不做）；分域 P2-1 |
| 预览进程被打穿后碰宿主机主服务/密钥 | 读 config、动 admin、删全盘 | **明显减轻** | 单容器仅预览；data 只读；不挂 config；非 root；端口仅 localhost |
| 恶意文件把磁盘写满 | 写爆宿主机 | **部分** | 已有 `max_size_mb` + 账户配额 |
| 盗用 token | 滥用上传 | 否（上传在 host） | 配额、停用、轮换（轮换 UI 本阶段不做） |
| 同源恶意预览打管理会话 | CSRF / 同站风险 | sidecar **单独不够** | Cookie `SameSite=lax`；中长期 P2-1 |

### 5.5 其余安全决策（已按评审默认锁定）

1. **默认 `preview.mode: direct`**（现状）；sandbox 仅 opt-in（P1-2，`[延期]`）。  
2. **不做**默认无头浏览器 / 每请求容器（P2-2 本阶段不做）。  
3. **预览继续公开**（随机 ID）；签名 URL 为 P2-3 延期评估。  
4. 短期 host 反代后 URL 可与主站同源；中长期 **P2-1** 评估 `preview.` 分域。

### 5.6 已有基线（勿回退）

- 上传鉴权；停用账户拒绝；配额 `429`。  
- `safeFilename` 去路径；类型白名单；id 格式校验 `store.isValidId`。  
- Session：`httpOnly`、`sameSite: 'lax'`。  
- 预览基础头：`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`。  
- host 直出与 render-server **共用** `lib/preview-*`，禁止再写第二套预览分支。  
- README 已声明「只上传可信内容」。

---

## 6. API 一览

### 6.1 公开

P1-1 落地后：`/` 仍由 **host 主服务**；`/v/*` 在 `proxy_to_render: true` 时由 host **反代**到 **渲染容器**（对外 URL 不变）。

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/` | 无 | 简短首页（host） |
| `GET` | `/healthz` | 无 | 健康检查（host / render） |
| `GET` | `/v/:id` | 无 | 预览（render sidecar 或 host 直出） |
| `GET` | `/v/:id/raw` | 无 | 原始文件 |

### 6.2 账户（Bearer）

| 方法 | 路径 | 成功 | 典型错误 |
| --- | --- | --- | --- |
| `POST` | `/upload` | `{ url, id, source }` | `401`；`400` 类型/大小/无文件；`429` 配额 |
| `GET` | `/api/me` | `{ account }` | `401` |
| `GET` | `/api/me/items` | `{ items, account }` | `401` |
| `DELETE` | `/api/me/items/:id` | `{ ok }` | `401`；`403` 非己；`404` |

`account` 公开字段（无 token）：name、用量、配额、disabled、retention 等（见 `accounts.publicAccountInfo`）。

### 6.3 管理端（Session）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET/POST` | `/admin/login`、`POST /admin/logout` | 登录页 / 登出 |
| `GET` | `/admin` | SPA 式单页（`views/admin.html`） |
| `GET` | `/admin/api/list` | 全部资源 `{ items }`；未登录 `401` JSON |
| `DELETE` | `/admin/api/item/:id` | 删任意 |
| `GET` | `/admin/api/accounts` | 账户 + 用量 + 默认 retention/maxSize |
| `POST` | `/admin/api/accounts/:name/disable\|enable` | 运行时启停 |

### 6.4 CLI 映射（`bin/dview`）

| 命令 | API |
| --- | --- |
| `dview upload <file>` | `POST /upload` |
| `dview me` | `GET /api/me` |
| `dview list` | `GET /api/me/items` |
| `dview delete <id>` | `DELETE /api/me/items/:id` |

环境变量：`DVIEW_URL`、`DVIEW_TOKEN`（可用 `--url` / `--token` 覆盖）。

---

## 7. 验收标准 / 测试计划

### 7.1 冒烟清单（P0-10 必须覆盖的核心项）

用临时 `config.yaml`（独立 `data/` 目录）起服务；**立即优先实现**（评审：开 PR 最低门禁）：

1. **健康**：进程监听 `server.port`；`GET /` 200；`GET /healthz` 200。  
2. **上传 HTML**：`POST /upload` + Bearer → 200，`url` 可打开，页面内容正确。  
3. **上传图片 / 视频**：预览页能显示 / 播放（可用最小 fixture）。  
4. **错误类型**：`.txt` 等 → `400`。  
5. **超大文件**：超过 `max_size_mb` → `400` `file too large`。  
6. **配额文件数**：`max_files: 1`，第二次上传 → `429`。  
7. **配额存储**：`max_storage_mb` 设极小，超限 → `429` 且**不留下**孤儿目录。  
8. **自助隔离**：账户 A 不能 `DELETE` 账户 B 的 id → `403`；`list` 只含自己的。  
9. **停用**：admin disable 后，该 token 上传与 `/api/me` → `401`；enable 恢复。  
10. **清理**：账户 `retention_days: 0` 不删；设 1 且把 `createdAt` 改旧应被 cleanup 删除（可用单测调 `cleanupExpired`）。  
11. **管理端**：登录失败有提示；成功后列表可见；复制链接；删除确认后条目消失；账户页用量与启停。  
12. **CLI**：`dview upload` stdout 为 URL；`dview me` / `list` / `delete` 正常。  
13. **未登录管理 API**：`GET /admin/api/list` → `401` JSON，而非登录 HTML。

> P0-10 最低可合入子集已由 `scripts/smoke.sh` 覆盖（含 2、4、6、8、9、12、13 及更多）；**#11 管理端 UI 浏览器点选**仍未自动化（已知缺口）。`smoke:render` 现由 `npm test` 内嵌调用，作 sidecar 本地检查补充，**不替代**全链路清单。

### 7.2 测试基建（P0-10）

- `scripts/smoke.sh`：起服 → curl 断言 → 杀进程。  
- `package.json`：`"test": "…"`（可与 `smoke:render` 分开）。  
- 鼓励对 `lib/accounts.js`、`lib/store.js` 做单元测试，**不堵**冒烟发布。  
- CI：无 Docker 时跑 host 冒烟即可；compose 实机另标。  
- **配置路径**：主服务支持环境变量 **`DVIEW_CONFIG_PATH`**（或 `CONFIG_PATH`）指向任意 `config.yaml`；未设置时仍读项目根 `config.yaml`。相对路径的 `storage.*_dir` **相对配置文件所在目录**解析，便于冒烟隔离。`scripts/smoke.sh` 已用 `mktemp` + `DVIEW_CONFIG_PATH` + 独立 `data/` + 空闲端口，避免污染开发者本地配置与 `./data`。

### 7.3 文档验收

- README、SPEC、`docs/integrations.md`、`config.example.yaml` 字段一致。  
- 安全段落与 §5.0 同口径：**渲染 sidecar ≠ 浏览器 XSS 沙箱**。  
- 启用 sidecar ⇒ 文档写明必须统一 `data_root`；`ports` 仅为 `127.0.0.1`。

### 7.4 sidecar 生产宣称额外条（序 D，非堵 P0-10）

- Docker 实机：compose up → host 上传 → 经 host `/v` 200 → stop render → **502**。  
- 确认 data `:ro`、无 config 进容器、图/视频 `/raw` 同源入口可加载。  
- 本机无 Docker 时 PR 标明「compose 未在 CI/本环境验证」。

---

## 8. 实现顺序（按评审 §5 重排 · 真实 backlog）

> **原则**（替换旧「先测再 sidecar / 先讨论再堆功能」过时序）：  
> **A 冻结定论 → B P0-10 冒烟 → C 拆 PR 合入 → D Docker 实机验证 → 再可选延期项。**  
> P1-1、P2-8、**P0-10** **已实现（未提交）**；序 B 完成，下一刀为序 C。

| 序 | 动作 | 对应 SPEC | 产出 / 状态 |
| --- | --- | --- | --- |
| **A** | 冻结开放问题最小集（见 §9 已定默认）；SPEC 终检通过 | §9、本文状态 | **完成** |
| **B** | **P0-10 全链路冒烟**（临时 config + 独立 data） | **P0-10**、§7.1 | **完成**：`scripts/smoke.sh` + `npm test`（45 OK）；`DVIEW_CONFIG_PATH` 隔离 |
| **C** | **下一刀：整理提交并开 PR**（建议拆分，见下） | P0-6..10、P1-1、P2-8 等未提交实现 | 可审、可回滚；**禁止**无说明巨型单 commit |
| **D** | 有 Docker 的环境验证 sidecar（502 不回退等） | P1-1 验收、§7.4 | 勾掉「实机未验证」；无 Docker 则 PR 标明 |
| **E** | （可选·延期）最小 `preview.mode: sandbox` | P1-2、P1-3 | 默认仍 `direct` |
| **F** | （本阶段不做）仅当未来书面定持久化模型后 → 账户 UI | P1-5、P1-6 | 否则保持 yaml + 运行时 disable |
| **G** | （延期）体量上来再服务端分页；审计；分域 | P1-4、P2-5、P2-1 | 按痛点，不进本轮列车 |

### 建议 PR 拆分（评审推荐 · 已采纳为默认）

1. **PR-A**：账户 + 管理端 UX + README 账户段（P0-6 / P0-7 / P0-9 主体）  
2. **PR-B**：生态 CLI / install / AGENTS / integrations / Action（P0-8）  
3. **PR-C**：渲染 sidecar + healthz + design 文档（P1-1、P2-8）  
4. **PR-D**：全链路 smoke（P0-10）— 可先于或紧跟 A  

带宽极低时允许**单 PR 多 commit**（边界同上），但不要无说明的巨型单 commit。

### 当前仓库快照

| 项 | 状态 |
| --- | --- |
| P0-6..10、P1-1、P2-8 | 工作区**已实现未提交** |
| P0-10 | **完成**（`npm test` 45 OK；§7.1 #11 UI 点选未自动化） |
| 序 A / B | **完成**（终检 + 冒烟） |
| 序 C | **下一刀**（拆 PR 合入） |
| P1-2..6、多数 P2 | 延期或本阶段不做（见 §4） |

---

## 9. 开放问题（复评用）

### 9.1 已按评审默认锁定（复评时可推翻）

| # | 问题 | 本轮默认（来自 REQUIREMENTS-REVIEW） |
| --- | --- | --- |
| Q1 | 预览默认策略 | **`direct`**；sandbox 仅 P1-2 延期 opt-in |
| Q2 | Docker / 渲染架构 | **已确认并实现**：单渲染 sidecar + host 主服务 + data 路径映射；D1/D2 已按默认落地 |
| Q3 | P1-5 管理端创建/轮换 token | **本阶段不做**；yaml 配 token + UI disable |
| Q4 | 预览是否永远公开 | **是**（nanoid）；签名 URL = P2-3 延期 |
| Q5 | 提交 / PR 粒度 | **建议拆 PR**（§8 PR-A/B/C/D）；或单 PR 多 commit |
| Q6 | 测试深度 | **先做 shell 全链路冒烟（P0-10）**；单元测试鼓励不堵发布 |
| Q7 | npm 发布 `dview` | **不发布**（P2-7 本阶段不做）；README 声明 |
| Q8 | 多管理员 / 审计 | 多管理员 **本阶段不做**（P2-4）；审计 = P2-5 延期可选 |
| Q9 | 实现下一刀 | **序 C 拆 PR 合入**（P0-10 已完成；不插队再堆 P1-2/P1-5） |

### 9.2 终检后剩余非阻塞项

§9.1 默认已锁定；序 A/B 视为完成。下列**不堵**序 C，合入/PR 时再选即可：

1. **PR 拆法**：严格四 PR（§8 推荐），或单 PR 多 commit。  
2. **Docker 实机（序 D）**：有 compose 环境则验 502；否则 PR 标明「未实机验证」。  
3. **§7.1 #11 管理端 UI 手测**；假 mp4 仅验预览壳（已知缺口，见 SPEC-FINAL-CHECK 续评）。

（若未来重启 P1-5：必须先书面三选一持久化——写回 yaml / `data/accounts.json`+热加载 / 仅展示一次仍手改 yaml——再开工。）

---

## 10. 附录：关键路径速查

| 路径 | 职责 |
| --- | --- |
| `server.js` | 路由与中间件 |
| `lib/config.js` | 读 `config.yaml` |
| `lib/store.js` | id / meta / 文件路径 / 列表 |
| `lib/accounts.js` | 账户、配额、启停、用量 |
| `lib/cleanup.js` | 过期清理 |
| `lib/viewer.js` | 图/视频预览 HTML |
| `lib/preview-*.js` | host / render 共用预览逻辑 |
| `render-server.js` | 渲染 sidecar 入口 |
| `Dockerfile.render` / `docker-compose.yml` | 仅 preview 容器 |
| `views/admin.html` / `login.html` | 管理端 |
| `bin/dview` | CLI |
| `install-skill.sh` | Skill + CLI 安装 |
| `AGENTS.md` | Agent 短说明 |
| `docs/integrations.md` | 生态对照 |
| `docs/SPEC.md` | 本文 |
| `docs/REQUIREMENTS-REVIEW.md` | 本轮需求评审（定稿依据） |
| `docs/SPEC-FINAL-CHECK.md` | SPEC 终检门禁（GO / P0-10） |
| `docs/design-render-sidecar.md` | 渲染 sidecar 完整设计（P1-1） |
| `examples/github-actions/upload-preview.yml` | CI 示例 |
| `config.example.yaml` | 配置模板 |
| `data/`（运行时） | 文件、meta、`account-state.json` |

---

*本文档已按 [REQUIREMENTS-REVIEW.md](./REQUIREMENTS-REVIEW.md) 收口，并由 [SPEC-FINAL-CHECK.md](./SPEC-FINAL-CHECK.md) 终检 / 续评通过。P0-6..10、P1-1、P2-8 已实现未提交；**下一实现项为序 C（拆 PR 合入）**。确认前不强制 commit/push。*
