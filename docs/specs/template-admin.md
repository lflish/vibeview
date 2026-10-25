# 模板管理页

状态：已确认。日期：2026-10-25。依赖：[page-templates.md](./page-templates.md)（"模板管理页（下一轮）"一节）、[resource-versions.md](./resource-versions.md)。

## 目标与范围

模板已经能发布、渲染，但管理员在后台看不到有哪些模板、用了多少次，也看不出哪个页面是模板生成的。

本版做：

- 管理端侧边栏增加"模板"页：列表、测试触发、详情（示例预览、字段、说明、版本）、设为全局
- 资源管理：模板生成的页面显示模板标记；可以按模板筛选；可导出的页面在操作菜单里提供"导出 Excel"
- 来源与账户：显示哪些账户可以发布全局模板

本版不做：关键词冲突提示、在后台编辑关键词或模板文件、删除模板（仍用 `dview template delete`）、统计页统计模板使用量。

## 设计

### 接口（都需要管理员登录）

- `GET /admin/api/templates`：在现有字段上增加 `versionCount`、`pages`（当前版本由这个模板生成的资源数）、`lastUsedAt`（这些资源最近一次创建或更新的时间）
- `GET /admin/api/templates/:id`：详情，内容同 `GET /api/templates/:name`（字段、示例数据、说明、版本列表），加上面三个字段
- `GET /admin/api/templates/match?q=<一句话>&account=<账户名>`：用这个账户能看到的模板做匹配，结果和该账户调用 `GET /api/templates/match` 相同
- `GET /admin/api/templates/:id/preview`：用 `example.json` 渲染当前版本，返回 HTML。响应头 `Content-Security-Policy: sandbox allow-scripts`（不允许 same-origin），页面放在带 `sandbox="allow-scripts"` 的 iframe 里，和预览页一样隔离：模板由上传 token 的持有人编写，不能读到管理员的登录状态
- `GET /admin/api/list` 增加 `template=<模板 id>` 筛选；列表项增加 `template`（`{ id, name, version }`）和 `exportable`（当前版本可以导出 Excel）

### 模板页

- 顶部"测试触发"：选择账户，输入一句话，列出命中的模板和命中的关键词；没有命中时说明"会按普通方式生成"
- 列表列：模板（标题、名称）、所属账户和"全局"标记、触发关键词、功能（打印 / Excel / 自由排版）、版本、生成的页面数、最近使用；点击页面数跳到资源管理并按该模板筛选
- 详情（弹窗）：示例预览（iframe）、字段表、说明（纯文本显示，不当 HTML）、版本列表；"设为全局 / 取消全局"按钮，取消前二次确认
- 空状态说明怎么发布模板：`dview template push <目录>`

### 资源管理

- 文件名旁显示模板标记（模板名），点击按该模板筛选
- 筛选栏增加"模板"下拉，选项来自模板列表
- `exportable` 的资源在操作菜单里增加"导出 Excel"，下载 `/admin/api/item/:id/export.xlsx`

### 来源与账户

- 账户行显示"可发布全局模板"标记（`global_templates: true`）

## 验收

- [ ] 模板页列出所有账户的模板，页面数和最近使用与实际资源一致
- [ ] 测试触发的结果和该账户 `dview template match` 一致，自己的同名模板遮住全局模板
- [ ] 示例预览在沙箱里运行：预览页面的脚本读不到管理端的 cookie，也调不了管理接口
- [ ] 设为全局 / 取消全局后，列表和该账户之外的账户可见范围随之变化
- [ ] 资源管理能按模板筛选；模板标记和"导出 Excel"只出现在对应的资源上，导出文件和用户接口导出的一致
- [ ] 浅色、深色主题和手机宽度下布局正常

## 变更记录
