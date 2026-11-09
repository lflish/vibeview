---
name: verify-vibeview
description: 像用户一样操作 vibeview（上传 HTTP 接口、预览页、管理端网页）并取得证据。测试、验收、独立验证 vibeview 的功能时使用。
---

# verify-vibeview

vibeview 是一个 Node.js 单进程服务（`server.js`）：上传接口（Bearer token）、预览页 `/v/<id>`（访问码保护）、管理端 `/admin`（session 登录）。用户接触的是 HTTP 接口、`dview` 命令行和管理端网页。

只认环境名。local 用下面的隔离实例；production 只读（见 `.devflow.yml`），地址取 `VIBEVIEW_PROD_URL`，不写进这里。

## 启动

```bash
DIR=$(bash .agents/skills/verify-vibeview/scripts/start.sh)   # 在仓库根目录运行
source "$DIR/instance.env"                                      # BASE、PID、ADMIN_USER、ADMIN_PASS、TOKEN_A、TOKEN_B
```

- 每次一个临时目录、随机端口、独立的 `data/`（元数据、文件、统计日志都在 `$DIR/data/`），不读 `config.yaml`，不碰仓库的 `data/` 和生产目录 `~/vibeview-prod`。
- 就绪：脚本等到 `GET $BASE/healthz` 返回 `{"ok":true,...}` 才输出目录；超时会打印 `server.log` 的最后 20 行并退出非零。
- 从空数据开始，不需要迁移；需要数据就用下面的上传接口造。
- 渲染 sidecar（Docker）默认不启动（`DVIEW_PREVIEW_PROXY=false`），预览直接由主服务提供。要测 sidecar 时用 `bash scripts/smoke-render.sh`。
- 两个实例可以同时跑（端口和目录都独立）。不要去操作别人启动的实例或本机的 `vibeview` systemd 服务。

## 体检

```bash
curl -fsS "$BASE/healthz"; kill -0 "$PID" && echo running
```

`healthz` 正常、PID 是 `instance.env` 里的那个，才算是自己启动的实例。异常时先看 `$DIR/server.log`。

## 操作

- **上传**：`curl -fsS -X POST "$BASE/upload" -H "Authorization: Bearer $TOKEN_A" -F file=@page.html`；返回 JSON 的 `id`、`url`、`accessCode`。更新同一资源加 `-F id=<id>`；站点传 zip。也可以用 CLI：`DVIEW_URL=$BASE DVIEW_TOKEN=$TOKEN_A bin/dview upload page.html --json`。
- **账户自己的资源**：`/api/me/items`（列表）、`PATCH /api/me/items/:id/access`、`PATCH /api/me/items/:id/meta`、`DELETE /api/me/items/:id/versions/:n`、`DELETE /api/me/items/:id`，都带 Bearer token。
- **管理端网页**（浏览器，本机无头 Chromium，`require('playwright').chromium.launch()`；没装时 `npx playwright install chromium`）：
  - 登录：`/admin/login`，`#user`、`#password`、`#submit`；登录后资源表 `#rows tr` 出现。
  - 统计：`/admin/statistics`；就绪条件是 `#stats-content` 不再 hidden 且 `#day-list` 不含“正在加载”。控件：时间范围按钮（“近 7 天”“近 30 天”“本月”）、`#source`、`#project`、`#type`、“重置”；趋势图 `#trend-chart rect.bar`（每天一个，可聚焦，`data-date`）；月历 `#calendar-grid button[data-day]`；当日明细 `#day-list`、“查看当日记录 →”弹窗 `#dialog-body`；“统计口径” `#definitions`；主题 `#theme-select`。
  - 管理接口要 session cookie，并且写操作要带同源 `Origin` 头。
- **预览**：`$BASE/v/<id>`；受保护的页面先出现访问码表单。
- 用户真正走的路径是上传接口和网页；验证时不要直接改 `data/meta/*.json` 或调内部函数来“证明”功能。

## 日志

- local 实例：`$DIR/server.log`（启动行 `[vibeview] 已启动 → …`，出错时有 `Error`、`[upload]`、`[statistics]` 开头的行）。只看本次操作之后的部分：操作前记下 `wc -l < "$DIR/server.log"`，之后 `tail -n +<行数+1>`。
- 本机的常驻服务（不是验证对象，只读）：`journalctl --user -u vibeview --since "<时间>"`。
- production：只读地看部署记录和健康检查，按 `.agents/skills/deploy-view/SKILL.md` 的方式，不改日志配置。

## 证据

- 需求流程里截图存到需求文件夹的 `evidence/`（脚本化测试设 `DEVFLOW_EVIDENCE_DIR`）。
- 每个结论记下操作和操作后的状态；有副作用的（上传、删除、改访问码）另外读一遍确认：管理统计接口 `GET $BASE/admin/api/statistics`（带 session），或 `/api/me/items`。
- 操作后 `server.log` 里没有新的错误；浏览器里没有 `pageerror`。

## 清理

```bash
bash .agents/skills/verify-vibeview/scripts/stop.sh "$DIR"          # 关掉实例并删除临时目录
bash .agents/skills/verify-vibeview/scripts/stop.sh "$DIR" --keep   # 只关实例，保留目录（排查用）
```

只按 `instance.env` 的 PID 关，不按进程名杀。证据存在需求文件夹，不在实例目录里，清理不会删掉。

## 帮助脚本

- `scripts/start.sh [目录]`：启动隔离实例，输出实例目录。
- `scripts/stop.sh <目录> [--keep]`：关闭并清理。

功能清单见 [features/README.md](features/README.md)。
