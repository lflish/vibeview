# 独立验证结论（复验 2）：统计页区分新建和更新

- 结论：**通过**
- 提交：e0bfc570d78fcd2636237e436dbb946a68341ff7　代码指纹：083a7491614735c0a4371ac7de21c450afa93a43
- 验证者：同一模型（Claude）的全新子 agent；codex 不可用（403 额度不足），claude 与开发同一工具
- 范围：复验（只是修复，派一个验证者）；只验证 T7（N5 对比度）及其是否破坏别的东西，其余场景沿用 verdict-history.md 里第 1 轮的结论
- 日期：2026-11-09　环境：local（verify-vibeview 隔离实例 `/tmp/verify-vibeview-RuiEc7`，随机端口，结束已用 stop.sh 清理，目录已删除）；浏览器：本机无头 Chromium（Playwright）。没碰 `~/vibeview-prod` 和 systemd 服务；worktree `git status` 干净。

## 检查

都在 worktree `.devflow-tmp/verify-e0bfc57`（HEAD = e0bfc57）里运行。

| 命令 | 结果 |
|------|------|
| `SMOKE_SKIP_RENDER=1 npm test` | exit 0。statistics unit / integration / updates、site、versions（直连和代理）、templates（CLI、直连、代理）都 passed；`[smoke] passed=81 failed=0` |
| `npm run test:browser` | exit 0。home/login、admin login、statistics browser、**statistics updates browser**（含新加的两种主题对比度 ≥ 4.5 断言）、access、site、admin templates、templates 都 passed |
| `npm run test:statistics` | exit 0，unit / integration / updates 都 passed |
| `SMOKE_SKIP_RENDER=1 bash scripts/smoke.sh` | exit 0，`passed=81 failed=0` |
| `git diff --stat 37a1c71 HEAD -- . ':(exclude)docs/changes'` | 只有两个文件：`scripts/test-statistics-updates.js` 9+/8−（净 +1 行），`views/statistics.html` 1+/1− |

## 代码 diff（37a1c71..HEAD）

- `views/statistics.html` 第 42 行：`.kind-tag.update` 从 `color-mix(...)` 跟随主题，改回浅色原配色 `background:#fef3e2;color:#b45309`，另加 `:root[data-theme="dark"] .kind-tag.update{background:#473922;color:#fbbf24}` 单独覆盖深色。没有其他 CSS/JS 改动。“跟随系统”在 `views/theme.js` 第 19 行解析成 `data-theme="dark"/"light"`，所以深色覆盖对“跟随系统”也生效。
- `scripts/test-statistics-updates.js`：`tagLuminance()` 换成 `tagColors()`，同时返回背景亮度和文字/背景对比度。原有两条断言（浅色背景 > 0.8、深色背景 < 0.35）阈值不变、全部保留，另外**新增**两条 `contrast >= 4.5`。`waitForTimeout(80)`、`evidence(page,'R3-dark')`、切回浅色、`assert.deepEqual(errors, [])` 都没变。
- `package.json`、`.gitignore` 没改。

## 修复验证

操作：start.sh 启动隔离实例 → alice 用 `POST /upload` 新建 `p1.html`（id `Letm1MPYvWD3MT83`），再带 `-F id=<id>` 更新两次（返回 version 2、3）→ 管理员在 `/admin/login` 登录 → `/admin/statistics` → `#theme-select` 分别选“浅色”“深色” → 读每个 `#day-list .kind-tag` 的 computed `color` / `background-color`，按 WCAG 2.x 公式（sRGB 线性化，L = 0.2126R + 0.7152G + 0.0722B，比值 (L1+0.05)/(L2+0.05)）计算 → 截 `.calendar-panel`（月历 + 当日明细）。

| 主题 | 标签 | 背景 | 文字 | 对比度 | 应有 |
|------|------|------|------|--------|------|
| 浅色 | 更新 · v3 / 更新 · v2 | `rgb(254,243,226)` #fef3e2（亮度 0.907） | `rgb(180,83,9)` #b45309 | **4.58** | ≥ 4.5 ✓（上一轮 4.10） |
| 浅色 | 新建 | `rgb(232,240,255)` | `rgb(37,99,235)` | 4.51 | 参考 |
| 深色 | 更新 · v3 / 更新 · v2 | `rgb(71,57,34)` #473922（亮度 0.044） | `rgb(251,191,36)` #fbbf24 | **6.70** | ≥ 4.5 ✓（上一轮 4.50） |
| 深色 | 新建 | `rgb(42,58,85)` | `rgb(139,180,255)` | 5.49 | 参考 |

- 深色下“更新”标签仍是深棕底（亮度 0.044，与“新建”深蓝底 0.042 同级），N3 的“刺眼”没有回来。
- 当日明细 3 条（新建 1 · 更新 2）、月历 9 日“3 个”带两段比例条，计数正确；浏览器没有 pageerror、console error、4xx/5xx 响应；操作后 `server.log` 没有新的 error / `[statistics]` / `[upload]` 错误行。
- 截图：`evidence/verify3-light.png`、`evidence/verify3-dark.png`

## 问题

本次修复没有发现新问题。

| # | 问题 | 证据 | 严重程度 | 拦不拦 |
|---|------|------|----------|--------|
| N5 | 浅色下“更新”标签对比度 4.10 | 已修复：实测 4.58（深色 6.70），见上表 | — | 已关闭 |
| N1、N2、N4、X1、E3 | 之前就有的备注 | 见 tasks.md 后续（verify3-dark.png 里仍能看到 N4 的亮白文件图标、“今天”标签和分隔线，本次范围之外） | 低 | 不拦 |

## 放松检查

无。`git diff 37a1c71 HEAD -- . ':(exclude)docs/changes'` 只动了 `scripts/test-statistics-updates.js` 和 `views/statistics.html`。测试文件里原有的亮度断言（> 0.8、< 0.35）阈值不变，新增两条对比度 ≥ 4.5 断言；没有删测试、没有放宽断言、没有调大超时、没有改 `package.json` 或 `.gitignore`。
