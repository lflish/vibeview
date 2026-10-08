# 生态接入 / Integrations

让任意 AI、脚本或 CI 把 HTML / 图片 / 视频上传到 vibeview，拿到可分享的预览链接。

统一约定：

| 变量 / 密钥 | 含义 |
| --- | --- |
| `DVIEW_URL` | 服务 `base_url`，如 `https://view.example.com`（无结尾斜杠） |
| `DVIEW_TOKEN` | `config.yaml` 里某个账户的 token（Bearer） |

上传成功返回 JSON：`{ "url", "id", "source" }`。本账户还可调用 `GET/DELETE /api/me/*`。

---

## 1. curl（通用）

```bash
# 上传
curl -fsS -X POST "$DVIEW_URL/upload" \
  -H "Authorization: Bearer $DVIEW_TOKEN" \
  -F "file=@./report.html"
# => {"url":"https://.../v/<id>","id":"<id>","source":"..."}

# 本账户信息 / 列表 / 删除
curl -fsS -H "Authorization: Bearer $DVIEW_TOKEN" "$DVIEW_URL/api/me"
curl -fsS -H "Authorization: Bearer $DVIEW_TOKEN" "$DVIEW_URL/api/me/items"
curl -fsS -X DELETE -H "Authorization: Bearer $DVIEW_TOKEN" \
  "$DVIEW_URL/api/me/items/<id>"
```

---

## 2. CLI（`dview`）

仓库自带 `bin/dview`（npm 包名 `dview` 的 bin）：

```bash
# 从仓库
npm install -g .          # 或: npm link
# 或用安装脚本（默认装到 ~/.local/bin）
bash install-skill.sh --url "$DVIEW_URL" --token "$DVIEW_TOKEN" --cli

dview upload ./chart.html
dview list
dview me
dview delete <id>

# 不依赖环境变量时：
dview upload ./chart.html --url https://view.example.com --token "$DVIEW_TOKEN"
```

---

## 3. Claude Code（Skill + `/dview`）

```bash
bash install-skill.sh --url "$DVIEW_URL" --token "$DVIEW_TOKEN"
# 装到 ~/.claude/skills/dview-upload 与 ~/.claude/commands/dview.md
```

- Skill：`dview-upload`（AI 自动选用）
- 命令：在对话里输入 `/dview <页面描述>` → 生成 HTML 并上传

也可用旧脚本：`bash ~/.claude/skills/dview-upload/upload.sh <file>`

---

## 4. Cursor / Codex / 其它 Agent

仓库根目录有 **`AGENTS.md`**：说明何时上传、如何调用 CLI / curl。把本仓库当工作区打开，或把 `AGENTS.md` 里相关段落拷进你项目的 agent 说明即可。

轻量做法（不装 Claude Skill）：

```bash
export DVIEW_URL=... DVIEW_TOKEN=...
# 确保 dview 在 PATH，或直接：
bash /path/to/vibeview/bin/dview upload ./out.html
```

Cursor 项目内也可放一条 rule：「生成可预览产物后执行 `dview upload <path>`，把 URL 回给用户」。

---

## 5. GitHub Actions

示例工作流：上传构建出的 HTML，并在 PR 评论预览链接。

1. 仓库 Secrets：`DVIEW_URL`、`DVIEW_TOKEN`
2. 复制 [`examples/github-actions/upload-preview.yml`](../examples/github-actions/upload-preview.yml) 到 `.github/workflows/`（按需改触发条件与产物路径）

核心步骤：

```yaml
- name: Upload preview to vibeview
  id: dview
  env:
    DVIEW_URL: ${{ secrets.DVIEW_URL }}
    DVIEW_TOKEN: ${{ secrets.DVIEW_TOKEN }}
  run: |
    URL=$(curl -fsS -X POST "$DVIEW_URL/upload" \
      -H "Authorization: Bearer $DVIEW_TOKEN" \
      -F "file=@dist/index.html" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
    echo "url=$URL" >> "$GITHUB_OUTPUT"
```

完整可运行模板见 `examples/github-actions/upload-preview.yml`。

---

## 6. 机器侧 Skill 目录约定

| 工具 | 路径 | 安装 |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/dview-upload/` | `install-skill.sh`（默认） |
| Claude 命令 | `~/.claude/commands/dview.md` | 同上 |
| 任意 shell | `dview` on PATH | `install-skill.sh --cli` 或 `npm link` |
| CI | curl / CLI | Secrets + workflow 示例 |

`install-skill.sh --no-claude --cli` 可只装 CLI，适合非 Claude 机器。
