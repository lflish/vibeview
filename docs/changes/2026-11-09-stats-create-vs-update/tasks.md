# 任务：统计页区分新建和更新

依据：spec.md、design.md　共 5 个任务　更新：2026-11-09

## 测试计划

| 场景 | 层级 | 测试名 | 要点 | 谁写 |
|------|------|--------|------|------|
| R1.1 | 单元 | `update_live_version_counts_once` | 资源 v1 → 写入 v2：`summary.uploads` 合计 +1，`updated.count` 1，`updated.bytes` = v2 size | T1 |
| R1.1 | 集成 | `R1.1 --id 更新记一次` | HTTP 上传后带 `id` 再传：`today.updated.count` 1、`created.count` 不变 | T3 |
| T4 | 2026-11-09 04:05 | a0746b1 | npm run test:browser 通过（含统计页 390/768/1440 无横向滚动）；带更新数据的截图检查无报错 |
| T5 | 2026-11-09 04:06 | 30b6ebb | 两份指南都有新建/更新定义和新字段（grep uploadKind 各 1 处） |
| R1.2 | 集成 | `R1.2 站点更新` | 站点 zip 更新：`types` 里 site 的 `updated.count` 1，`bytes` = 新版本解压大小 | T3 |
| R1.3 | 集成 | `R1.3 模板渲染生成新版本` | `scripts/test-templates.js` 第 171 行附近带 `id` 渲染之后，管理员统计 `summary.uploads.updated.count` ≥ 1 | T3 |
| R1.4 | 集成 | `R1.4 被拒的更新不计` | 类型不一致 400、他人资源 403、超配额 429 后，`created`、`updated` 都不变 | T3 |
| R1.5 | 集成 | `R1.5 非新版本操作不计` | 改访问码、改分类、删除第 2 版：`updated.count` 不变 | T3 |
| R1.6 | 单元 + 集成 | `update_history_survives_delete` / `R1.6 删除后历史保留` | 删除资源后合计仍含 1 新建 + 2 更新；`/day` 的这 3 行 `filename` 为 null | T1 / T3 |
| R1.7 | 单元 | `update_intent_recovery` | 意图 + 元数据含 v_n → 重启记 1 次；意图但元数据无 v_n → 不记，意图被删 | T1 |
| R2.1 | 单元 | `backfill_retained_versions` | 元数据保留 v1、v2、v4 → 回填 2 条，`at`/`bytes` 等于版本记录，`backfilled: true` | T1 |
| R2.2 | 单元 + 集成 | `backfill_idempotent` / 现有“删索引后重启” | 重启两次、删 `resources.sqlite` 后重启：`updated.count` 不变 | T1 / T3 |
| R2.3 | 单元 | `backfill_skips_invalid_versions` | 版本 `createdAt: 'bad'` → 不记，`coverage.skippedVersions` 1 | T1 |
| R2.4 | 单元 | `backfill_deleted_before_upgrade` | 上线前已删除的资源没有元数据 → 无更新，`periodComplete` 为 false | T1 |
| R3.1 | 浏览器 | `R3.1 卡片显示合计和拆分` | 今日上传显示合计，`#today-split` 文本含 “新建 2” “更新 3” | dev-test |
| R3.2 | 浏览器 | `R3.2 趋势柱分两段` | 有更新的日期有两个 rect（`data-part="create"` / `"update"`）；聚焦后 `#chart-hover` 含 “新建 X · 更新 Y”；切到“上传体积”仍两段 | dev-test |
| R3.3 | 浏览器 | `R3.3 月历和当日明细` | 月历格子数字 = 合计；当日列表有 “更新 · v2” 标签；弹窗表格有“动作”列且分页正常 |；“N 条仍保留”（评审 d1 的回归断言） | dev-test |
| R3.4 | 浏览器 | `R3.4 最近活动` | 列表里同时有 “新建”“更新 v<n>”“删除”；回填事件不出现 | dev-test |
| R3.5 | 单元 + 浏览器 | `aggregate_split_types_projects_sources` / `R3.5 分布和排行显示拆分` | `types[]`、`projects[]`、`sources[]` 都有 `created`/`updated`；页面上类型图例和排行有 “新建 x · 更新 y” | T2 / dev-test |
| R3.6 | 单元 | `filters_apply_to_updates` | `source`/`type`/`project` 筛选下更新同样被过滤；改项目后更新按当前项目归类 | T2 |
| T3 | 2026-11-09 04:02 | 7e1edd9 | test-statistics-updates 通过（对旧代码运行失败，确认能抓到问题）；test-templates 通过；npm test 通过 |
| R3.7 | 浏览器 | `R3.7 没有更新时` | 筛到没有更新的来源：显示 “更新 0”，无横向滚动，无 pageerror | dev-test |
| R3.8 | 浏览器 | `R3.8 统计口径说明` | 口径弹窗含 “更新” 定义，包含 “删除历史版本不算” | dev-test |
| R4.1 | 单元 + 集成 | `api_keeps_old_fields` | `count`、`bytes`、`backfilledCount`、`kind` 仍在；`count` = created + updated | T2 / T3 |
| R4.2 | 集成 | 现有 401 断言 | 未登录、上传 token → 401 | 已有 |
| R5.1 | 单元 + 集成 | 扩展现有日志隐私检查 | `updates/`、`pending-update/` 文件权限 600，不含 PRIVATE / filename / access；接口返回不含 token、描述、哈希 | T1 / T3 |

