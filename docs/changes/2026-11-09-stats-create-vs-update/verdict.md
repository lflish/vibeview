# 独立验证结论：统计页区分新建和更新

- 结论：**通过，有备注**
- 提交：0b2d646f0f0217317864c29309e5fe2d3172d490　代码指纹：5f1ca85fa8040c1bfd0b80249d96b7b3a27daf33
- 验证者：同一模型（Claude）的全新子 agent，没参与开发；codex 不可用（403 额度不足），claude 与开发是同一工具
- 日期：2026-11-09　环境：local（verify-vibeview 隔离实例，临时目录、随机端口；验证完已用 stop.sh 清理）；浏览器：本机无头 Chromium（Playwright）

## 检查

都在 worktree `.devflow-tmp/verify-0b2d646` 里运行，提交 0b2d646。

| 命令 | 结果 |
|------|------|
| lint | 项目没有 lint 命令，跳过 |
| `SMOKE_SKIP_RENDER=1 npm test` | exit 0。statistics unit / integration / updates、site、versions、templates（直连和代理）都 passed；`[smoke] passed=81 failed=0` |
| `npm run test:browser` | exit 0。theme、admin、admin-login、statistics browser、**statistics updates browser**、access、site、templates 都 passed |
| invariant 1 `npm run test:statistics`（统计日志只存最小事件） | exit 0，4 个脚本都 passed |
| invariant 2 `SMOKE_SKIP_RENDER=1 bash scripts/smoke.sh`（CLI/HTTP 向后兼容） | exit 0，`passed=81 failed=0` |

## 场景

### 真实升级路径（额外做的）
在临时目录里用 `git archive main` 取出 **main 分支的代码**，用同一个 start.sh 启动，造了升级前的数据：资源 A 新建后更新到 v4，再删掉 v3（保留 v1、v2、v4）；资源 B 新建、更新一次，然后删除。停掉 main，**在同一个数据目录上**启动 0b2d646 的代码（这就是“新版本第一次启动”）。main 时的统计是 `uploads.count 2`（只有两次新建，没有更新）。

