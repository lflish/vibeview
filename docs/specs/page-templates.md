# 页面模板

状态：已实现，随 v1.4.0 发布（本轮：模板核心 + 导出 Excel + 打印；模板管理页下一轮）。日期：2026-10-22。依赖：[resource-versions.md](./resource-versions.md)。

## 目标与范围

两个场景：

1. **固定格式的页面**（如给某个供应商出账单）：每次都让 AI 从头生成 HTML，排版和细节会变。希望调好模板后，同样的数据每次生成的结果完全一样。
2. **不同类型的页面需要不同功能**：账单要导出 Excel 和打印，需求评审要评论和签字，普通页面什么都不需要。

模板 = 页面类型。它定义排版（可选）、数据结构、平台功能和给 agent 的说明。agent 通过 skill 查到匹配的模板后，按模板生成页面；没有匹配的模板时，保持现在的普通上传。

这样做的好处：

- 账单类页面只需要 agent 输出数据，结果固定
- 导出、打印等功能由平台提供，agent 不用每次写这些代码
- 模板相关的说明只在命中模板时加载，基础 skill 保持很短，节约 token

本轮做：模板存储与版本、账户模板和全局模板、关键词匹配、数据校验与渲染、`print`、`export.xlsx`、CLI、skill 流程。

本轮不做：模板管理页（下一轮）、`comments` / `signoff`（见 [review-comments.md](./review-comments.md)）、按项目匹配模板、数据里的富文本、服务端 PDF、可视化编辑模板。

## 已确定的决定

| 问题 | 决定 |
| --- | --- |
| 谁能用哪些模板 | 每个账户有自己的模板；管理员可以把模板设为**全局**，所有账户都能匹配和使用。按名称查找时先找自己的，再找全局的 |
| 数据里的 HTML | **一律当纯文本**。平台只把数据以 JSON 嵌入页面，不会把数据当 HTML 插入；模板脚本用 `textContent` 显示数据 |
| 匹配方式 | 只按关键词；不按项目 |
| 谁来渲染 | 统一由服务端渲染，CLI 只调接口，保证同一份数据在任何机器上结果一致 |

## 设计

### 模板目录

```
vendor-bill/
├── template.json   # 必需
├── layout.html     # 固定排版时需要：自包含的单个 HTML（CSS、脚本内联）
├── schema.json     # 有排版时必需：数据结构
├── example.json    # 有排版时必需：示例数据，用于校验模板、预览和给 agent 参考
└── guide.md        # 给 agent 的说明，可选
```

模板包只能包含 `template.json` 和它引用的这几个文本文件，多余的文件会被拒绝。单个文件最大 2 MB，合计最大 5 MB。仓库里的 `examples/templates/vendor-bill/` 是一个完整的示例。

`template.json`：