### 容易出问题的情况

| 情况 | 合理的预期 | 测试 | 谁写 |
|------|------------|------|------|
| 同一资源并发两次更新（v2、v3 同时写） | 各记 1 条，共 2 条，不丢不重（版本锁保证串行） | 集成 `concurrent_updates_two_events`：`Promise.all` 两次 `--id` 上传 | T3 |
| 删除第 2 版后再上传新版本（得到 v4） | 记 v4 一条；v2 的旧记录保留；v2 不会被当成新版本再记 | 单元 `deleted_version_not_recounted` | T1 |
| 更新意图写好、资源随即被删除（意图还没转正） | 删除前补齐，记 1 条更新；重启不重复 | 单元 `delete_finalizes_pending_update` | T1 |
| 老资源没有新建记录（创建时间无效）被更新 | 记更新；新建仍缺失（`skippedMetadata` 不变） | 单元 `legacy_resource_update_counts` | T1 |
| 统计日志 `updates/` 里有损坏文件 | 启动报错 “Invalid statistics journal”，不当成零 | 单元 `corrupt_update_journal_throws` | T1 |

## 任务

### T1 记录更新事件、恢复和回填
- 状态：完成
- 文件：修改 `lib/statistics-store.js`；测试 `scripts/test-statistics.js`
- 接口：
  - 使用：`versions.list(meta)`、`versions.find(meta, 1)`（`lib/versions.js`，现有，不依赖 config）；现有 `atomic`、`finalize` 的做法
  - 提供：`prepareUpload(meta) → { upload, updates[] } | null`；`cancelUpload(ticket)`；`commitUpload(meta, ticket)`；`prepareDelete(meta, reason)` 先补齐更新；新目录 `updates/`、`pending-update/`，文件名 `<id>.<n>.json`；事件字段见 design.md 第 5 节；内存 `updates: Map<'id.n', event>`；`coverage.backfilledUpdates`、`coverage.skippedVersions`
  - `seed(meta)` 的体积改为 v1 大小（H8）
