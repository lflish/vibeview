---
name: dview-upload
description: 将本地 HTML / 图片 / 视频，或多页面站点目录上传到 vibeview 预览服务并获得可分享的预览链接。当你生成了 HTML 图表、网页、多页面原型或前端项目、截图、图片或视频，但只能输出到终端、无法直接在浏览器中预览时使用。返回一个公网可访问的随机 URL。也可列出或删除本账户已上传资源。
---

# dview-upload

把本地文件上传到 vibeview 预览服务，得到一个可在浏览器打开的预览链接。

- HTML 文件：直接渲染为网页
- 多页面站点（目录或 zip，根部有 `index.html`）：整个目录作为一个资源，页面之间用相对路径跳转
- 图片（png/jpg/gif/webp/svg）：在预览页居中展示
- 视频（mp4/webm）：在预览页用播放器展示

## 两种模式：简单页面 / 多页面站点

生成网页前先选模式。用户指定了就照做（`/dview --simple`、`/dview --site`，或说「单页」「多页面」「站点」「项目」）；没指定时按下面的标准判断，**满足任一条就用站点模式，否则用简单模式**：

- 需要 2 个及以上真正独立的页面（如首页 + 详情页 + 设置页），并且用户会在页面间跳转；
- 需要分开的资源文件：多张图片、数据文件（JSON / CSV）、字体、音视频；
- 是前端框架或构建工具的产物（Vite、React、Vue 等打包出的 `dist/`）；
- 写成单文件会很大（预计超过约 1 MB），或单文件里内联的代码已经难以维护。

能用一个页面讲清楚的报告、图表、看板、小游戏、单个原型，都用简单模式。拿不准时用简单模式；不要为了「看起来更完整」而拆成多页面。

### 技术解析类内容

用户要你介绍、讲解、分析或科普一个项目、框架、协议或代码库时，先读 [references/tech-explainer.md](references/tech-explainer.md)。它规定了：先定读者、先读一手资料并记下版本、从定位 / 核心概念 / 结构分层 / 运行流程 / 实例走读 / 设计取舍 / 上手 / 局限 / 自测这 9 个角度里至少选 5 个来拆解，以及页面组织、交互方式、准确性规则和上传前自查。覆盖 4 个以上角度时通常用站点模式。

### 简单模式（单个 HTML）

生成一个自包含的 `.html`：样式和脚本内联，图表可用 CDN，图片用 data URI 或外链。写到 `/tmp/dview-<英文短名>-<时间戳>.html` 后上传这个文件。

### 站点模式（目录）

生成到一个新目录，如 `/tmp/dview-<英文短名>-<时间戳>/`，然后上传**整个目录**：

```bash
dview upload /tmp/dview-shop-demo-20261019/ --json --category prototype
```

目录要求：

- 根部必须有入口 `index.html`。压缩整个 `dist/` 目录也可以，服务端会自动去掉唯一的顶层目录。
- **所有站内链接和资源都用相对路径**：`about.html`、`./css/app.css`、`assets/logo.png`、`fetch('data/items.json')`。不要以 `/` 开头，`/` 指向服务根目录而不是站点目录。Vite 设 `base: './'`，其他构建工具同样配置相对的公共路径。
- 多页面用多个 `.html` 文件，或单页应用的 hash 路由（`#/detail`）。不要用 history 模式的干净路由（`/detail`），刷新会 404。可放一个 `404.html` 作为未找到页面。
- 只能是静态文件：没有后端、不能调用需要登录的接口；`fetch` 只读站内文件或允许跨域的公开 API。
- 页面运行在浏览器沙箱里（独立的 opaque origin）：`localStorage`、`sessionStorage`、cookie 不可用或会抛异常，读写时要 `try/catch` 并回退到内存状态。
- 不要放 `node_modules/`、构建缓存、`.env` 或任何密钥。上传时会跳过 `.` 开头的文件和目录、`node_modules` 和符号链接。
- 上限（服务端可调）：最多 500 个文件、解压后共 50 MB、zip 包 50 MB。只接受常见网页资源类型：html、css、js/mjs、json、txt、md、csv、xml、svg、图片、字体、音视频、wasm、pdf、glb/gltf 等。

