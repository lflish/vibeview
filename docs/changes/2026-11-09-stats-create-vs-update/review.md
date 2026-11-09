# 评审：统计页区分新建和更新

日期：2026-11-09　范围：main..HEAD，12 个文件（不含需求文件夹）　评审者：same（全新子 agent；codex 探测返回 403 NOT_ENOUGH_MEMBER_BUDGET，claude 与开发同一工具跳过）

结论：无未处理的严重问题

| 统计 | 严重 | 一般 |
|------|------|------|
| 已修复 | 0 | 1 |
| 交给用户决定 | 0 | 0 |
| 不采纳 | 0 | 0 |

## 已修复
- [一般] `lib/statistics-store.js:295`、`views/statistics.html` 两处：加入更新事件后，同一资源在一天里可能有多条记录，页面上“N 个仍保留”把记录数当成资源数（证据：1 个资源新建 + 2 次更新，`day({})` 返回 `{ count: 3, retainedCount: 3 }`，我自己复跑得到相同输出）→ 接口字段含义不变（R4），页面文案改为“N 条仍保留”（提交 218203c；浏览器回归断言由 dev-test 在 R3.3 测试里写，见 d1）

## 交给用户决定
- d1 [一般] 上面的修法选了“改文案”而不是“接口按资源去重”：保持 `retainedCount` 原含义（R4.1 只新增字段、不改含义）。备选：接口改为按资源去重，并在指南写明。

## 评审者确认过的
- 只有主进程调用 `writeMeta`；版本号不复用；恢复时删除 `.versions/<n>` 不会碰到 v1 或已提交版本；删除前补齐和更新不会交错。
- 测试没有被放松：只新增断言，`package.json` 只加了一个测试步骤。

## 测试复跑
- `SMOKE_SKIP_RENDER=1 npm test` → exit 0，smoke 81/81
- `node scripts/test-statistics-integration.js --browser`（修复后）→ passed
- `npm run test:browser`（T4 后）→ exit 0