- 场景：R1.1、R1.6、R1.7、R2.1–R2.4、R5.1，以及上面 4 个容易出问题的情况（并发那条除外）
- 测试（加到 `scripts/test-statistics.js`，沿用文件里的 `meta()`、`save()`、`upload()` 帮助函数；新增 `update(stats, m, n, size)`：把 `{ n, size, createdAt }` 追加进 `m.versions`、`current = n`，走 prepareUpload → save → commitUpload）：
  - `update_live_version_counts_once`：v1 size 100，更新 v2 size 40 → `summary().summary.uploads` 为 `{ count: 2, bytes: 140, created: { count: 1, bytes: 100 }, updated: { count: 1, bytes: 40 } }`（只比较这几个字段）
  - `access_edit_after_update_not_counted`：再对同一 meta 改 `access` 写一次 → `updated.count` 仍 1
  - `deleted_version_not_recounted`：v1、v2、v3（当前 3，已记 2 条）→ 删 v2（versions 去掉 n=2）写一次 → 仍 2；再更新得到 v4 → 3，v2 不重复记
  - `invalid_version_does_not_block_edits`：回填时跳过一个无效的 v2（当前 v2）后，改访问码写一次元数据 → 不抛错，`updated.count` 不变
  - `update_history_survives_delete`：删除资源 → `uploads.count` 不减；`day().items` 里该资源的行 `filename === null`、`uploadKind` 各为 create/update
  - `update_intent_recovery`：手动 `prepareUpload` 得到 v_n 意图后 `save()`，重新 `createStatistics(...).initialize()` → 记 1；另一个只写意图不 save → 重启后不记，`pending-update/` 为空
  - `delete_finalizes_pending_update`：意图转正时注入 rename 失败（现有注入方式），随后删除资源，重启 → 更新 1 条
  - `delete_fails_when_update_finalize_fails`：留下一个 pending 更新，删除时注入写 `updates/` 失败 → `prepareDelete` 抛错，元数据仍在
  - `backfill_retained_versions`：先 save 一个保留 v1、v2、v4 的资源（不经 stats），初始化 → `updated.count` 2，`backfilledUpdates` 2，两条 `at` 等于各自 `createdAt`
  - `backfill_idempotent`：再初始化两次 → 仍 2
  - `backfill_skips_invalid_versions`：v2 `createdAt: 'bad'` → 不记，`skippedVersions` 1
  - `backfill_deleted_before_upgrade`：没有元数据的资源无法回填（只断言 `updated.count` 不含它）
  - `legacy_resource_update_counts`：现有 `invalid`（创建时间无效）资源加 v2 → `updated.count` +1，`skippedMetadata` 不变
  - `seed_uses_v1_size`：新建记录缺失、元数据 `size` 300 但 v1 size 100 → 回填新建 `bytes` 100
  - `current_version_invalid_returns_null`：当前版本 v2 的 `createdAt` 无效 → 改访问码写元数据不抛错，不记更新
  - `recover_uncommitted_update_cleans_dir`：意图 v3 存在、元数据 current 为 2、`.versions/3` 目录存在 → 重启后意图和目录都被删，不记
  - `state_missing_with_updates_throws`：删掉 `state.json`、保留 `updates/` → 初始化抛 `/Statistics state is missing/`
  - `corrupt_update_journal_throws`：`updates/` 写 `{}` → 初始化抛 `/Invalid statistics journal/`
  - 扩展现有日志隐私循环，目录加上 `updates`、`pending-update`
- 完成定义：`node scripts/test-statistics.js` 输出 `statistics unit: … passed`，退出码 0
- 依赖：无

### T2 聚合和接口字段
- 状态：完成
- 文件：修改 `lib/statistics-store.js`（`aggregate`、`details`、`context`、`summary`、`day`、`filter`）；测试 `scripts/test-statistics.js`
- 接口：
  - 提供：design.md 4.2、4.3 的字段：所有聚合对象加 `created`、`updated`；`count`/`bytes` 为合计；`activities`、`deletionActivities`、`day.items` 加 `uploadKind`、`version`；`day` 加 `created`、`updated`；未来日期这两项为 `null`
  - 事件来源：`context()` 的 `events` = 新建事件（`uploadKind: 'create'`, `version: 1`）+ 更新事件（`uploadKind: 'update'`）；`projectOf` 对更新同样按当前项目归类
  - `activities` 里回填的更新不出现（沿用 `filter(e => !e.backfilled)`）
  - 排序：时间倒序，再按 id、版本号倒序