上传后返回的 `url` 以 `/` 结尾，整个站点共用**一个访问码**；访客验证一次即可浏览所有页面。验证后地址栏里会出现 `/~<短期凭证>/` 这一段路径，它在授权到期（默认 30 分钟）后失效，分享时只分享上传返回的 `url` 和访问码，不要分享地址栏里的地址。

## 生成页面的默认风格

当本次任务需要生成 HTML 页面、图表或报告时，默认采用浅色风格：浅灰背景（`#f6f8fb`）、白色卡片、深色正文（`#1e293b`）、蓝色强调（`#2563eb`），搭配清晰的层级、适度留白和细边框。图表使用浅色画布及高对比文字，不默认生成暗色背景。

若页面提供主题切换，使用「浅色 / 深色 / 跟随系统」，初次打开默认浅色，并在浏览器中记住选择。上传的独立 HTML 应内联所需样式与脚本，不依赖需要登录的管理端资源。

用户明确指定其他风格或要求遵循已有设计时，以用户要求为准。仅上传已有文件时保留原样，不擅自改变内容或配色。此约定不修改已经上传的历史页面，也不要求给图片或视频添加主题开关。

## 前置配置

需要两个环境变量（向服务管理员索取）：

- `DVIEW_URL`：服务地址，如 `https://view.example.com`
- `DVIEW_TOKEN`：上传 token

```bash
export DVIEW_URL="https://view.example.com"
export DVIEW_TOKEN="你的token"
```

## 使用方法

优先使用 CLI（若已安装到 PATH）：

```bash
dview upload <文件路径> --json
# 多页面站点：上传目录（或现成的 .zip）
dview upload <站点目录> --json
# 指定有效期时：
dview upload <文件路径> --json --access-days 7
# 只有用户明确要求公开时：
dview upload <文件路径> --public
dview list [--category report] [--project 名称] [--tag 标签]
dview edit <id> --category doc --tag onboarding
dview delete <id>
dview me
```

否则用本 Skill 自带脚本：

```bash
bash skill/dview-upload/upload.sh <文件路径或站点目录> --json --category report --tag q3
# 或全局安装后：
bash ~/.claude/skills/dview-upload/upload.sh <文件路径> --json --category report --tag q3
```

AI 上传默认使用 `--json`，从同一次响应读取 `url`、`accessCode`、`access.expiresAt`。不支持查询已生成的旧访问码；不要只解析 URL 后丢弃访问码。旧 CLI 不支持此参数时用本 Skill 的脚本或上传 API 读取完整 JSON。

不加 `--json` 时 stdout 打印预览 URL，例如：

```
https://view.example.com/v/Ab3xK9mP2qR7sT1v
```

默认上传需要访问码，通常有效期 7 天。CLI 的 stdout 保持预览 URL，stderr 显示新访问码；`--json` 返回 `url`、`accessCode`、`access.expiresAt`。返回预览链接时同时告诉用户访问码和到期时间，建议将链接与访问码分开分享。不要把访问码放进 URL，也不要写进生成的 HTML。

只有用户明确要求免验证码时使用 `--public`。管理端可查看 / 复制访问码、重置访问码、改变到期时间或设为公开；上传 API 只在生成时返回访问码，请保存 JSON 中的 `accessCode`。访问码过期不删除文件。

受保护预览需要先在验证表单输入访问码，自动验证应使用 `POST /v/<id>/unlock` 并保留服务端 cookie；原文件也需要授权。遇到 429 遵守 `Retry-After` 并停止猜码，不要换 IP 或循环重试。受保护 HTML 使用浏览器 sandbox，脚本访问 localStorage 时应捕获异常并回退到内存中的主题状态。

## 修改已上传的页面（同一个链接）

需求页、原型这类会反复修改的页面，**更新原链接，不要每次新建**：

