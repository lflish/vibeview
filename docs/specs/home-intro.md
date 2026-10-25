# 首页与 README 介绍新功能

状态：已实现，随 v1.4.3 发布。日期：2026-10-25。依赖：[resource-versions.md](./resource-versions.md)、[page-templates.md](./page-templates.md)、[template-skills.md](./template-skills.md)。

## 目标与范围

v1.4.0 到 v1.4.2 增加了固定链接与版本历史、页面模板、模板配套 skill，但项目首页（`/`）和 README 还停在 v1.3：第一次来的人看不到这些功能。

本版做：

- 首页增加"给 agent 用"一节，介绍版本、模板和模板 skill，配一张模板效果示意
- 首页其他位置补上多页面站点、`/dview` 一句话生成、按项目整理与打开统计
- README 中英文补上同样的内容，和首页口径一致

本版不做：首页改版、截图类素材（示意图用 HTML 画，不引入图片文件）、使用指南的结构调整（指南已经写全）。

## 设计

### 首页

- 页面描述（`<meta name="description">`）补上"agent 生成的页面"和"模板"
- 格式条：增加"多页面站点"；接入方式写成 `CLI · /dview · AI Skill · curl · CI`
- "生成之后"一节的第三张卡片补上按项目、agent、标签筛选和打开统计
- 新增一节 `BUILT FOR AGENTS`，三张卡片：
  1. **需求改十版，链接还是那一个**：同一文件再上传就是新版本，访问码不变；`.dview.json` 记住路径；`/v/<id>/@<n>` 查看历史版本
  2. **模板：版式固定，agent 只填数据**：数据由模板校验和渲染，合计由模板算；打印、导出 Excel 按模板开启；数据一律转义
  3. **一句话触发对应的模板**：`dview template skills sync` 为每个模板生成 skill，说"出 10 月账单"就会用账单模板
- 卡片下面放一张用 HTML 画的模板示意（对比卡片的缩略样子，标明"示例数据"），旁边一句话说明仓库自带账单和 AI Bot 对比两个示例模板
- "开始使用"的代码块增加 `Claude Code` 一栏：`bash install-skill.sh` 和 `/dview <描述>`；第二步的文字提到 `/dview`
- 导航增加"给 agent 用"锚点

### README

- `Why vibeview` 表格增加两格：同一链接持续更新、页面模板
- `Upload and share` 后面增加一小节 `Update a page and use templates`：`-m`、`dview versions`、`dview template match / render`、`dview template skills sync`，链接到使用指南
- 中文 README 同步

## 验收

- [x] 首页能看到版本、模板、模板 skill 三张卡片和模板示意；示意标明示例数据
- [x] 手机宽度（390px）没有横向滚动，键盘可以切换代码栏
- [x] 首页不引入外部资源，脚本只有原来的交互和新增的代码栏
- [x] README 中英文都有版本和模板的介绍，命令和使用指南一致

## 验证记录

- Playwright 打开首页：1280px 和 390px 宽都没有横向滚动、没有脚本错误；`Claude Code` 代码栏显示安装和 `/dview` 命令，左右方向键可以在三个代码栏之间切换。

## 变更记录
