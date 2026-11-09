# 机器关口 B：方案验证结论（2026-11-09，第 1 轮）

- 结论：通过，有备注
- 验证者：same（全新子 agent，只读）；codex 探测返回 403 NOT_ENOUGH_MEMBER_BUDGET；claude 与写方案的是同一工具，跳过
- 对应提交：b21d7ea（设计和任务）

## 对照

| 场景 | 设计 | 任务 / 测试 |
|---|---|---|
| R1.1 | 4.1 只看当前版本；第 5 节字段 | T1 update_live_version_counts_once；T3 R1.1 |
| R1.2 | 4.1；V3（站点体积 = 解压大小，server.js:424） | T3 R1.2 |
| R1.3 | V3：渲染 → saveResource（server.js:656）→ updateResource → writeMeta | T3（test-templates.js 第 207 行登录后断言） |
| R1.4 | 第 6 节第 2 步；被拒请求不调用 writeMeta（server.js:330-334） | T3 R1.4（max_storage_mb 小数可用，accounts.js:170） |
| R1.5 | 4.1；第 5 节 (id, n) 去重 | T1 两个测试；T3 R1.5 |
| R1.6 | 4.1 prepareDelete 先补齐；details() 已删除 filename null | T1；T3 R1.6 |
| R1.7 | 第 6 节启动第 2 步 | T1 三个测试 |
| R2.1–R2.4 | 第 6 节第 3 步；4.2 coverage | T1 backfill_*；T3 删索引重启 |
| R3.1–R3.8 | 4.2 / 4.3 + T4 | T4；dev-test 浏览器测试；T2 单元 |
| R4.1 / R4.2 | 4.2 只新增字段；鉴权不改 | T2 / T3；已有 401 断言 |
| R5.1 | 第 5 节；7.1 | T1 隐私循环；T3 serialized（见备注 5） |

## 重跑的前置验证

只读脚本读生产 meta 和 statistics：49 个资源，3 个多版本，版本记录 12 条（含单版本），更新版本 5 条，无效 0；当前版本都是最大号；无遗留意图文件；3 个资源的新建事件体积都等于 v1 大小。V2、V3、V5 逐行核对 server.js:452、459、518、335、484、522、854、886、912 和 lib/versions.js:45-54，都成立。基线 `node scripts/test-statistics.js` 通过。

## 备注（都不拦）

1. 中：当前版本本身无效时，实时路径会尝试生成意图 → 已在 4.1 补“返回 null”，T1 加测试。
2. 低：启动恢复少了“元数据在、版本没提交”的分支，可能留下孤立的 .versions/<n> 目录（v1.4.0 起就有）→ 已在第 6 节补上，T1 加测试。
3. 低：删除前补齐没有判断意图是否已提交 → 已改为同启动恢复的判断。
4. 低：“统计状态缺失”检查要包含 updates → 已写进第 5 节，T1 加测试。
5. 中：R5.1 要求接口返回里找不到文件名，但现有接口和页面会显示仍保留资源的文件名（statistics-store.js:188、statistics.html:315）→ c3，等用户。

## 只能由用户决定

- c2 用户指南“新建 / 更新”的中英文措辞
- c3 R5.1 措辞