| 场景 | 怎么验证的 | 结果 | 截图 |
|------|------------|------|------|
| R1.1 `--id` 更新 | 升级后 `curl -F id=$A` 上传 517 B 的文件生成 v5 → 统计 `count/created/updated/updated.bytes` 从 `4 2 2 632` 变成 `5 2 3 1149`（+1 次更新，+517 B） | 通过 | — |
| R1.2 站点更新 | `bin/dview upload site1` 新建站点，再 `dview upload site2 --id <id>`（解压后 19+2 B）→ `types` 里 site 是 `created {1,12}`、`updated {1,21}` | 通过 | — |
| R1.3 模板渲染 | `dview template push examples/templates/vendor-bill`，`dview render vendor-bill --data example.json`，再加 `--id` 渲染一次 → activities 里这个 id 有 `["update",2]`、`["create",1]`；另外 `test-templates.js` 的新断言也通过 | 通过 | — |
| R1.4 失败的更新不计 | 用 png 更新 html 资源 → 400 `type mismatch`；bob 更新 alice 的资源 → 403 → 计数仍是 `5 2 3 1149`。429（超配额）只靠 `test-statistics-updates.js` 覆盖（start.sh 的配置里没有小配额 token），这个测试通过 | 通过（429 只有自动化测试） | — |
| R1.5 不是新版本的操作 | `PATCH /api/me/items/A/access {"mode":"code","reset":true}` 200，`PATCH …/meta`（分类、简介）200，`DELETE …/versions/2` 200 → 计数仍是 `5 2 3 1149` | 通过 | — |
| R1.6 删除后历史保留 | bob 新建 C（带简介 SECRETDESC-123），更新 2 次 → `8 3 5`；删除 C → 仍是 `8 3 5`；`/day` 里 C 的 3 行 `retained:false, filename:null`；弹窗里显示“已删除的 HTML 文件 … 已删除” | 通过 | verify-R3.3-dialog.png |
| R1.7 更新途中退出 | 没法用真实路径卡准退出时机；单元测试 `update_intent_recovery`、`recover_uncommitted_update_cleans_dir`、`delete_finalizes_pending_update` 通过 | 通过（只有单元测试） | — |
| R2.1 回填保留的版本 | 升级后第一次启动：`updates/` 里正好有 `A.2.json`（216 B，at 04:19:31.454Z）和 `A.4.json`（416 B，at 04:19:31.546Z），`backfilled:true`，时间和大小等于元数据版本记录；`coverage.backfilledUpdates 2` | 通过 | — |
| R2.2 重启不重复 | 重启 → `[12,37540,…,updated 7,backfilled 2]` 不变；停服务、删 `resources.sqlite*` 再启动 → 不变；server.log 没有 error | 通过 | — |
| R2.3 无效版本跳过 | 需要手改元数据才能造，skill 不让这样“证明”；单元测试 `backfill_skips_invalid_versions`（`skippedVersions 1`）通过 | 通过（只有单元测试） | — |
| R2.4 回填前已删除的资源 | B 在升级前（main 上）更新过并删除 → 升级后没有 B 的更新记录，只有它的新建（已删除）；页面横幅显示“当前范围的历史上传可能不完整” | 通过 | verify-R3.1-R3.2.png |
| R3.1 数字卡片 | 浏览器：今日上传 `13 个`，下方“新建 6 · 更新 7”；近 30 天同样 | 通过 | verify-R3.1-R3.2.png |
| R3.2 趋势图 | 今天只有 1 个可聚焦的 `rect.bar`，两段 `create:66`、`update:77`（px）；图例“新建 / 更新”；键盘聚焦后 `#chart-hover` = `11-09 · 新建 6 · 更新 7 · 37 KB`；切到“上传体积”仍然两段 | 通过 | verify-R3.1-R3.2.png |
| R3.3 月历和当日明细 | 月历格子“13 个”，aria-label `上传 13 个，新建 6 更新 7`，有两段比例条；明细标签“新建”“更新 · v2”；“查看当日记录”弹窗表头 `文件 动作 类型 来源 上传时间 状态`，第 1/2 页 12 行，第 2/2 页 1 行 | 通过 | verify-R3.3-day.png、verify-R3.3-dialog.png |
| R3.4 最近活动 | 删除 bob 的图片后刷新：`账户删除 · 图片`、`新建 · 图片`、`更新 v2 · HTML`、`新建 · HTML`；回填的 A v2/v4 不在 activities 里（接口里 8 条都是 `backfilled:false`） | 通过 | verify-R3.4-activities.png |
| R3.5 类型分布和排行 | 类型：HTML 10“新建 4 · 更新 6”、站点 2“新建 1 · 更新 1”；项目：proj-x 3“新建 1 · 更新 2”；来源：alice 9“新建 4 · 更新 5”，bob 4“新建 2 · 更新 2” | 通过 | verify-R3.4-R3.5.png |
| R3.6 筛选 | 来源选 bob → 今日 4“新建 2 · 更新 2”（C 的新建、2 次更新、图片）；“资源换项目后，更新跟着新项目走”只有单元测试 `filters_apply_to_updates`，通过 | 通过 | — |
| R3.7 没有更新时 | 类型选“图片” → “新建 1 · 更新 0”，当日“共 1 条（新建 1 · 更新 0）”；1440/768/390 都没有横向滚动；没有 pageerror、console error 或 4xx/5xx | 通过 | verify-R3.7-390.png |
| R3.8 统计口径 | 弹窗里有“上传 = 新建 + 更新”“新建”“更新：…改访问码、分类、简介，删除历史版本，都不算更新…已被清理的版本和上线前已删除资源的更新无法还原”；“记录开始…已回填新建 0 条、更新 2 条” | 通过 | verify-R3.8.png |
| 深色主题 | 切到深色，整页截图，没有报错 | 通过（有备注 N3） | verify-R3-dark.png |
| R4.1 原字段 | `summary.uploads` 有 `count`、`bytes`、`backfilledCount`，`count 12 = created 5 + updated 7`；activities 有 `kind:"upload"` 和 `uploadKind` | 通过 | — |
| R4.2 权限 | 未登录和只带上传 token 请求 `/admin/api/statistics`、`/admin/api/statistics/day` → 4 次都是 401 | 通过 | — |
| R5.1 隐私 | `grep -rlE 'a[0-9]\.html\|c[0-9]\.html\|SECRETDESC\|verify-token\|hash\|salt\|sealed\|filename\|description\|example\.json' data/statistics` → 没有匹配；`updates/` 是 700，文件是 600；统计和 /day 接口里找不到 SECRETDESC、token、hash/salt/sealed、accessCode、description；仍保留的资源返回文件名，已删除的是 null | 通过 | — |