- 场景：R3.5、R3.6、R4.1（接口层）
- 测试：
  - `aggregate_split_types_projects_sources`：1 个 html 新建 + 2 次更新、1 个 image 新建 → `types` html `{count:3, created:{count:1}, updated:{count:2}}`，image `updated.count` 0；`sources`、`projects` 同理
  - `filters_apply_to_updates`：`summary({ source: 'bob' })` 不含 alice 的更新；`type: 'image'` 不含 html 更新；资源改项目后 `project` 筛选按新项目
  - `api_keeps_old_fields`：`summary().summary.uploads` 有 `count`、`bytes`、`backfilledCount`；`activities[0]` 有 `kind: 'upload'` 和 `uploadKind`；`count === created.count + updated.count`
  - `day_lists_updates`：`day({ date })` 的 `count` 3、`created.count` 1、`updated.count` 2，`items` 里有 `version: 2`
- 完成定义：`node scripts/test-statistics.js` 通过；`npm run test:statistics` 通过（现有集成测试不受影响）
- 依赖：T1

### T3 集成测试：真实上传路径
- 状态：完成
- 文件：新建 `scripts/test-statistics-updates.js`（独立的服务实例和临时目录，写法照 `scripts/test-statistics-integration.js`）；修改 `package.json` 的 `test:statistics`，把它加在 `test-statistics-integration.js` 之后；修改 `scripts/test-templates.js`（只加 R1.3 的断言）；如测试暴露问题，修改 `lib/statistics-store.js` 或 `server.js`。现有 `test-statistics-integration.js` 不改（它写死的 19 / 21 / 16 等期望值不受影响）
- 接口：使用现有 `upload()`、`request()`、`auth()`、`summary()`；新增 `uploadUpdate(id, name, token)`：`FormData` 带 `id` 字段
- 场景：R1.1、R1.2、R1.3、R1.4、R1.5、R1.6、R2.2、R4.1、R5.1、并发更新
- 新脚本的 config：tokens `alice`、`bob`（R1.4 的“他人资源”）、`tiny`（`max_storage_mb: 0.001`，R1.4 的超配额）
- 测试：
  - `R1.1 --id 更新记一次`：新建 → 带 id 再传 → `today.updated.count` +1，`created.count` 只因新建 +1
  - `R1.2 站点更新`：用 `scripts/test-site.js` 的 zip 构造方式上传站点，再带 id 更新 → `types` 里 site 的 `updated.count` +1
  - `R1.4 被拒的更新不计`：带 id 传图片到 html 资源（400）、用另一个 token 更新（403）→ 计数不变；超配额（429）：单独配置一个 `max_storage_mb` 很小（例如 0.001）的 token，先新建一个小页面，再带 id 传一个超过上限的文件（更新不占文件数，只受存储上限限制，见 `lib/accounts.js` `checkQuota`）
  - `R1.5 非新版本操作不计`：PATCH 访问码、PATCH 分类、`DELETE /api/me/items/:id/versions/2` → `updated.count` 不变
  - `R1.6 删除后历史保留`：新建 + 2 次更新后删除 → 合计不减，`/day` 里这 3 行 `filename === null`
  - `concurrent_updates_two_events`：同一资源 `Promise.all` 两次更新 → `updated.count` +2
  - `R4.1`：`summary.uploads` 的 `count === created.count + updated.count`
  - R5.1：现有 `serialized` 检查覆盖新字段（不改断言，只确认仍通过）
  - R2.2：新脚本结尾停服务、删 `resources.sqlite`、再启动，`updated.count` 不变
  - `scripts/test-templates.js`：在第 207 行管理员登录（`admin` cookie）之后读 `/admin/api/statistics`，断言 `summary.uploads.updated.count` ≥ 1（第 171 行的渲染更新已经发生）（R1.3）
- 完成定义：`node scripts/test-statistics-updates.js`、`npm run test:statistics`、`node scripts/test-templates.js` 通过；`SMOKE_SKIP_RENDER=1 npm test` 通过
- 依赖：T2

