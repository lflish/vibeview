---
name: release
description: 给 vibeview 出一个新版本：检查、确定版本号、写中英双语发布说明、打 tag、生成发布包并创建 GitHub Release。只和 git / GitHub 打交道，不登录服务器、不部署；部署用 deploy-view。用户要求发版本、打 tag、创建 Release 时使用。
---

# 发布 vibeview 版本

从项目根目录执行。这个 skill 不需要任何服务器信息，也不部署；结束时提示用户可以用 `$deploy-view` 部署新版本。

## 版本号

按上个 tag 以来的改动确定，拿不准时问用户：

| 改动 | 升级 |
| --- | --- |
| 只有修复、文档、内部整理 | 第三位（1.2.0 → 1.2.1） |
| 新功能、新配置项，兼容已有部署 | 第二位（1.2.0 → 1.3.0） |
| 需要手动迁移数据或配置、删除功能 | 第一位（1.2.0 → 2.0.0） |

## 流程

1. **准备**：`bash .agents/skills/release/scripts/prepare.sh <X.Y.Z>`。它检查：在 main 分支上、工作区干净、和 origin 同步、tag 没用过、新版本大于当前版本、`gh` 已登录、敏感信息扫描通过；然后改 `package.json` 和锁文件的版本，并在本地提交 `chore(release): vX.Y.Z`，最后打印上个 tag 以来的提交作为发布说明素材。任何一项失败就停下，告诉用户原因。
2. **写发布说明**：写到仓库外的临时文件（如 scratchpad），格式沿用已有 Release（`gh release view <上个 tag>` 查看）：中文在前、英文在后，分「需求说明 / 安全修复 / 新功能 / 改进 / 升级 / 验证」等小节，没有的小节省略。
   - 写给使用者看：说明改了什么、有什么影响，不要照抄提交信息。
   - **需求说明**：本版新增或改动过 `docs/specs/` 里的 spec 时（`prepare.sh` 会列出），在「新功能」前加「### 需求说明」一节（英文部分为「### Specifications」），每个 spec 一行：名称、状态（已实现 / 部分实现 / 只有需求说明）、一句话说明，链接写成 `https://github.com/<仓库>/blob/vX.Y.Z/docs/specs/<文件>`，固定在本版 tag 上，以后 spec 再改也能看到发版时的内容。实现时和 spec 不一样的地方（spec 的「变更记录」）在这里简要说明。`publish.sh` 会检查这一节和每个链接。
   - 「升级」写清需要手动做的事：新配置项、数据格式变化、需要重建 sidecar 等。
   - 「验证」写实际跑过的测试和 CI 结果，不写没做的验证。部署状态不写进 Release（Release 与部署无关）。
   - 不写真实主机、IP、用户名、目录或内部域名。
3. **推送并等 CI**：`git push origin main`，然后 `gh run watch`（或后台等待）直到这个提交的 CI 结束。CI 失败时修复后重新从第 1 步开始，不要强行发布。
4. **发布**：`bash .agents/skills/release/scripts/publish.sh <X.Y.Z> <说明文件>`。它再次确认提交已推送、CI 成功、代码和说明都通过敏感信息扫描、说明里没有占位符；然后打 annotated tag（说明由 `tag-message.sh` 生成：发布说明第一段的摘要、本版的需求说明清单和 Release 链接，所以发布说明的第一段要能单独概括这个版本；可以先运行 `tag-message.sh <X.Y.Z> <说明文件>` 预览），用 `scripts/package-release.sh` 生成运行时发布包 `vibeview-vX.Y.Z.tar.gz` 和 `.sha256`，推送 tag，并用 `gh release create` 创建 Release、上传这两个附件。
5. **报告**：Release 链接、版本号、对应提交、发布包 SHA-256，以及「可以用 `$deploy-view` 部署 vX.Y.Z」。

## 发布包

`scripts/package-release.sh <ref>` 只打包 `scripts/runtime-files.txt` 里的运行时文件，不含配置、数据和秘密。打包是确定性的：同一个 tag 在任何机器上打出来的包 SHA-256 相同，所以 deploy-view 可以下载 Release 附件，或在本地重新打包后比对哈希。

## 出错时

- 推送 tag 之前出错：删掉本地 tag（`git tag -d vX.Y.Z`），修复后重来。版本提交还没推送时可以 `git reset --hard HEAD^` 撤掉，**先确认工作区没有别的改动**。
- tag 已经推送：**不要改动、删除或重打这个 tag**，别人可能已经拉取。问题修复后发一个新的修订版本（如 v1.2.1）。Release 说明写错了可以用 `gh release edit` 修改。
- 不要用 `--force` 推送 main 或 tag。
