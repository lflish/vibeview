# 独立验证结论（复验）：统计页区分新建和更新

- 结论：**通过，有备注**
- 提交：37a1c71d5060afd1397120bbe4259f3a4ae5bb86　代码指纹：644659c2b3a25754c37cd85ad2e425244855aba9
- 验证者：同一模型（Claude）的全新子 agent；codex 不可用（403 额度不足），claude 与开发同一工具
- 范围：复验（只是修复，按规则派一个验证者）；上一轮结论见 verdict-history.md，其余场景沿用上一轮结论
- 日期：2026-11-09　环境：local（verify-vibeview 隔离实例，临时目录 + 随机端口，结束已用 stop.sh 清理）；浏览器：本机无头 Chromium（Playwright）。没碰 `~/vibeview-prod` 和 systemd 服务；worktree `git status` 干净。

## 检查

都在 worktree `.devflow-tmp/verify-37a1c71`（HEAD = 37a1c71）里运行。

| 命令 | 结果 |
|------|------|
| `SMOKE_SKIP_RENDER=1 npm test` | exit 0。statistics unit / integration / updates、site、versions、templates（直连和代理）都 passed；`[smoke] passed=81 failed=0` |
| `npm run test:browser` | exit 0。home/login、admin login、statistics browser、**statistics updates browser**（含新加的标签亮度断言）、access、site、templates 都 passed |
| invariant 1 `npm run test:statistics` | exit 0，unit / integration / updates 都 passed |
| invariant 2 `SMOKE_SKIP_RENDER=1 bash scripts/smoke.sh` | exit 0，`passed=81 failed=0` |
| `git diff 0b2d646 HEAD --numstat -- . ':(exclude)docs/changes'` | 只有两个文件：`scripts/test-statistics-updates.js` +11/−1，`views/statistics.html` +1/−1 |

## 代码 diff（0b2d646..HEAD）

- `views/statistics.html` 第 42 行：`.kind-tag.update{background:#fef3e2;color:#b45309}` → `background:color-mix(in srgb,#f59e0b 16%,var(--panel));color:color-mix(in srgb,#d97706 75%,var(--text))`，改为跟随主题变量。没有其他 CSS/JS 改动。
- `scripts/test-statistics-updates.js`：原来的“切深色 → 截图 → 切回浅色”一行，拆开后**新增**两个断言（浅色下 `.kind-tag.update` 背景相对亮度 > 0.8，深色下 < 0.35），截图和切回浅色保留；`waitForTimeout(80)` 与原来相同。
- `package.json`、`.gitignore` 没改。

## 修复验证

操作：start.sh 启动隔离实例 → alice 用上传接口新建 `p1.html`，再 `-F id=<id>` 更新两次（返回 v2、v3）→ 管理员登录 → `/admin/statistics` → `#theme-select` 分别选浅色、深色 → 读 `#day-list .kind-tag` 的 computed style，截 `.calendar-panel`（月历 + 当日明细）。

| 主题 | 标签 | 背景 | 文字 | 对比度 |
|------|------|------|------|--------|
| 浅色 | 更新 · v3 / v2 | `color(srgb .994 .939 .847)`（≈#fdefd8，亮度 0.88） | `color(srgb .668 .390 .075)`（≈#aa6313） | 4.10 |
| 浅色 | 新建 | `rgb(232,240,255)` | `rgb(37,99,235)` | 4.51 |
| 深色 | 更新 · v3 / v2 | `color(srgb .279 .224 .132)`（≈#473922，亮度 0.044） | `color(srgb .872 .583 .251)`（≈#de9540） | 4.50 |
| 深色 | 新建 | `rgb(42,58,85)` | `rgb(139,180,255)` | 5.49 |

- 深色：标签背景是深棕色，和“新建”标签（深蓝）同一亮度级别，在 `rgb(26,26,26)` 面板上不再刺眼；文字橙色清晰可读（对比度 4.5）。修复前背景 `#fef3e2` 对页面背景对比 15.9，即备注 N3 所说的刺眼。
- 浅色：外观和以前基本一致（浅橙底、深橙字），截图里清楚可读；对比度从 4.58 略降到 4.10（见 N5）。
- 当日明细 3 条（新建 1 · 更新 2）、月历“3 个”带两段比例条，计数正确；浏览器没有 pageerror、console error、4xx/5xx；本次操作后 server.log 没有新的 error 行。
- 截图：`evidence/verify2-light.png`、`evidence/verify2-dark.png`

## 问题

都不拦。

| # | 问题 | 证据（操作 → 实际 → 应有） | 严重程度 | 拦不拦 |
|---|------|------------------------------|----------|--------|
| N5 | 浅色主题下“更新”标签文字对比度略降，低于 WCAG AA 的 4.5 | 浅色下 `getComputedStyle('#day-list .kind-tag.update')` → 背景 ≈#fdefd8、文字 ≈#aa6313，对比度 **4.10**；修复前 `#fef3e2`/`#b45309` 是 4.58，同页“新建”标签 4.51 → 应 ≥ 4.5（9px 小字），例如文字里 `--text` 占比再高一点。肉眼看 verify2-light.png 仍清楚 | 低 | 不拦 |
| N4 | 深色主题下当日明细区还有别的写死浅色（修复范围之外、本次没改、修复前就有） | verify2-dark.png：文件图标 `HT`（`.file-icon{background:#eaf1ff}`）、“今天 · 未结束”标签（`.date-chip{background:#eaf1ff}`）、行分隔线（`.file-row{border-bottom:1px solid #edf1f6}`）、热度图例色块，在深色下都是亮白；弹窗里站点类型标签 `.type-tag.site{background:#fef3e2}` 同 N3 的写法 → 应跟随主题变量。和 N3 同类，可以另开小修 | 低 | 不拦 |
| N1、N2 | 上一轮的备注，本次没改，仍然存在 | 见 verdict-history.md | 低 | 不拦 |

## 放松检查

无。`git diff 0b2d646 HEAD --numstat` 只动了 `scripts/test-statistics-updates.js`（+11/−1）和 `views/statistics.html`（+1/−1）。测试文件删掉的 1 行是“切深色 → 截图 → 切回浅色”的合并写法，拆开后原有动作（`selectOption('dark')`、`waitForTimeout(80)`、`evidence(page,'R3-dark')`、切回浅色、`assert.deepEqual(errors, [])`）全部保留，另外新增两条 `assert.ok` 亮度断言；没有删测试、没有放宽断言、没有调大超时、没有改 `package.json` 或 `.gitignore`。
