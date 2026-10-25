# 模板配套 skill

状态：已实现，随 v1.4.2 发布。日期：2026-10-25。依赖：[page-templates.md](./page-templates.md)。

## 目标与范围

现在 agent 要用模板，得先靠基础 skill 记得执行 `dview template match`，再 `show` 才能读到模板说明，多绕两步，也依赖关键词子串匹配。

给每个模板生成一个配套 skill：agent 听到"出账单"就直接想到对应的模板（按语义触发，不限于关键词），并且一打开 skill 就能看到完整的步骤、字段和示例。

本版做：CLI 根据服务端的模板生成、更新、删除本机的 skill；发布模板后自动同步本机；`install-skill.sh` 安装后自动同步一次；基础 skill 说明两者的关系。

本版不做：模板里附带可执行脚本、服务端存储 skill、管理页里的 skill 预览。

## 设计

### 原则

- **模板是唯一的来源**：skill 由 CLI 根据模板生成，不手写、不手改。模板更新后重新同步，不会出现两份说明对不上。
- **`template match` 保留**：不支持 skill 的 agent、没有同步过的机器，以及管理页的"测试触发"，仍然用关键词匹配。

### 命令

```bash
dview template skills sync                  # 同步自己的模板
dview template skills sync --global         # 同时同步全局模板
dview template skills sync --only vendor-bill
dview template skills sync --dir <目录>      # 写到其他 agent 的 skill 目录
```

- 默认目录：`$CLAUDE_SKILLS_DIR`，没有设置时为 `~/.claude/skills`（与 `install-skill.sh` 一致）
- 输出每个 skill 的结果：新增 / 更新 / 不变 / 删除
- `dview template push` 成功后，如果默认目录存在，自动同步刚发布的模板；`dview template delete` 后删除对应的 skill。`--no-skill` 跳过
- `install-skill.sh` 安装完成后，如果 CLI 和 `DVIEW_*` 都可用，运行一次 `sync`（失败不影响安装）

### 生成的 skill

目录 `dview-tpl-<模板名>/`（名称超过 64 个字符时截断），包含 `SKILL.md` 和标记文件 `.dview-template.json`：

```json
{ "server": "https://view.example.com", "id": "<模板 id>", "name": "vendor-bill", "version": 3, "global": false, "owner": "me", "generator": 1 }
```

`SKILL.md` 的结构：

- frontmatter：`name`；`description` = 模板的 `title` 和 `description`，加上"用户提到 <关键词> 时使用"，最长 1024 个字符
- 一行提示：由 `dview template skills sync` 根据模板第几版生成，不要手改
- 步骤：先 `dview template show <name>` 确认字段是最新的 → 整理数据写成 JSON（放在仓库里固定的位置）→ `dview render` → 告诉用户链接、访问码和到期时间。自由排版的模板改为自己生成 HTML 并 `upload --template`
- 模板说明：`guide.md` 原文，注明来自哪个账户
- 字段表、示例数据

### 同步规则

- 只处理带标记文件的目录，**不碰用户自己的 skill**
- 标记的 `server` 和当前 `DVIEW_URL` 不同的，不更新也不删除（同一台机器可能连多个服务）
- 模板版本或生成器版本变了才重写，否则显示"不变"
- 当前服务上已经看不到的模板（被删除、取消全局），删除对应的 skill；用了 `--only` 时只处理指定的模板，不做删除

### 安全

- 默认只同步**自己的**模板。全局模板由别的账户发布，它的说明会成为 agent 的指令，所以需要明确加 `--global` 或 `--only`
- 生成的内容只有文本，不带可执行脚本
- 写文件前校验模板名，只写进 `dview-tpl-*` 目录

### 基础 skill

增加一句：可能已经安装了 `dview-tpl-*` 模板 skill，触发时按它操作；没有触发时仍先 `template match`。

## 验收

- [x] `sync` 为自己的模板生成 skill，frontmatter 合法，内容包含步骤、模板说明、字段和示例
- [x] 全局模板默认不同步，加 `--global` 才同步
- [x] 模板发布新版本后，`sync` 显示"更新"；没有变化时显示"不变"
- [x] 模板删除后，`sync` 删除对应的 skill；用户自己的 skill 和其他服务的 skill 不受影响
- [x] `template push` / `delete` 自动同步本机
- [x] 自由排版的模板生成的步骤是 `upload --template`

## 实现说明

- 生成逻辑在 `bin/dview` 里，用 node 执行（skill 只给 Claude Code 这类 agent 用，装了它的机器都有 node）
- 同步过一次的全局模板，之后不加 `--global` 也会继续更新，不会被当成"不再可用"删掉
- 新增示例模板 `examples/templates/aibot-compare/`（AI Bot 多角度对比，推特配图尺寸），测试会发布并渲染 `examples/templates/` 下的所有示例

## 验证记录

- `node scripts/test-templates.js`：自动同步、内容与标记文件、"不变 / 更新 / 删除"、用户自己的 skill 和其他服务的 skill 不受影响、全局模板需要 `--global` 且之后保持同步、`--only` 找不到时提示、删除模板后移除 skill。

## 变更记录

- 2026-10-25：同步过的全局模板之后保持同步（原设计中不加 `--global` 会被删除，用起来不自然）。
