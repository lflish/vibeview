# 测试报告：统计页区分新建和更新

日期：2026-11-09　分支：change/stats-create-vs-update　提交：63b6ae8

> 浏览器测试：用本机无头浏览器（Playwright Chromium headless shell 1248）完成；`.devflow.yml` 设了 `cloud_browser: forbidden`。
> 测试环境：e2e_env = local（隔离实例，临时目录和随机端口）；独立验证结论见 verdict.md

## 汇总

项目的测试是 `scripts/*.js` 脚本，每个脚本里有多条断言，按脚本统计：

| 类别 | 通过 | 失败 | 跳过 | 合计 |
|------|------|------|------|------|
| 单元（`scripts/test-statistics.js` 等） | 全部 | 0 | 0 | `npm test` 的全部脚本 |
| 集成（含 `test-statistics-updates.js`、`test-templates.js`、smoke 81 项） | 全部 | 0 | 0 | 同上 |
| 浏览器（`npm run test:browser`，含新增的 `test-statistics-updates.js --browser`） | 全部 | 0 | 0 | 15 个浏览器脚本 |

运行命令和结果（2026-11-09，提交 63b6ae8）：

```
$ SMOKE_SKIP_RENDER=1 npm test
statistics unit: … update events/backfill/recovery and create-vs-update aggregation passed
statistics integration: auth, backfill before retention, successful/failed uploads, … passed
statistics updates: --id/site updates, rejected updates, access/label/version edits, concurrent updates, deletion history, privacy and restart idempotence passed
templates (direct): … passed
templates (render proxy): … passed
[smoke] passed=81 failed=0
[smoke] ALL smoke checks passed
npm test exit 0

$ npm run test:browser
statistics browser: live filters/calendar/day pagination, history coverage, dark/light persistence, stale/error/401 handling and responsive layouts passed
statistics updates browser: cards, stacked trend, calendar/day/dialog tags, activities, breakdowns, empty-update filter, definitions, responsive layout passed
… （theme、admin、access、site、templates 的浏览器脚本全部 passed）
test:browser exit 0
```

`SMOKE_SKIP_RENDER=1` 跳过 Docker 渲染 sidecar 的冒烟；本次没改 sidecar（`render-server.js` 不读统计）。

## 场景对照

