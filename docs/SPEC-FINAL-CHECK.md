# SPEC 终检门禁（Final Gate）

> 日期：2026-10-08（Asia/Shanghai）  
> 范围：`docs/SPEC.md`（主）、`docs/REQUIREMENTS-REVIEW.md`、`docs/design-render-sidecar.md`（略读）  
> 目的：判定是否可开工 **P0-10 全链路冒烟**（本文件只做门禁，**不实现** smoke）

---

## 裁决

**GO** — 无阻塞缺陷；可以按 SPEC §8 序 B 开始实现 P0-10。

---

## 1. 阻塞缺陷（开工前必须改 SPEC / 代码契约）

**无。**

对照检查后确认：

- 产品范围、非目标、账户=named token、sidecar 威胁模型口径一致，且与评审文档同向。  
- P0-10 验收清单（§7.1）与最低可合入子集可执行；错误码（`401`/`403`/`429`/`400`、代理 `502`）与当前实现路径匹配。  
- 实现顺序已纠正为「先冒烟再拆 PR」，不再要求先做未定 P1。  
- §9.1 默认已足够锁排期；不再存在「不答就不能写 smoke」的硬歧义。

---

## 2. 非阻塞缺口 / 笔误

| # | 项 | 说明 | 处理 |
| --- | --- | --- | --- |
| N1 | 主服务固定读根目录 `config.yaml` | 无 `DVIEW_CONFIG`；冒烟需临时配置 + 独立 data + trap/隔离目录 | 已在 SPEC §7.2 补一句；实现 smoke 时遵守即可 |
| N2 | P1-6 标签曾不一致 | §3.4「延期」vs §4「本阶段不做」 | **已在 SPEC 对齐为「本阶段不做」** |
| N3 | `design-render-sidecar.md` 文内仍有「待确认 / 待新增 / §15 开放问题」残留 | 文首已写「已确认并实现」；属设计稿历史层，不堵 P0-10 | 合入 sidecar PR 时再清一次文案即可 |
| N4 | `REQUIREMENTS-REVIEW.md` 仍写「SPEC §8 已过时」 | 评审当时正确；SPEC 已改，评审文可作历史意见保留 | 不必改评审原文；以现行 SPEC 为准 |
| N5 | 冒烟全量 #11（管理端 UI 点击路径）偏重 | 最低子集已排除；可用 curl 登录 session 覆盖 disable/list/401 | smoke 优先最低子集，UI 手测可选 |
| N6 | 本环境无 Docker | 序 D / sidecar 实机 502 不能在此箱验证 | PR 标明即可；不堵 host 冒烟 |
| N7 | `checkQuota` 内禁用分支写 `403` | 实际上传/`/api/me` 经 `findActiveByToken` → **401**，与 SPEC 一致；403 基本不可达 | 日后清理死代码，不改契约 |

---

## 3. Go / No-go

| 问题 | 结论 |
| --- | --- |
| 现在开始实现 P0-10？ | **GO** |
| 是否先再扩 P1-2/P1-5？ | **否**（SPEC 已延期 / 本阶段不做） |
| 是否先巨型单 PR 合入未测功能？ | **否**（先冒烟门禁） |

---

## 4. 若 Go：P0-10 精确第一步（供父代理执行）

1. **落脚本骨架**：新增 `scripts/smoke.sh`；`package.json` 增加 `"test": "bash scripts/smoke.sh"`（保留现有 `smoke:render` 不动）。  
2. **隔离环境**：在临时目录（推荐 `mktemp -d`）写入 `config.yaml`（两账户 token、`max_files`/`max_storage_mb` 便于测配额、独立 `html/image/video/meta` 路径、随机高端口、`preview.proxy_to_render: false`）；用 `trap` 杀进程并删临时目录；**勿污染**开发者已有 `./data`。若采用「写回仓库根 `config.yaml`」策略，必须备份 + `trap` 还原。  
3. **起服**：`node server.js`（或 `npm start`）后台启动，轮询 `GET /healthz` 与 `GET /` 至 200。  
4. **按 SPEC §7.1 最低可合入子集断言**（curl）：  
   - 上传 HTML → 200，`url`/`id`/`source`；`GET /v/:id` 正文匹配  
   - 错误类型（如 `.txt`）→ `400`  
   - `max_files: 1` 第二次 → `429`  
   - 账户 A 删 B 的 id → `403`；`GET /api/me/items` 仅己方  
   - admin 登录 cookie 后 `POST .../disable` → 该 token 上传与 `/api/me` → `401`；enable 恢复  
   - `dview upload`（`DVIEW_URL`/`DVIEW_TOKEN`）stdout 为 URL  
   - 未登录 `GET /admin/api/list` → `401` JSON（非登录 HTML）  
