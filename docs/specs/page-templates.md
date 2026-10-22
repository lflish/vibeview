# 页面模板

状态：草案。日期：2026-10-22。依赖：[resource-versions.md](./resource-versions.md)。

## 目标与范围

两个场景：

1. **固定格式的页面**（如给某个供应商出账单）：每次都让 AI 从头生成 HTML，排版和细节会变。希望调好模板后，同样的数据每次生成的结果完全一样。
2. **不同类型的页面需要不同功能**：需求评审要评论和签字，账单要导出 Excel，普通页面什么都不需要。

模板 = 页面类型。它定义排版（可选）、数据结构、平台功能和给 agent 的说明。agent 通过 skill 查到匹配的模板后，按模板生成页面；没有匹配的模板时，保持现在的普通上传。

这样做的好处：

- 账单类页面只需要 agent 输出数据，结果固定
- 评论、导出等功能由平台实现，agent 不用每次写这些代码
- 模板相关的说明只在命中模板时加载，基础 skill 保持很短，节约 token

本版不做：模板市场或跨账户共享、可视化编辑模板、服务端 PDF 生成。

## 设计

### 模板目录

```
templates/vendor-acme-bill/
├── template.json   # 必需
├── index.html      # 固定排版时需要
├── schema.json     # 有数据时需要
├── example.json    # 示例数据，用于预览和给 agent 参考
└── guide.md        # 给 agent 的说明，可选
```

`template.json`：

```json
{
  "name": "vendor-acme-bill",
  "title": "ACME 月度账单",
  "description": "给 ACME 供应商出的月度账单",
  "match": ["ACME", "艾克米", "账单"],
  "category": "report",
  "tags": ["bill", "acme"],
  "layout": "index.html",
  "schema": "schema.json",
  "features": {
    "export": { "xlsx": { "sheet": "明细", "rows": "items", "columns": { "name": "项目", "qty": "数量", "price": "单价" } } },
    "print": true
  },
  "guide": "guide.md"
}
```

自由排版的模板（如需求评审）：

```json
{
  "name": "prd-review",
  "title": "需求评审",
  "description": "需求文档、交互原型，需要多人评审",
  "match": ["需求", "原型", "PRD", "评审"],
  "category": "prototype",
  "layout": null,
  "features": {
    "comments": { "roles": ["产品", "研发", "需求方"] },
    "signoff": { "required": ["产品", "需求方"], "decider": "产品" }
  },
  "guide": "guide.md"
}
```

### 存储与版本

- 模板存在服务端，属于创建它的账户。`data/templates/<name>/v<n>/`
- 每次 `push` 生成新版本。用模板生成的页面在 meta 里记录 `template` 和 `templateVersion`
- 页面生成时把模板的 `features` 复制到页面的 meta 里。以后改模板不影响已生成的页面；管理员可以单独修改某个页面的功能开关

### 渲染

- 固定排版：把数据以 `<script type="application/json" id="dview-data">` 嵌入 `index.html`，页面里固定的 JS 负责显示。结果仍是单文件 HTML
- 合计、税额等计算写在模板的 JS 里，数据里只放原始值
- 渲染前按 `schema.json`（JSON Schema 子集：类型、必填、枚举、数组）校验，不通过直接返回错误，列出缺少或错误的字段
- 渲染可以在 CLI 本地完成，也可以由服务端完成，两者用同一份代码，结果一致。服务端渲染时，页面数据另存一份，供导出使用
- 自由排版的模板不做渲染，agent 自己生成 HTML，上传时带上 `--template <name>`

### 关键词匹配

`GET /api/templates/match?q=<用户原话>`

- 匹配规则：不区分大小写的子串匹配，返回命中的模板和命中的关键词，按命中数量排序
- 管理页的"测试触发"和 agent 调用的是同一个接口，管理页测出来什么，agent 实际用的就是什么
- 命中多个模板时，由 agent 让用户选；没有命中时走普通上传

### 平台功能（第一批）

| 功能 | 说明 | 细节 |
| --- | --- | --- |
| `comments` | 页面批注和评论 | 见 [review-comments.md](./review-comments.md) |
| `signoff` | 指定角色确认、锁定定稿版本 | 见 [review-comments.md](./review-comments.md) |
| `export.xlsx` | 导出 Excel | 服务端用页面数据生成，`/v/<id>/export.xlsx`；页面工具栏出现"导出 Excel" |
| `print` | 打印 / 存 PDF | 平台注入打印样式和"打印"按钮 |

功能入口统一放在平台的外层工具栏里，不要求模板 HTML 自己实现。

### CLI

```bash
dview template list [--json]
dview template match "给 ACME 出 10 月账单" [--json]
dview template show <name> [--json]           # 字段、示例数据、guide
dview template push <dir>                     # 新建或发布新版本
dview template pull <name> [<dir>]            # 下载到本地修改
dview render <name> --data data.json [--json] # 校验 → 渲染 → 上传，支持 --id 更新
dview upload <file> --template prd-review     # 自由排版的模板
```

### skill 流程

基础 skill 只增加一段：

1. 生成页面前执行 `dview template match "<用户需求>" --json`
2. 命中一个就用它；命中多个就问用户；没有命中就按现在的方式生成
3. 命中后执行 `dview template show <name>`，按返回的 guide 和字段操作

模板专属的说明都放在各模板的 `guide.md` 里，不写进基础 skill。

### 模板管理页 `/admin/templates`

- 列表：名称、触发关键词、启用的功能、版本、生成过的页面数、最近使用时间
- 顶部"测试触发"输入框，输入一句话，显示命中的模板和命中的关键词
- 关键词冲突提示：同一个关键词出现在多个模板里
- 详情：用 `example.json` 渲染的实时预览、字段说明、功能列表、版本历史（每个版本都能预览）、用这个模板生成过的页面
- 关键词可以直接在页面上编辑，保存后生成模板的新版本
- 资源列表增加"按模板筛选"

## 验收

- [ ] 同一份数据渲染两次，HTML 完全一致
- [ ] 缺少必填字段时，`dview render` 报错并列出字段，不上传
- [ ] `match` 返回的结果和管理页测试触发一致
- [ ] 改模板关键词或排版后，已生成的页面不变
- [ ] 账单导出的 Excel 数字和页面显示一致
- [ ] 没有命中模板时，上传行为和现在完全一样
- [ ] 基础 skill 增加的内容不超过 20 行

## 待定问题

1. 模板是否要支持账户之间共享（比如管理员发布全局模板）？
2. 关键词之外，是否允许按 `project`（git 仓库名）自动匹配模板？
3. 数据里出现 HTML 时一律转义，是否有模板需要放行富文本？

## 变更记录

（确认后填写）
