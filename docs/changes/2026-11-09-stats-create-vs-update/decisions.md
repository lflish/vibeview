# 裁决记录 · 统计页区分新建和更新

规则见 dev-workflow/references/decisions.md。只追加，不修改旧行。

| # | 阶段 | 决定 | 类型 | 依据 | 理由 | 放弃的选项 | 定错的代价 | 处理结果 |
|---|------|------|------|------|------|------------|------------|----------|
| 1 | 需求 | 规模定为“标准” | 机械 | 规模规则 | 要改统计日志、统计接口、统计页和测试，超过 3 个文件 | 小 | 低 | — |
| 2 | 需求 | 新建 .devflow.yml 草稿；命令从 package.json 推断（test 用 SMOKE_SKIP_RENDER=1 npm test，e2e 用 npm run test:browser） | 机械 | config.md | 项目还没有 devflow 配置 | — | 低 | 关口 A 请用户看 |
| 3 | 需求 | 新需求放 docs/changes/，docs/specs/README.md 索引加一行链接 | 机械 | 用户 2026-11-09 回复“默认” | 不迁移旧 spec | 放进 docs/specs/ | 低 | — |
| 4 | 需求 | cloud_browser 设为 forbidden | 机械 | 原则1 | 管理端和预览页可能含用户内容；本机有 Chrome 可用 | allowed | 低 | 关口 A 请用户看 |
| 5 | 需求 | 评审回复 all：做法 B，E1、E2 加入，E3 推迟，Q1 A | 机械 | 用户回复 | — | — | — | — |
| 6 | 需求 | 新人通读提出 6 点：新建体积重复计算、更新时间口径、无新建记录的老资源 → 写成 H8–H10；回填去重键、崩溃恢复判断、接口字段命名 → 留给设计 | 机械 | dev-requirements 第 6 步 | 前 3 点有合理默认值；后 3 点是实现方法 | 作为 Q 问用户 | 低 | — |
| c1 | 需求 | AGENTS.md 加一段：新需求按 devflow 放 docs/changes/ | 只有人能做 | 规则文件 | 让其他 agent 也按同一位置找需求 | 不改 | 低 | 关口 A 用户同意（all）；已改 |
