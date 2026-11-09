# 独立验证结论（复验 3）：统计页区分新建和更新（变基到改写后的 main）

- 结论：**通过**
- 提交：fa4d73f9ead45d1c2133cc3b3611331fd744e61b　代码指纹：055a4c51f2d59a4229f543939a0cd46ca22790cd
- 验证者：同一模型（Claude）的全新子 agent；codex 不可用（403 额度不足），claude 与开发同一工具
- 范围：复验（变基到改写后的 main，按规则派一个验证者）；其余场景沿用 verdict-history.md 第 1 轮
- 日期：2026-11-09　环境：local（verify-vibeview 隔离实例 `/tmp/verify-vibeview-eEiQBn`，随机端口 38163，结束已用 stop.sh 清理，目录已删除）；浏览器：本机无头 Chromium（Playwright）。没碰 `~/vibeview-prod` 和 systemd 服务；worktree `git status` 干净。

## 检查

都在 worktree `.devflow-tmp/verify-fa4d73f`（HEAD = fa4d73f）里运行。

| 命令 | 结果 |
|------|------|
| `git rev-parse origin/main`；`git merge-base --is-ancestor origin/main HEAD` | origin/main = 3bda563（含 72f0b1e、f1bf28d、3bda563）；是 HEAD 的祖先，merge-base = origin/main，新 main 的提交完整在分支里 |
| `SMOKE_SKIP_RENDER=1 npm test` | exit 0。retention、metadata、classification、resource-index、backup、admin-login、security、statistics（unit/integration/updates/visits）、site、versions、templates 都 passed；`[smoke] passed=81 failed=0` |
| `npm run test:security` | exit 0。`security proxy: preview sandbox, MIME whitelist, upload limits, token check, admin same-origin, account names passed`；`security: placeholder session_secret refuses startup when admin is enabled; SIGTERM exits cleanly`（72f0b1e 新增的检查） |
| `npm run test:browser` | exit 0。theme、admin-ui、admin login、statistics browser、**statistics updates browser**、access、site、admin templates、templates 都 passed |
| `npm run test:statistics` | exit 0。unit、integration、**updates**、visits unit/integration 都 passed |
| `SMOKE_SKIP_RENDER=1 bash scripts/smoke.sh` | exit 0，`passed=81 failed=0` |

## 代码 diff（`git diff origin/main...HEAD -- . ':(exclude)docs/changes'`）

- 20 个文件，+836/−52。**不含 `server.js`、`lib/store.js`、`lib/config.js`、`lib/preview-access.js`、`scripts/test-security.js`**：72f0b1e 对上传路径、管理端同源、session_secret 校验、token 常量时间比较的改动原样保留，本需求没有覆盖或回退它们。
- 本需求的代码改动集中在 `lib/statistics-store.js`（通过 `lib/versions` 读元数据里的版本记录更新事件，与 72f0b1e 的 `store.js` 读路径改动不交叉）、`views/statistics.html`、测试脚本和文档/skill。
- `package.json` 合并结果：新 main 的 `engines`、`author`、`test:security` 都在；本需求只在 `test:statistics` 和 `test:browser` 里各插入 `node scripts/test-statistics-updates.js [--browser]`，其他脚本不变。`npm test` 仍串起 `test:security`。
- `scripts/test-templates.js` 只**新增**两条断言（带 id 的模板渲染记为更新）。`scripts/test-statistics.js` 唯一的删除行是结尾的 `console.log` 汇总文字（换成更长的说明），无断言删除。
- start.sh 的 `session_secret` 是 `verify-<port>-secret`，不在新 main 的占位值集合（`change-me`、`replace-with-a-random-session-secret`）里，实例正常启动，server.log 只有 SQLite 实验特性警告和启动行。

## 场景

隔离实例里像用户一样操作（上传接口 + 管理端网页）：

| 操作 | 实际结果 | 应有 |
|------|----------|------|
| alice `POST /upload` p1.html | 200，id `QoctNQE0bKAx65E1`，version 1，`updated:false` | 新建 ✓ |
| alice 带 `-F id=<id>` 再上传两次 | 200，version 2、3 | 两次更新 ✓ |
| alice `PATCH /api/me/items/<id>/access` `{"mode":"code","reset":true}` | 200，新访问码 | 不计入上传 ✓（统计数字不变） |
| bob 上传 1 个页面后 `DELETE /api/me/items/<id2>` | 200 `{"ok":true}` | 删除 1，新建历史保留 ✓ |
| 失败的更新：带 id 传 `.txt`、带 id 传两个 file、错误 token、bob 更新 alice 的资源 | 400 `unsupported file type`、400 `only one file…`、401、403 | 都不计（R1.4）✓ |
| `GET /admin/api/statistics`（session） | `uploads: count 4, created {count 2, bytes 76}, updated {count 2, bytes 76}`；`deletions: count 1, owner 1`；`current: count 1`；activities：delete、create(bob v1)、update v3、update v2、create v1 | 与操作一致 ✓ |
| `/admin/statistics` 浅色 / 深色（`#theme-select`） | 两种主题下卡片“今日上传 4 个 · 新建 2 更新 2”“近 30 天上传 4 个 · 新建 2 更新 2”；趋势图 11/09 堆叠蓝/橙两段；月历 9 日“4 个”；当日明细标签 `新建`、`更新 · v3`、`更新 · v2`、`新建`，已删除的显示“已删除的 HTML 文件”（不露文件名）；类型分布 HTML“新建 2 · 更新 2”；来源 alice“新建 1 · 更新 2”、bob“新建 1 · 更新 0” | ✓ |
| 浏览器 pageerror / console error / ≥400 响应 | 无 | 无 ✓ |
| 操作后 `server.log` 新增行 | 无（无 Error、`[upload]`、`[statistics]`） | 无 ✓ |

截图：`evidence/verify4.png`（浅色整页）；深色整页也看过，颜色和数字正常（未入库，按要求只存一张）。

## 问题

本次复验没有发现新问题。变基后的代码与新 main（72f0b1e 等）之间没有互相破坏。之前就有的 N1、N2、N4、X1、E3 已记在 tasks.md 后续，不重复列。

（自记：验证中我第一次改访问码时用了错误的请求体 `{"code":"rotate"}`，返回 400 `mode must be code or public`，这是接口既有约定，不是缺陷；按 `{"mode":"code","reset":true}` 重做后成功。）

## 放松检查

无。没有删测试、没有放宽断言、没有调大超时；新增的 `AbortSignal.timeout(10000)`、`waitForTimeout(80)` 和 100×50ms 健康检查轮询都在本需求新增的测试文件里，不是改动已有值。`package.json` 只增加 `test-statistics-updates.js` 的调用，没有移除新 main 的任何脚本。
