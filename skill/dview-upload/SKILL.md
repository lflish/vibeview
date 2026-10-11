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
dview upload <文件路径>
dview list
dview delete <id>
dview me
```

否则用本 Skill 自带脚本：

```bash
bash skill/dview-upload/upload.sh <文件路径>
# 或全局安装后：
bash ~/.claude/skills/dview-upload/upload.sh <文件路径>
```

成功时 stdout 打印预览 URL，例如：

```
https://view.example.com/v/Ab3xK9mP2qR7sT1v
```

把这个 URL 给用户即可在浏览器打开预览。

## 示例

```bash
dview upload /tmp/chart.html
dview upload ./screenshot.png
bash upload.sh /tmp/chart.html
```

## 注意

- 单文件大小上限由服务端配置（默认 50MB）
- 仅支持 HTML / 常见图片 / mp4,webm 视频
- 上传内容会在服务端保留一段时间后自动清理（默认 7 天）；账户可能有配额（超限返回 429）
- 预览链接是随机不可猜测的；只上传可信内容（HTML 会被浏览器执行脚本）
- 跨工具接入见仓库 `docs/integrations.md` 与 `AGENTS.md`
