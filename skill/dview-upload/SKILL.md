---
name: dview-upload
description: 将本地 HTML / 图片 / 视频上传到 vibeview 预览服务并获得可分享的预览链接。当你生成了 HTML 图表、网页、截图、图片或视频，但只能输出到终端、无法直接在浏览器中预览时使用。返回一个公网可访问的随机 URL。
---

# dview-upload

把本地文件上传到 vibeview 预览服务，得到一个可在浏览器打开的预览链接。

- HTML 文件：直接渲染为网页
- 图片（png/jpg/gif/webp/svg）：在预览页居中展示
- 视频（mp4/webm）：在预览页用播放器展示

## 前置配置

需要两个环境变量（向服务管理员索取）：

- `DVIEW_URL`：服务地址，如 `https://view.example.com`
- `DVIEW_TOKEN`：上传 token

```bash
export DVIEW_URL="https://view.example.com"
export DVIEW_TOKEN="你的token"
```

## 使用方法

```bash
bash skill/dview-upload/upload.sh <文件路径>
```

脚本会在标准输出打印预览 URL，例如：

```
https://view.example.com/v/Ab3xK9mP2qR7sT1v
```

把这个 URL 给用户即可在浏览器打开预览。

## 示例

```bash
# 上传一个生成的图表
bash upload.sh /tmp/chart.html

# 上传一张截图
bash upload.sh ./screenshot.png
```

## 注意

- 单文件大小上限由服务端配置（默认 50MB）
- 仅支持 HTML / 常见图片 / mp4,webm 视频
- 上传内容会在服务端保留一段时间后自动清理（默认 7 天）
- 预览链接是随机不可猜测的；只上传可信内容（HTML 会被浏览器执行脚本）
