# 管理统计

## 子功能

- 数字卡片：今日上传、所选范围上传（合计 + “新建 X · 更新 Y”）、当前文件数、当前占用
- 每日趋势（文件数 / 上传体积，新建和更新两段）、月历、当日明细和分页弹窗
- 类型分布、按项目、上传来源、最近活动（新建 / 更新 v<n> / 删除）
- 筛选：时间范围、来源、项目、类型；统计口径弹窗；访问情况
- 统计日志：`$DIR/data/statistics/`（uploads、updates、deletions 和对应的 pending-* 目录、state.json）

## 怎么到达

管理端登录 → 左侧“统计总览”，或直接打开 `$BASE/admin/statistics`。接口：`GET /admin/api/statistics`、`GET /admin/api/statistics/day?date=YYYY-MM-DD`（都要管理员 session）。

## 怎么操作和验证

1. 造数据：上传一个页面（新建），再用 `-F id=<id>` 上传两次（更新 v2、v3）；用 `DELETE /api/me/items/:id` 删一个资源。
2. 接口：`summary.uploads.count == created.count + updated.count`；今日的 `updated.count` 等于更新次数；`/day` 的 `items` 里更新行 `uploadKind: "update"`、`version` 为 2、3；已删除资源的行 `filename: null`。
3. 网页：`#today-split` 显示“新建 X · 更新 Y”，和接口一致；今天的趋势柱有 `[data-part="update"]`；聚焦 `rect.bar` 后 `#chart-hover` 显示拆分；当日明细有“更新 · vN”标签，底部写“N 条仍保留”；弹窗表格有“动作”列。
4. 不算更新的操作：改访问码、改分类、删除历史版本后，`updated.count` 不变。
5. 重启实例（stop `--keep` 后用同一目录 start）后数字不变。

## 注意事项

- “上传”是新建 + 更新的合计；“当前文件数/占用”不分新建和更新。
- 统计按 `statistics.timezone`（默认 Asia/Shanghai）分日；造数据的时间在“现在”之后的不会计入。
- 第一次启动会回填现存资源的新建和保留版本的更新，标“回填”，不出现在最近活动里。
- 统计日志损坏或 `state.json` 缺失时服务拒绝启动，这是预期行为：报告它，不要删日志绕过。
