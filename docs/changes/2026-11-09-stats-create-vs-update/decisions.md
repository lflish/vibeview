# 裁决记录 · 统计页区分新建和更新

规则见 dev-workflow/references/decisions.md。只追加，不修改旧行。

| # | 阶段 | 决定 | 类型 | 依据 | 理由 | 放弃的选项 | 定错的代价 | 处理结果 |
|---|------|------|------|------|------|------------|------------|----------|
| 1 | 需求 | 规模定为“标准” | 机械 | 规模规则 | 要改统计日志、统计接口、统计页和测试，超过 3 个文件 | 小 | 低 | — |
| 2 | 需求 | 新建 .devflow.yml 草稿；命令从 package.json 推断（test 用 SMOKE_SKIP_RENDER=1 npm test，e2e 用 npm run test:browser） | 机械 | config.md | 项目还没有 devflow 配置 | — | 低 | 关口 A 请用户看 |
| 3 | 需求 | 新需求放 docs/changes/，docs/specs/README.md 索引加一行链接 | 机械 | 用户 2026-11-09 回复“默认” | 不迁移旧 spec | 放进 docs/specs/ | 低 | — |
| 4 | 需求 | cloud_browser 设为 forbidden | 机械 | 原则1 | 管理端和预览页可能含用户内容；本机有 Chrome 可用 | allowed | 低 | 关口 A 请用户看 |