5. **（同 PR 内尽快）** 补：超大文件 `400 file too large`、存储配额 `429` 且无孤儿目录、图片最小 fixture 预览可开。  
6. **退出码**：任一步失败非 0；成功打印简短 OK；不在本步做 commit / 不开 Docker 实机（序 D 另轨）。

---

## 5. 与三份文档的一致性摘要

- **SPEC**：范围克制、sidecar ≠ XSS、下一刀 = P0-10 — **可执行**。  
- **REQUIREMENTS-REVIEW**：指出的「先测再合入、砍 P1-5/npm/多管理员」已写入现行 SPEC — **已吸收**。  
- **design-render-sidecar**：架构与已实现文件对齐；文内开放问题表过时 — **不堵冒烟**。

---

*本终检只新增本文并允许对 SPEC 做笔误级修订；不实现 smoke、不 commit。*

---

## 终审续评 2026-10-08（P0-10 落地后）

> 时间：2026-10-08 17:56 CST（Asia/Shanghai）  
> 范围：`docs/SPEC.md` 全文对照工作区实现、`scripts/smoke.sh`、`lib/*`、`server.js` / `render-server.js`、既有终检与 REQUIREMENTS-REVIEW、design-render-sidecar（略读）  
> 目的：P0-10 已实现并通过后，判定是否可**继续下一阶段实现/交付**（本文件只做门禁，不实现业务、不 commit）  
> 方法：深度缺陷/遗漏终审（需求矛盾、边界、安全、SPEC↔代码漂移、P0/P1 优先级）；不声称具体模型型号

### 裁决

**GO** — 阻塞缺陷 **0**。可按 SPEC §8 **序 C** 整理提交并拆 PR 合入；不必再堆 P1-2/P1-5 等延期项。

本轮相对「开 P0-10」的门禁已关闭：`npm test` → **45 OK / 0 FAIL**（含内嵌 `smoke:render`）。下一刀是**交付切片**，不是再扩功能面。

---

### 1. 阻塞缺陷（开工/合入前必须改契约）

**无。**

复核结论：

| 维度 | 结论 |
| --- | --- |
| 需求矛盾 | 非目标、账户=named token、sidecar≠XSS、预览公开、单 admin —— 与 README / 实现同向 |
| 验收可测性 | §7.1 除 #11 外均可自动化；冒烟已覆盖 1–10、12、13 + smoke:render |
| 安全契约 | Bearer 停用→401、跨账户 DELETE→403、配额→429、管理 API 未登录→401 JSON、proxy 失败→502 不回退 —— 与代码路径一致 |
| 优先级 | P0 闭环 + P0-10 门禁完成后进序 C；P1-2..6 / 多数 P2 仍合理延期或本阶段不做 |

---

### 2. 非阻塞遗漏 / 已知缺口

| # | 项 | 说明 | 处理 |
| --- | --- | --- | --- |
| N1′ | **SPEC 状态漂移（已修文字）** | P0-10 仍标「待做」；§7.2 仍写「无 DVIEW_CONFIG」；§8 快照「P0-10 未做」 | **已在本轮修订 `docs/SPEC.md`**：P0-10=`[已实现]`；记录 `DVIEW_CONFIG_PATH`；序 B 完成、下一刀=序 C |
| N5′ | **§7.1 #11 管理端 UI 浏览器点选** | 登录提示、复制链接、删除确认、账户页启停的 DOM 路径未自动化 | **已知延期**；冒烟用 curl session 覆盖 disable/list/401；UI 合入后手测即可 |
| N8 | **假 mp4 fixture** | `smoke.sh` 写 `fake-mp4-bytes`，只断言预览壳含 `<video>`，不验证浏览器可播 | **可接受**；真播放属浏览器手测 / 日后真实最小 mp4 fixture（非阻塞） |
| N3′ | **design-render-sidecar 历史层** | 文内仍有「待确认 / 待新增 / §15 开放问题」表，与文首「已确认并实现」并存 | sidecar PR（PR-C）时清文案；**不堵**序 C |
| N4′ | **REQUIREMENTS-REVIEW 历史意见** | 仍写「P0-10 未做 / SPEC §8 过时」 | 保留作评审快照；以现行 SPEC + 本续评为准 |
| N6′ | **本环境无 Docker** | `docker` 未安装；序 D 实机 502/compose 无法在此箱验 | PR 标明「compose 未实机验证」；`smoke:render` 已覆盖本地 render + 代理 502 |
| N7′ | **`checkQuota` 禁用分支 `403`** | `findActiveByToken` 先挡 → 上传/`/api/me` 实际 **401**；403 基本不可达 | 日后删死代码；**不改对外契约** |
| N9 | **同站 admin + 公开 HTML** | sidecar 不防访客 XSS / 同站打管理会话（R2/R3） | 已写入 §5.0 / README；中长期 P2-1；**不堵**合入 |
| N10 | **双预览路径** | `proxy_to_render` false/true 依赖共用 `lib/preview-*` | 已共用；冒烟默认 false；true+实机属序 D |
| N11 | **未提交大 diff** | P0-6..10、P1-1、P2-8 等仍在工作区 | **序 C 必须拆 PR / 多 commit**；禁止无说明巨型单 commit |

