# vibeview

通用预览服务。把 AI 在各台机器上生成的 **HTML / 图片 / 视频** 上传到一个公网服务，服务渲染后返回一个随机、不可猜测的预览链接，浏览器打开即可查看。配套一个 **Skill**，让 AI 一行命令完成上传。

```
本地文件 ──(带 token 上传)──► vibeview 服务 ──► 渲染存储 ──► 返回随机预览链接 /v/<id>
                                              └─► 管理端 /admin（登录后浏览/预览/删除）
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

### 配置说明（`config.yaml`）

| 字段 | 说明 |
| --- | --- |
| `server.port` | 监听端口 |
| `server.base_url` | 对外地址，用于拼接预览链接（不要带结尾斜杠） |
| `storage.html_dir` / `image_dir` / `video_dir` | 按类型分目录的文件存储路径 |
| `storage.meta_dir` | 元数据存储目录 |
| `storage.retention_days` | 文件保留天数，超过自动清理（设 0 表示不清理） |
| `storage.max_size_mb` | 单文件大小上限（MB） |
| `tokens` | 上传 token 列表，支持多个，每个带 `name` 用于在管理端识别上传来源 |
| `admin.user` / `password` | 管理端登录账号密码 |
| `admin.session_secret` | session 加密密钥 |

生成随机 token / secret：`openssl rand -hex 24`

---

## 在其他 AI / 机器上接入（Skill）

让任意机器上的 AI 具备「上传并拿到预览链接」的能力。

### 方式一：一键安装（推荐）

在目标机器执行，自动把 Skill 装到 `~/.claude/skills/` 并写入环境变量：

```bash
# 交互式（会提示输入服务地址和 token）
curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh | bash

# 非交互（直接带上参数）
DVIEW_URL=https://your-domain.com DVIEW_TOKEN=<token> \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/lflish/vibeview/main/install-skill.sh)"
```

装好后重开终端（或 `source ~/.zshrc`），即可让 AI 调用 `dview-upload` Skill，或手动：

```bash
bash ~/.claude/skills/dview-upload/upload.sh /path/to/chart.html
```

### 方式二：手动安装

**1. 拷贝 Skill 到目标机器的 skills 目录**

```bash
cp -r skill/dview-upload ~/.claude/skills/
chmod +x ~/.claude/skills/dview-upload/upload.sh
```

**2. 设置环境变量**（向服务管理员索取真实值）

```bash
export DVIEW_URL="https://your-domain.com"   # 你的 base_url
export DVIEW_TOKEN="<config.yaml 里的某个 token>"
```

**3. 调用**

```bash
bash ~/.claude/skills/dview-upload/upload.sh /path/to/chart.html
# 输出: https://your-domain.com/v/Ab3xK9mP2qR7sT1v
```

AI 把这个 URL 给用户即可在浏览器打开预览。

---

## API 参考

### `POST /upload`

上传文件，需 token 鉴权。

```bash
curl -X POST "$DVIEW_URL/upload" \
  -H "Authorization: Bearer <token>" \
  -F "file=@/path/to/file.html"
```

响应：

```json
{ "url": "https://your-domain.com/v/<id>" }
```

### `GET /v/:id`

公开预览页（HTML 直接渲染，图片/视频用 viewer 包裹）。

### `GET /v/:id/raw`

返回原始文件。

### 管理端

`/admin` — 登录后浏览全部上传（含来源）、预览、删除。

---

## 管理端

浏览器打开 `https://your-domain.com/admin`，用 `config.yaml` 中的 `admin` 账号登录，即可看到所有上传记录（文件名 / 类型 / 大小 / 来源 / 时间），可点击预览或删除。

---

## 安全说明

- 上传需有效 token；预览靠 16 位随机地址保护。
- HTML 会被浏览器执行脚本，**只上传可信内容**。
- 文件默认保留 7 天后自动清理。