## 完成条件

**本地部分成立**：R1–R5 每个场景都有单元、集成或 `--browser` 测试，`SMOKE_SKIP_RENDER=1 npm test` 和 `npm run test:browser` 在 0b2d646 上都 exit 0。另外在隔离实例上用 main → 0b2d646 的真实升级证实了回填：升级前保留的更新版本，升级后显示在统计页上。
**上线后的部分本地验证不了**：“生产管理统计页能看到回填的 5 个历史更新”要部署后在 production 只读检查。

## 问题

都不拦：都是小问题，不影响计数是否正确。

| # | 问题 | 证据（操作 → 实际 → 应有） | 严重程度 | 拦不拦 |
|---|------|------------------------------|----------|--------|
| N1 | 当日明细和弹窗里，更新行显示的是资源**当前**的文件名，不是那个版本的文件名 | A 的 v2 上传的是 `a2.html`，当前版本是 v5 `a5.html` → 弹窗里显示 `a5.html 更新 · v2 HTML alice … 保留中`（walk.js 输出 dialogPage1）→ 更好是显示 v2 自己的文件名，或者不显示文件名。spec 只要求“仍保留的资源照旧返回文件名”，没规定显示哪个版本的 | 低 | 不拦 |
| N2 | 某个版本已经被删除（`DELETE …/versions/2`），它的更新行仍然标“保留中” | 同一个弹窗：`a5.html 更新 · v2 … 保留中`，但 v2 已经删了 → 用户可能以为 v2 还在。`retained` 的意思是“资源还在”，不是“这个版本还在” | 低 | 不拦 |
| N3 | 深色主题下，“更新”标签用的是写死的浅色背景 | `getComputedStyle('.kind-tag.update')` → 背景 `rgb(254,243,226)`、文字 `rgb(180,83,9)`，页面背景 `rgb(26,26,26)`（`views/statistics.html` 第 42 行 `.kind-tag.update{background:#fef3e2;color:#b45309}`）→ 应该像其他状态标签那样用 `--orange-bg`/`--orange-text`。现在仍然看得清（verify-R3-dark.png），只是在深色页面上比较刺眼 | 低 | 不拦 |

## 放松检查

无。`git diff main...HEAD --numstat -- scripts package.json .gitignore`：`test-statistics.js` +135/−1（删掉的 1 行是旧的结尾 `console.log`，换成了更长的说明）；`test-templates.js` +4/−0；新加 `test-statistics-updates.js`；`package.json` 只是在 `test:statistics` 和 `test:browser` 里各加一个脚本。`test-statistics-integration.js` 没改；没有删测试，没有放宽断言，没有调大超时，没有加忽略规则（`.gitignore` 没改）。

## 验证时的副作用

`dview render` 的数据文件在 worktree 里，所以 CLI 在 worktree 根目录改写了 `.dview.json`；我已经用 `git checkout -- .dview.json` 恢复，worktree 的 `git status` 是干净的。CLI 运行时 `HOME` 指向临时目录，没有同步 skill 到本机 `~/.claude`。没碰 `~/vibeview-prod` 和 systemd 服务。