```json
{
  "name": "vendor-bill",
  "title": "供应商月度账单",
  "description": "给供应商出的月度对账单，含明细、合计和税额",
  "match": ["账单", "对账单", "invoice", "bill"],
  "category": "report",
  "tags": ["bill"],
  "layout": "layout.html",
  "schema": "schema.json",
  "example": "example.json",
  "guide": "guide.md",
  "pageTitle": "{vendor} {period} 账单",
  "features": {
    "print": true,
    "export": {
      "xlsx": {
        "sheet": "明细",
        "rows": "items",
        "columns": [
          { "field": "name", "header": "项目" },
          { "field": "qty", "header": "数量" },
          { "field": "price", "header": "单价" },
          { "header": "金额", "product": ["qty", "price"], "total": true }
        ]
      }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 小写字母、数字和 `-`，最长 63 个字符，同一账户内唯一 |
| `title` / `description` | 显示名和用途说明；`description` 必填，agent 和匹配结果里会显示 |
| `match` | 1–30 个触发关键词 |
| `category` / `tags` | 用模板生成的页面默认使用的分类和标签 |
| `layout` | 排版文件；`null` 表示自由排版（agent 自己生成 HTML，上传时带 `--template`） |
| `pageTitle` | 生成页面的标题和资源简介，`{字段路径}` 替换为数据里的值（纯文本） |
| `features` | 平台功能，本轮支持 `print`、`export.xlsx`；未知的功能名会被拒绝 |

`export.xlsx.columns` 的每一列是 `field`（数据字段路径）或 `product`（几个字段相乘，如金额 = 数量 × 单价）；`total: true` 在末尾加一行合计。

### 存储与版本

```
data/templates/<模板 id>/meta.json        # 名称、所属账户、是否全局、版本列表
data/templates/<模板 id>/v<n>/<文件>
```

- 每次 `push` 生成新版本，保留最近 50 个版本；每个账户最多 100 个模板
- 设为全局时，全局模板之间名称不能重复
- 删除模板不影响已生成的页面：页面是自包含的 HTML，数据和功能配置存在页面自己的元数据里

### 渲染

- 服务端读取模板当前版本，按 `schema.json` 校验数据（JSON Schema 子集：`type`、`properties`、`required`、`items`、`enum`、`minItems`/`maxItems`、`minimum`/`maximum`、`minLength`/`maxLength`）。不通过时返回所有错误，例如 `items[2].price: 应为 number`，不生成页面
- 数据以 `<script type="application/json" id="dview-data">` 嵌入 `<head>` 开头，并提供 `window.DVIEW_DATA`。嵌入时转义 `<`、`>`、`&` 和 U+2028/2029，数据无法闭合脚本标签
- 模板脚本负责显示和计算（合计、税额），数据里只放原始值
- `pageTitle` 替换页面 `<title>`，同时作为资源简介
- 渲染结果不含时间戳等变化的内容：同一模板版本 + 同一份数据，输出逐字节相同
- 数据另存一份在版本目录的 `.dview-data.json`，供导出接口使用
- 生成的资源是普通的 HTML 资源，同样支持访问码、版本更新和 `.dview.json`；元数据记录 `template`（id、名称、版本）和 `features`，每个版本也各记一份

### 平台功能

功能需要的按钮和脚本在渲染时注入页面，打印时自动隐藏。

| 功能 | 页面上 | 沙箱权限 |
| --- | --- | --- |
| `print` | 右上角"打印"按钮，调用浏览器打印（可存为 PDF） | `allow-modals` |
| `export.xlsx` | "导出 Excel"按钮，在浏览器里用页面数据生成 `.xlsx` 并下载 | `allow-downloads` |

**导出 Excel**：原计划由服务端生成，页面链接到 `/v/<id>/export.xlsx`。但页面运行在沙箱里（来源是不透明的），从页面发起的请求带不上访问码 cookie，受保护页面的下载会失败。所以改为在页面里直接生成：平台内置一个很小的 xlsx 生成器（不依赖第三方库），用页面嵌入的数据生成文件。服务端用同一份代码提供导出接口，供 agent 和脚本使用，结果和页面导出的一致。

导出接口：`GET /api/me/items/:id/export.xlsx`（token）、`GET /admin/api/item/:id/export.xlsx`（管理员），可选 `?version=n`。

只有开启了相应功能的页面才放宽沙箱权限，其他页面不变。

### 接口

账户（Bearer token）：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/templates` | 可用的模板（自己的和全局的） |
| `GET /api/templates/match?q=<用户原话>` | 关键词匹配 |
| `GET /api/templates/:name` | 模板详情：字段说明、示例数据、guide |
| `GET /api/templates/:name/files` | 当前版本的全部文件（`pull` 用） |
| `PUT /api/templates/:name` | 新建或发布新版本，JSON `{ files: {文件名: 内容}, message, global }` |
| `DELETE /api/templates/:name` | 删除自己的模板 |
| `POST /api/templates/:name/render` | 渲染并上传，JSON `{ data, id, message, dry_run, access_mode, access_days, 分类字段, git_commit, git_dirty }` |

`global: true` 只有在 `config.yaml` 里设置了 `global_templates: true` 的账户可以使用。管理员接口：`GET /admin/api/templates`、`PATCH /admin/api/templates/:id`（`{ "global": true }`）。

