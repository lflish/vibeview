---
name: dview-upload
description: 将本地 HTML / 图片 / 视频上传到 vibeview 预览服务并获得可分享的预览链接。当你生成了 HTML 图表、网页、截图、图片或视频，但只能输出到终端、无法直接在浏览器中预览时使用。返回一个公网可访问的随机 URL。也可列出或删除本账户已上传资源。
---

# dview-upload

把本地文件上传到 vibeview 预览服务，得到一个可在浏览器打开的预览链接。

- HTML 文件：直接渲染为网页
- 图片（png/jpg/gif/webp/svg）：在预览页居中展示
- 视频（mp4/webm）：在预览页用播放器展示

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
# 指定有效期时：
dview upload <文件路径> --json --access-days 7
# 只有用户明确要求公开时：
dview upload <文件路径> --public
dview list
dview delete <id>
dview me
```

否则用本 Skill 自带脚本：

```bash
bash skill/dview-upload/upload.sh <文件路径> --json
# 或全局安装后：
bash ~/.claude/skills/dview-upload/upload.sh <文件路径> --json
```

AI 上传默认使用 `--json`，从同一次响应读取 `url`、`accessCode`、`access.expiresAt`。不支持查询已生成的旧访问码；不要只解析 URL 后丢弃访问码。旧 CLI 不支持此参数时用本 Skill 的脚本或上传 API 读取完整 JSON。

不加 `--json` 时 stdout 打印预览 URL，例如：

```
https://view.example.com/v/Ab3xK9mP2qR7sT1v
```

默认上传需要访问码，通常有效期 7 天。CLI 的 stdout 保持预览 URL，stderr 显示新访问码；`--json` 返回 `url`、`accessCode`、`access.expiresAt`。返回预览链接时同时告诉用户访问码和到期时间，建议将链接与访问码分开分享。不要把访问码放进 URL，也不要写进生成的 HTML。

只有用户明确要求免验证码时使用 `--public`。管理端可重置访问码、改变到期时间或设为公开；访问码只在生成时显示，忘记后需要重置。服务端只保留哈希，无法查询旧码。访问码过期不删除文件。

受保护预览需要先在验证表单输入访问码，自动验证应使用 `POST /v/<id>/unlock` 并保留服务端 cookie；原文件也需要授权。遇到 429 遵守 `Retry-After` 并停止猜码，不要换 IP 或循环重试。受保护 HTML 使用浏览器 sandbox，脚本访问 localStorage 时应捕获异常并回退到内存中的主题状态。

## 上传与管理统计

成功上传会产生一条上传事件；重复上传同一文件得到新 ID，也会增加一次上传。删除文件会减少当前存量，但不会扣减历史上传量；访问码重置或过期不算上传/删除。

真实统计在管理员 `/admin/statistics` 页面，API 为 `/admin/api/statistics` 和 `/admin/api/statistics/day`，要求管理员 session。上传 token 不授予管理统计权限，不要使用 Bearer token 冒充管理会话。此 Skill 不替用户申请或绕过管理员权限。

生成统计报告时注明日期范围、服务端响应的 `timezone` 和 `coverage`。上线前只能回填仍存在的文件，不能将其当作完整历史上传量。没有真实统计数据时明确标注演示数据，不能把 `dview list` 中的现存文件数量当成历史累计上传。继续遵循默认浅色、访问码及有效期的分享规则。

## 示例

```bash
dview upload /tmp/chart.html
dview upload ./screenshot.png
bash upload.sh /tmp/chart.html
```

## 注意

- 单文件大小上限由服务端配置（默认 50MB）
- 仅支持 HTML / 常见图片 / mp4,webm 视频
- 上传内容默认永久保留；管理员可配置保留天数启用自动清理。账户可能有配额（超限返回 429）
- 预览链接是随机不可猜测的；只上传可信内容（HTML 会被浏览器执行脚本）
- 跨工具接入见仓库 `docs/integrations.md` 与 `AGENTS.md`
