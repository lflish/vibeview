---
description: 根据描述生成 HTML 页面并上传到 vibeview,返回可在浏览器打开的预览链接
argument-hint: <想要生成的页面/图表的描述>
allowed-tools: Bash, Write, Read
---

# /dview — 生成网页并上传预览

用户的需求:$ARGUMENTS

这是一个"生成 → 上传"的短工作流。请依次完成:

## 步骤 1:检查上传配置(前置条件)

先确认 vibeview 上传所需的环境变量已就绪:

```bash
echo "DVIEW_URL=${DVIEW_URL:-<未设置>}"; echo "DVIEW_TOKEN=${DVIEW_TOKEN:+<已设置>}"; echo "TOKEN_EMPTY=${DVIEW_TOKEN:-空}"
```

- 如果 `DVIEW_URL` 或 `DVIEW_TOKEN` 为空,**立即停止**,提示用户:
  vibeview 服务尚未配置。请先设置环境变量后重试:
  ```bash
  export DVIEW_URL="https://你的服务地址"
  export DVIEW_TOKEN="你的token"
  ```
  然后不要继续后面的步骤。

## 步骤 2:生成 HTML

根据用户在 `$ARGUMENTS` 中的描述,生成一个**完整、自包含的单文件 HTML**:

- 完整 `<!DOCTYPE html>` 结构,包含 `<head>`(设置 `charset=utf-8` 和 viewport)
- CSS 内联在 `<style>` 中;如需图表优先用 CDN(如 Chart.js、ECharts)或纯 CSS/SVG,避免依赖本地资源
- 中文内容确保字体和排版正常
- 视觉清晰、可直接在浏览器打开,无需额外文件
- 写入临时文件:`/tmp/dview-<简短英文名>-<时间戳>.html`

用 Write 工具写入该文件。

## 步骤 3:上传并返回链接

按顺序探测上传方式(用第一个可用的):

1. PATH 上的 CLI:`dview upload <文件>`
2. 项目内 CLI:`bash bin/dview upload <文件>`
3. 项目内 Skill 脚本:`bash skill/dview-upload/upload.sh <文件>`
4. 全局 Skill 脚本:`bash $HOME/.claude/skills/dview-upload/upload.sh <文件>`

```bash
FILE="<刚生成的HTML路径>"
if command -v dview >/dev/null 2>&1; then
  dview upload "$FILE"
elif [ -x bin/dview ]; then
  bash bin/dview upload "$FILE"
else
  UP="skill/dview-upload/upload.sh"; [ -f "$UP" ] || UP="$HOME/.claude/skills/dview-upload/upload.sh"
  bash "$UP" "$FILE"
fi
```

- 成功时 stdout 打印形如 `https://<域名>/v/<随机id>` 的预览链接
- 上传成功后,把该链接清晰地展示给用户,一句话说明这是可在浏览器打开的预览页
- 若全部路径都不存在,提示用户先运行 `install-skill.sh`（或 `npm link`）安装 CLI / Skill
- 若上传失败(非零退出),把错误输出转述给用户,并保留已生成的本地 HTML 路径供其手动处理

## 注意

- 保持简洁:除了生成文件和上传两步,不要做额外无关操作