| 场景 | 测试 | 层级 | 结果 | 证据 |
|------|------|------|------|------|
| R1.1 `--id` 更新记一次 | `update_live_version_counts_once`；updates 脚本 R1.1 | 单元、集成 | 通过 | — |
| R1.2 站点更新 | updates 脚本 R1.2 | 集成 | 通过 | — |
| R1.3 模板渲染生成新版本 | `test-templates.js` 新增断言（直连和代理两种模式） | 集成 | 通过 | — |
| R1.4 失败的更新不计（400/403/429） | updates 脚本 R1.4 | 集成 | 通过 | — |
| R1.5 非新版本操作不计 | `access_edit_after_update_not_counted`、`deleted_version_not_recounted`；updates 脚本 R1.5 | 单元、集成 | 通过 | — |
| R1.6 删除后历史保留 | `update_history_survives_delete`；updates 脚本 R1.6 | 单元、集成 | 通过 | — |
| R1.7 更新途中服务退出 | `update_intent_recovery`、`recover_uncommitted_update_cleans_dir`、`delete_finalizes_pending_update`、`delete_fails_when_update_finalize_fails` | 单元 | 通过 | — |
| R2.1 回填保留的版本 | `backfill_retained_versions`；探索式检查（10-21 的回填更新） | 单元、浏览器 | 通过 | — |
| R2.2 重启不重复 | `backfill_idempotent`；updates 脚本重启和删索引后重启 | 单元、集成 | 通过 | — |
| R2.3 无效版本跳过 | `backfill_skips_invalid_versions`、`current_version_invalid_returns_null` | 单元 | 通过 | — |
| R2.4 回填前已删除的资源 | 单元：无元数据的资源不产生更新 | 单元 | 通过 | — |
| R3.1 数字卡片 | updates 浏览器 R3.1 | 浏览器 | 通过 | evidence/R3.1-R3.2.png |
| R3.2 趋势图两段 | updates 浏览器 R3.2（每天一个可交互元素、聚焦文案、体积指标） | 浏览器 | 通过 | evidence/R3.1-R3.2.png |
| R3.3 月历和当日明细 | updates 浏览器 R3.3（含“条仍保留”、弹窗“动作”列） | 浏览器 | 通过 | evidence/R3.3.png |
| R3.4 最近活动 | updates 浏览器 R3.4 | 浏览器 | 通过 | evidence/R3.4-R3.5.png |
| R3.5 类型分布和排行 | `aggregate_split_types_projects_sources`；updates 浏览器 R3.5 | 单元、浏览器 | 通过 | evidence/R3.4-R3.5.png |
| R3.6 筛选 | `filters_apply_to_updates`；updates 浏览器（来源筛选） | 单元、浏览器 | 通过 | — |
| R3.7 没有更新时 | updates 浏览器 R3.7（1440/768/390 无横向滚动） | 浏览器 | 通过 | evidence/R3.7.png（390 宽） |
| R3.8 统计口径说明 | updates 浏览器 R3.8 | 浏览器 | 通过 | evidence/R3.8.png |
| R4.1 原字段仍可用 | `api_keeps_old_fields`；updates 脚本 R4.1 | 单元、集成 | 通过 | — |
| R4.2 权限不变 | 现有 `test-statistics-integration.js` 401 断言 | 集成 | 通过 | — |
| R5.1 日志和接口不含敏感信息 | 单元日志隐私循环（含 updates、pending-update）；updates 脚本日志和接口检查 | 单元、集成 | 通过 | — |
| 容易出问题：并发两次更新 | updates 脚本 `concurrent_updates_two_events` | 集成 | 通过 | — |
| 容易出问题：日志损坏 / 状态缺失 | `corrupt_update_journal_throws`、`state_missing_with_updates_throws` | 单元 | 通过 | — |
| 深色主题 | updates 浏览器（切换深色截图） | 浏览器 | 通过（人工看图） | evidence/R3-dark.png |

## 探索式检查

检查的页面：`/admin/statistics`（桌面 1280、1440，手机 390；浅色和深色），用带新建、更新、删除和一条回填更新的隔离实例。操作：键盘聚焦趋势柱回车选日、切到上个月的日期、类型筛选、统计口径弹窗、当日记录弹窗分页。控制台和网络：没有 JS 报错，没有 4xx/5xx。

| 编号 | 程度 | 问题 | 处理 |
|------|------|------|------|
| X1 | 低 | 类型筛选下拉框没有“站点”选项（只有 HTML、图片、视频），但类型图例可以点“站点”筛选；之前就存在，和本需求无关 | 未修复，记入 tasks.md 后续 |
| X2 | 低 | 当日明细里“仍保留”的数量把同一资源的多条记录各算一个（代码评审发现） | 已修复 218203c，文案改为“条”；浏览器回归断言在 updates 浏览器 R3.3 |

## 修复记录

| 问题 | 提交 | 回归测试 | 复测 |
|------|------|----------|------|
| X2 仍保留数 | 218203c | updates 浏览器 R3.3 断言“条仍保留” | 通过 |
| verify skill 的 start.sh 记录了错误的 PID（调用方挂起） | 63b6ae8 | 完整跑通 verify skill：启动 → 体检 → 1 新建 2 更新 → 重启 → 清理 | 通过 |

## 未覆盖和遗留

- 生产数据上的回填只做了只读核对（49 个资源、5 个更新版本、记录全部有效），真正的回填在上线后发生；上线后检查见完成条件。
- 渲染 sidecar 冒烟（Docker）本次没跑：sidecar 不涉及统计。
- 后续：X1 类型筛选缺“站点”；E3“迭代最多的页面”排行。
