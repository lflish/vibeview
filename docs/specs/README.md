# 需求 Spec

每个功能一份 spec。需求有变化时，先改 spec，再按 spec 实现；代码和 spec 对不上时，以 spec 为准，或者先把 spec 改对。

交互稿（HTML）放在 `designs/`，在 spec 里链接过去。

## 状态

每份 spec 开头写一行状态和日期：

| 状态 | 含义 |
| --- | --- |
| 草案 | 还在讨论，可以随意改 |
| 已确认 | 范围和验收条件定了，可以开始实现 |
| 实现中 | 正在开发；范围有变化先改 spec，并在「变更记录」里写一句 |
| 已实现 | 代码合入并通过验收；附验证记录 |
| 搁置 | 暂不做，写明原因 |

## 写法

参照已有的 spec，一般包括：

- **目标与范围**：要解决什么问题，本版做什么、不做什么
- **设计**：数据、接口、CLI、页面行为
- **验收**：可以逐条检查的条件
- **待定问题**：还没定的点，确认后移到正文
- **变更记录**：已确认之后的每次范围调整

## 索引

| Spec | 状态 | 说明 |
| --- | --- | --- |
| [admin-statistics.md](./admin-statistics.md) | 已实现 | 管理端统计 |
| [resource-versions.md](./resource-versions.md) | 已实现（v1.4.0） | 固定链接、更新内容、版本历史（模板和评审的基础） |
| [page-templates.md](./page-templates.md) | 已实现（v1.4.0；管理页下一轮） | 页面模板：关键词匹配、数据渲染、按模板开启功能 |
| [review-comments.md](./review-comments.md) | 草案 | 需求评审：页面批注、多角色评论、确认签字 |

实现顺序：resource-versions → page-templates（模板核心）→ review-comments 与导出功能 → 模板管理页。
