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
| 7 | 设计 | 在 store.writeMeta 已有的统计钩子里按版本号发现更新（方案 A），不在 updateResource 里单独记（方案 B） | 机械 | 原则2、原则3 | 复用现有意图和提交点；所有生成版本的路径都经过 writeMeta（V3） | 方案 B | 中：B 要另做恢复 | — |
| 8 | 设计 | 更新事件存 statistics/updates/<id>.<n>.json，去重键 (id, n)；已有日志不迁移，state.version 不变 | 机械 | 原则2 | 版本号不复用（V2），按 (id, n) 去重即可区分新版本和被删的旧版本 | 改 uploads/ 结构 | 低 | — |
| 9 | 设计 | 接口只新增 created/updated/uploadKind/version/backfilledUpdates/skippedVersions，count/bytes 改为合计 | 机械 | spec R4.1、Q1 A | — | 新开一个接口 | 低 | — |
| c2 | 设计 | 用户指南“管理统计”一节要加“新建 / 更新”的定义和新字段；用户指南在 .devflow.yml human_decisions 的“对外文案”里 | 只有人能做 | human_decisions | 措辞由用户定；T5 阻塞，其余照常 | 自己定措辞 | 低 | 等用户 |
| 10 | 设计 | 工程评审 6 条全部采纳：实时只看当前版本；删除前补齐直接写正式日志、失败中止删除，启动顺序 pending-upload → pending-update → pending-delete；新场景放独立脚本 test-statistics-updates.js；趋势图每天一个可交互元素；修正两个测试写法 | 机械 | 独立评审（错误，有明确改法） | 都有代码行号依据 | — | 低 | — |
| c3 | 设计 | R5.1 改为：统计日志里不含文件名、简介、访问码、token；统计接口不含 token、简介、访问码和访问哈希；仍保留的资源照旧显示文件名，已删除的隐藏 | 只有人能做 | 改用户确认过的需求 | 原措辞要求接口里找不到文件名，和现有行为（statistics-store.js:188、statistics.html:315）矛盾，照字面验收会失败 | 保持原措辞并去掉接口里的文件名 | 低 | 等用户；不影响开发，只影响 R5.1 的验收写法 |
| 11 | 设计 | 方案验证备注 1–4 写进设计，T1 加 3 个测试 | 机械 | 独立验证（低/中，有明确改法） | — | — | 低 | — |
| 12 | 设计 | 关口 B 回复 all：B 放行；c2 同意建议稿；c3 同意改 R5.1 | 机械 | 用户回复 | — | — | — | c2、c3 已处理；T5 解除阻塞 |
| 13 | 开发 | T1 和 T2 一起实现、一起提交 | 机械 | 原则3 | T1 的行为只能通过 T2 的 created/updated 字段观察到，分开写测试要先造临时接口 | 分开两次提交 | 低 | — |
| 14 | 开发 | summary.current 保持原形状（count、bytes、backfilledCount），不加 created/updated | 机械 | design 4.2 | 当前存量不分新建和更新 | — | 低 | — |
| d1 | 开发 | 当日“仍保留”数：接口 retainedCount 含义不变，页面文案由“个”改为“条” | 口味 | 独立评审（取舍）；R4.1 | 不改已有字段含义 | 接口按资源去重 | 低 | 已按此做；用户可改 |
| 15 | 测试 | 浏览器测试按项目惯例写进 scripts/test-statistics-updates.js --browser 并加进 test:browser，不另引入 Playwright Test 和 devflow-browser.js | 机械 | 原则2（跟随项目） | 项目所有浏览器测试都是 scripts/*.js --browser；cloud_browser 禁用，只用本机无头浏览器 | 新建 tests/e2e + Playwright Test | 低 | — |
| c4 | 测试 | 新增 .agents/skills/verify-vibeview（启动隔离实例、体检、操作、日志、证据、清理 + 3 个功能文件），已实际跑通一次 | 只有人能做 | 规则文件（.agents/ 下的 skill） | dev-test 要求生成项目验证 skill；但 .agents/ 下的 skill 属于约束 AI 的规则文件，要用户同意 | 不生成 | 低 | 等用户；不影响本需求的验证 |
| 16 | 测试 | 跑通 verify skill 时发现 start.sh 记录的 PID 是包装子 shell，导致调用方挂起、stop.sh 关不掉 node；改为直接后台启动 node | 机械 | 运行结果 | 修后完整跑通：启动 → 体检 → 1 新建 2 更新 → 重启 → 清理 | — | 低 | — |
| d2 | 测试 | 深色主题下“更新”标签的配色（N3）：推荐现在顺手改为跟随主题变量，需要再派一个验证者复验 | 口味 | 独立验证备注 | 改动 1 行 CSS，用户能看到 | 留到后续 | 低 | 等用户 |
| 17 | 测试 | 关口 C 回复 all：C 放行；c4 同意；d2 现在改 → 返工 T6，复验（规则 4：只是修复，派一个验证者）后直接进入发布，不再单独请用户看 C | 机械 | 用户回复 | 用户已同意进入发布，前提是修好 d2 | 复验后再问一次 | 低 | c4、d2 已处理 |
