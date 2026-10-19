---
description: 根据描述生成网页（单个 HTML 或多页面站点）并上传到 vibeview,返回可在浏览器打开的预览链接
argument-hint: [--simple | --site] <想要生成的页面/图表/站点的描述>
allowed-tools: Bash, Write, Read
---

# /dview — 生成网页并上传预览

用户的需求:$ARGUMENTS

这是一个"选模式 → 生成 → 上传"的短工作流。请依次完成:

## 步骤 1:检查上传配置(前置条件)

先确认 vibeview 上传所需的环境变量已就绪:

```bash
printf 'DVIEW_URL=%s\nDVIEW_TOKEN=%s\n' "${DVIEW_URL:-<未设置>}" "${DVIEW_TOKEN:+<已设置>}"
```

- 如果 `DVIEW_URL` 或 `DVIEW_TOKEN` 为空,**立即停止**,提示用户:
  vibeview 服务尚未配置。请先设置环境变量后重试:
  ```bash
  export DVIEW_URL="https://你的服务地址"
  export DVIEW_TOKEN="你的token"
  ```
  然后不要继续后面的步骤。

## 步骤 2:选择模式

- 参数以 `--simple` 开头:简单模式(单个 HTML)。
- 参数以 `--site` 开头:站点模式(多页面目录)。
- 都没有:按 `dview-upload` Skill 的「两种模式」标准判断。满足任一条用站点模式:需要 2 个及以上独立页面并互相跳转;需要分开的图片、数据、字体等资源文件;是前端框架的打包产物;单文件会超过约 1 MB。否则用简单模式,拿不准时也用简单模式。

开始生成前用一句话告诉用户选了哪种模式、为什么(用户已指定时只需确认)。

## 步骤 3:生成

通用要求:默认浅色风格(浅灰背景 `#f6f8fb`、白色卡片、深色正文 `#1e293b`、蓝色强调 `#2563eb`);完整的 `<!DOCTYPE html>`,设置 `charset=utf-8` 和 viewport;中文排版正常。页面在浏览器沙箱里运行,读写 `localStorage` 要 `try/catch`。

**简单模式**:生成一个**完整、自包含的单文件 HTML**。CSS 和脚本内联;图表优先用 CDN(如 Chart.js、ECharts)或纯 CSS/SVG,不依赖本地文件。用 Write 写入 `/tmp/dview-<简短英文名>-<时间戳>.html`。

**站点模式**:在新目录 `/tmp/dview-<简短英文名>-<时间戳>/` 里生成多个文件,用 Write 逐个写入:

- 根部必须有入口 `index.html`;其他页面如 `about.html`、`detail.html`;公共样式和脚本放 `css/`、`js/`,数据放 `data/`。
- 站内链接和资源**全部用相对路径**(`about.html`、`css/app.css`、`fetch('data/items.json')`),不要以 `/` 开头。
- 每个页面都有一致的导航,能回到首页。
- 只用静态文件,不依赖后端;外部库可用 CDN。
- 不要写 `.env`、密钥或 `node_modules/`。

## 步骤 4:上传并返回链接

先按页面用途选一个分类 `CATEGORY`:`doc` 开发文档 / `report` 报告 / `dashboard` 图表看板 / `prototype` 原型 / `game` 游戏 / `slides` 幻灯片 / `tool` 小工具 / `demo` 演示 / `other`。再选 1–3 个小写标签 `TAGS`(逗号分隔)。

`TARGET` 是简单模式的 HTML 文件,或站点模式的目录。按顺序探测上传方式(用第一个可用的):

```bash
TARGET="<刚生成的文件或目录>"
CATEGORY="<分类>"
TAGS="<标签1,标签2>"
if command -v dview >/dev/null 2>&1; then
  dview upload "$TARGET" --json --category "$CATEGORY" --tag "$TAGS"
elif [ -x bin/dview ]; then
  bash bin/dview upload "$TARGET" --json --category "$CATEGORY" --tag "$TAGS"
else
  UP="skill/dview-upload/upload.sh"; [ -f "$UP" ] || UP="$HOME/.claude/skills/dview-upload/upload.sh"
  bash "$UP" "$TARGET" --json --category "$CATEGORY" --tag "$TAGS"
fi
```

- 从 JSON 读取 `url`、`accessCode`、`access.expiresAt`,把链接、访问码和到期时间告诉用户,并提醒链接和访问码分开分享。只有用户明确要求免验证码时才加 `--public`。站点模式还要说明这是多页面站点、共有几个文件(`fileCount`),一个访问码覆盖所有页面。
- 若全部上传方式都不存在,提示用户先运行 `install-skill.sh`(或 `npm link`)安装 CLI / Skill。
- 若上传失败(非零退出),把错误输出转述给用户,并保留已生成的本地路径供其手动处理。站点被拒绝时(如缺少 `index.html`、文件类型不支持、超过文件数或大小上限),按错误信息修正后重试一次。

## 注意

- 保持简洁:除了选模式、生成和上传,不要做额外无关操作
- 不要把访问码写进 URL 或生成的页面