**匹配规则**：用户原话和关键词都做 NFKC 规范化和小写，按子串匹配。结果按命中关键词数量、命中关键词总长度排序，同分时自己的模板在前。返回每个模板命中了哪些关键词。

### CLI

```bash
dview template list [--json]
dview template match "给 ACME 出 10 月账单" [--json]
dview template show <name> [--json]           # 字段、示例数据、guide
dview template push <dir> [-m 说明] [--global]
dview template pull <name> [<dir>]            # 下载到本地修改
dview template delete <name>
dview render <name> --data data.json [--json] [-m 说明] [--id ID | --new] [--out page.html]
dview upload <file> --template <name>         # 自由排版的模板
```

- `render` 在 git 仓库里同样使用 `.dview.json`，映射的键是**数据文件**的路径：同一份数据文件再次渲染会更新原链接
- `--out` 只渲染并保存到本地文件，不上传

### skill 流程

基础 skill 只增加一段：

1. 生成页面前执行 `dview template match "<用户需求>" --json`
2. 命中一个就用它；命中多个就问用户；没有命中就按现在的方式生成
3. 命中后执行 `dview template show <name>`，按返回的字段和 guide 整理数据，用 `dview render` 生成

模板专属的说明都放在各模板的 `guide.md` 里，不写进基础 skill。

### 模板管理页（下一轮）

- 列表：名称、触发关键词、启用的功能、版本、生成过的页面数、最近使用时间
- 顶部"测试触发"输入框，和 `match` 接口结果一致
- 关键词冲突提示、详情预览（用 `example.json` 渲染）、版本历史、设为全局、编辑关键词
- 资源列表增加"按模板筛选"

## 验收

- [x] 同一份数据渲染两次，HTML 逐字节相同
- [x] 缺少必填字段或类型错误时，`dview render` 报错并列出字段，不上传
- [x] 数据里的 `</script>`、HTML 标签只作为文本出现
- [x] 改模板后，已生成的页面不变；删除模板后，已生成的页面仍可打开和导出
- [x] 账单导出的 Excel 数字和页面一致；受保护页面也能导出（浏览器导出与接口导出逐字节相同）。文件用 openpyxl 读取验证；**还没有在 Excel / WPS 里实际打开过**
- [x] 打印时工具栏隐藏
- [x] 没有命中模板时，上传行为和现在完全一样
- [x] 全局模板对其他账户可见可用；没有权限的账户不能发布全局模板
- [x] 基础 skill 增加的内容不超过 20 行（16 行）

## 实现说明

- 代码：`lib/templates.js`（存储、模板包校验、匹配）、`lib/template-schema.js`（数据校验）、`lib/template-render.js`（渲染与工具栏）、`lib/xlsx.js`（服务端和页面共用的 xlsx 生成器）、`lib/locks.js`
- 上传和渲染共用同一套"新建资源 / 生成新版本"的代码（`server.js` 的 `saveResource`）
- 示例模板：`examples/templates/vendor-bill/`
- 窄屏时工具栏放在右下角，避免挡住页面标题

## 验证记录

- `node scripts/test-templates.js`：直出和 sidecar 代理两种模式，覆盖模板包校验（9 种不合格的包）、可见范围与全局模板、同名遮盖、匹配、数据校验、确定性渲染、转义、沙箱权限、版本更新、导出接口、删除模板、自由排版模板、管理员接口，以及 CLI 全部子命令。
- `node scripts/test-templates.js --browser`：受保护页面的渲染、恶意备注只显示为文本、页面导出 Excel 与接口导出逐字节相同、打印按钮、打印样式隐藏工具栏、390px 宽度无横向滚动。
- 示例账单在 1280px 和 390px 宽度下截图检查。

## 变更记录

- 2026-10-22：确认归属（账户 + 全局）、数据一律转义、只按关键词匹配；渲染统一由服务端完成；导出 Excel 改为页面内生成（原因见"导出 Excel"）；本轮范围为核心 + 导出 + 打印。