---

### 3. Go / No-go（续评）

| 问题 | 结论 |
| --- | --- |
| 现在继续「实现」？ | **GO** → 下一刀是 **序 C（拆 PR 合入）**，不是再开新 P1 功能 |
| 是否再补功能再合入？ | **否**（P1-2/P1-5 等仍延期 / 本阶段不做） |
| 是否可宣称 sidecar 生产已实机验证？ | **否**（无 Docker；须序 D 或 PR 标明） |
| P0-10 门禁是否满足开 PR 最低条？ | **是**（最低子集 + 超大/存储配额/图视频壳/cleanup/CLI/401 JSON 均已覆盖） |

---

### 4. 建议的下一批实现项（1–3，按优先级）

> 对应 SPEC §8；**阻塞项为 0**，下列为续评推荐下一列车：

1. **序 C — 整理提交并拆 PR 合入**（§8 序 C、§8 建议 PR-A/B/C/D）  
   - PR-A：账户 + 管理端 UX + README 账户段（P0-6/7/9）  
   - PR-B：生态 CLI / install / AGENTS / integrations / Action（P0-8）  
   - PR-C：渲染 sidecar + healthz + design 文档（P1-1、P2-8）；顺手清 design 文内「待新增」残留  
   - PR-D：全链路 smoke（P0-10）— 可紧跟 A 或与 A 同列车多 commit  
   - 带宽低允许**单 PR 多 commit**，边界同上。

2. **序 D — Docker 实机验证 sidecar**（§7.4、§8 序 D；有 Docker 的环境）  
   - compose up → host 上传 → 经 host `/v` 200 → stop render → **502**；确认 `:ro`、无 config、ports 仅 `127.0.0.1`。  
   - 无 Docker 则 PR 标明，不堵 host 合入。

3. **（可选·不插队）** 合入后按痛点：P1-2 sandbox opt-in；或手测补齐 §7.1 #11；真 mp4 fixture 增强冒烟 —— **均非本列车阻塞**。

---

### 5. 与代码/冒烟对照摘要

| 项 | 状态 |
| --- | --- |
| `scripts/smoke.sh` + `npm test` | 已落地；隔离 `DVIEW_CONFIG_PATH` + 临时 data；45/0 |
| §7.1 #1–10、12、13 | 已覆盖（#11 UI 点选除外） |
| `lib/config.js` `DVIEW_CONFIG_PATH` | 已实现（相对配置目录解析 data） |
| P1-1 sidecar / P2-8 healthz | 已实现未提交；本地 smoke:render 含 502 |
| 安全叙事 README §可信内容 / sidecar≠XSS | 与 SPEC §5.0 同口径 |

---

### 6. 本轮对文档的修改说明

| 文件 | 动作 |
| --- | --- |
| `docs/SPEC-FINAL-CHECK.md` | **追加**本节「终审续评 2026-10-08」 |
| `docs/SPEC.md` | **仅事实漂移修订**：状态头、P0-10=`[已实现]`、§7.2 `DVIEW_CONFIG_PATH`、§8 序/快照、§9.1 Q9、文末下一刀=序 C |
| 业务代码 / commit | **未改、未提交** |

---

*续评结论：GO（序 C）。阻塞 0。非阻塞含 #11 UI、假 mp4、design 文案、无 Docker 实机、未拆 PR。*