- 在 git 仓库里用 `dview upload` 上传时，CLI 把"文件路径 → 资源 id"记在仓库根目录的 `.dview.json`。再次上传同一路径会自动生成新版本，链接和访问码不变。新建资源后提醒用户把 `.dview.json` 提交进 git。
- 每次更新用 `-m` 写一句改了什么：`dview upload docs/prd/login.html --json -m "补充错误提示"`。
- 生成的页面放在仓库里会反复修改时，存到仓库内的固定路径（如 `docs/prd/`、`docs/prototype/`），不要放临时目录，否则映射不起作用。临时目录和被 `.gitignore` 忽略的文件不会写映射。
- 没有映射时用 `--id <id>` 指定要更新的资源；`--new` 强制新建。映射的资源已删除时 CLI 会报错，不会自动新建。
- 更新的响应里 `updated: true`，`version` 是新版本号，`versionUrl` 是这一版的永久地址，不返回新访问码（沿用原来的）。
- 历史版本地址是 `/v/<id>/@<n>`（站点为 `/v/<id>/@<n>/`），用同一个访问码打开；`dview versions <id>` 列出所有版本。
- Skill 自带的 `upload.sh` 不读 `.dview.json`，只支持 `--id` 和 `-m`。

## 上传时标注分类（每次都要做）

资源多了以后，管理员靠分类、项目和标签筛选与清理。上传时按页面实际用途选择**一个** `--category`：

| 值 | 用于 |
| --- | --- |
| `doc` | 开发文档、API / 架构说明、技术方案 |
| `report` | 报告、周报、分析结论、调研总结 |
| `dashboard` | 数据看板、图表、可视化 |
| `prototype` | UI 原型、页面设计稿、交互草图 |
| `game` | 游戏、互动玩具 |
| `slides` | 幻灯片、演示文稿 |
| `tool` | 可反复使用的小工具或小应用（计算器、转换器、表单） |
| `demo` | 一次性的功能 / 技术演示、示例 |
| `screenshot` | 截图、录屏 |
| `other` | 以上都不合适时 |

再用 `--tag` 补充 1–3 个具体标签（小写、短横线，如 `q3`、`onboarding`、`h5`）；如知道本次使用的模型，用 `--model` 传入（如 `claude-opus-5-5`）。`project` 默认取当前 git 仓库目录名，`agent` 默认从环境变量识别，通常无需手填；不在仓库里或识别不对时用 `--project` / `--agent` 指定。

```bash
dview upload /tmp/q3-report.html --json --category report --tag q3,ops --model claude-opus-5-5
```

用户只要求上传已有文件时也按内容选择分类；无法判断时用 `other`，不要编造新分类。标错后可用 `dview edit <id> --category <值>` 修改。这些字段只用于整理，不影响访问权限。

## 上传与管理统计

成功新建资源会产生一条上传事件；用 `--new` 或在仓库外重复上传同一文件得到新 ID，也会增加一次上传。更新已有资源（生成新版本）不计为新的上传。删除文件会减少当前存量，但不会扣减历史上传量；访问码重置或过期不算上传/删除。

真实统计在管理员 `/admin/statistics` 页面，API 为 `/admin/api/statistics` 和 `/admin/api/statistics/day`，要求管理员 session。上传 token 不授予管理统计权限，不要使用 Bearer token 冒充管理会话。此 Skill 不替用户申请或绕过管理员权限。

生成统计报告时注明日期范围、服务端响应的 `timezone` 和 `coverage`。上线前只能回填仍存在的文件，不能将其当作完整历史上传量。没有真实统计数据时明确标注演示数据，不能把 `dview list` 中的现存文件数量当成历史累计上传。继续遵循默认浅色、访问码及有效期的分享规则。

## 示例

```bash
dview upload /tmp/chart.html --json --category dashboard --tag sales
dview upload ./screenshot.png --json --category screenshot
bash upload.sh /tmp/snake.html --json --category game --tag h5
dview upload /tmp/dview-crm-prototype-20261019/ --json --category prototype --tag crm
```

## 注意

- 单文件大小上限由服务端配置（默认 50MB）；站点另有文件数和解压后总大小上限
- 支持 HTML / 常见图片 / mp4,webm 视频，以及多页面站点（目录或 zip）
- 上传内容默认永久保留；管理员可配置保留天数启用自动清理。账户可能有配额（超限返回 429）
- 预览链接是随机不可猜测的；只上传可信内容（HTML 会被浏览器执行脚本）
- 跨工具接入见仓库 `docs/integrations.md` 与 `AGENTS.md`