### T4 统计页区分新建和更新
- 状态：完成
- 文件：修改 `views/statistics.html`
- 接口：使用 T2 的字段
- 场景：R3.1–R3.8（浏览器测试由 dev-test 写）
- 改动：
  - 卡片：“今日上传”“<范围>上传”下面加一行 `新建 X · 更新 Y`，元素 `id="today-split"`、`id="period-split"`
  - 趋势图：每天**只有一个**可聚焦、可点击的元素，保留 `class="bar"`、`tabindex`、`role="button"`、aria-label 和点击事件（一个透明的整柱 rect，或包住两段的 `<g class="bar">`）；两段 rect 只负责显示，不带 `bar` 类，属性 `data-part="create"` / `data-part="update"`、`data-date`；选中和悬停改用描边或透明度表示，不要用 `fill` 覆盖两段的颜色（现有 `.chart rect.selected{fill:…!important}` 要改）；颜色：新建沿用现有蓝 `#6c9ff5`/`#bfd4f9`，更新用橙 `#f59e0b`（今天）/`#fcd9a0`；图例两项；`#chart-hover` 和 aria-label 写 `MM-DD · 新建 X · 更新 Y`；文件数和上传体积两种指标都分段
  - 月历：格子数字仍是合计；aria-label 加 `新建 X 更新 Y`；格子底部加一条细比例条（`class="mix"`，和效果页一致）
  - 当日明细列表和“查看当日记录”弹窗：每行加标签 `新建` 或 `更新 · v<n>`；弹窗表格加“动作”列
  - 最近活动：上传行写“新建”或“更新 v<n>”，删除行不变
  - 类型分布图例、按项目、上传来源：数字旁加 `新建 x · 更新 y`（小字）
  - 统计口径弹窗：把“今日上传”“累计上传”两条改为“上传 = 新建 + 更新”，新增“更新”一条：上传了新版本；改访问码、分类、简介，删除历史版本不算；历史更新从保留的版本回填，已清理的版本无法还原
  - 深色主题：新颜色在现有深色变量下检查对比度（沿用 `theme.css` 的做法）
- 测试：`node scripts/test-statistics-integration.js --browser` 现有断言全部仍通过（不改它们的期望值）
- 完成定义：`npm run test:browser` 通过；390px、768px、1440px 无横向滚动（现有断言）
- 依赖：T2

### T5 文档
- 状态：完成
- 文件：修改 `docs/user-guide.zh-CN.md`、`docs/user-guide.en.md` 的“管理统计”一节（第 247–254 行）和接口说明（第 279–281 行）；`docs/specs/resource-versions.md` 验收里被划掉的“统计里，更新记为一次上传事件”一行，加一句“已在 docs/changes/2026-11-09-stats-create-vs-update 实现”
- 内容（建议稿，见汇总 c2）：
  - 中文：在“管理统计”第一段后加一句：“上传分为新建和更新：新建是第一次上传、生成新链接；更新是给已有链接上传新版本（同一路径再次上传、`--id`、模板重新渲染）。改访问码、分类、简介或删除历史版本都不算更新。页面上的上传数是两者合计，并分别列出。”；接口说明加 `created`、`updated`、`uploadKind`、`version` 字段
  - 英文：对应翻译
- 完成定义：两份指南都写了“新建 / 更新”的定义和新字段；`grep -n "uploadKind" docs/user-guide.*.md` 两份都有
- 依赖：T2；c2

## 进度

| 任务 | 完成时间 | 提交 | 测试 |
|------|----------|------|------|
| T1 | 2026-11-09 04:01 | 89fd83e | test:statistics 通过；npm test 通过（smoke 81/81） |
| T2 | 2026-11-09 04:01 | 89fd83e | 同上（和 T1 同一提交，decisions #13） |

## 后续

- E3 “迭代最多的页面”排行（按更新次数），评审时推迟
- X1 统计页类型筛选下拉框缺“站点”选项（之前就有，测试阶段探索发现，和本需求无关）
