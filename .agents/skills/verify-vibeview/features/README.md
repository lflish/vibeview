# 功能清单

所有功能共用：先按 SKILL.md 启动隔离实例并 `source "$DIR/instance.env"`；上传用 `TOKEN_A`（账户 alice），需要“另一个账户”时用 `TOKEN_B`（bob）；网页操作先登录管理端。

| 功能 | 文件 | 已有自动化测试 |
|------|------|----------------|
| 上传、更新和版本 | [upload-versions.md](upload-versions.md) | `npm run test:versions`、`bash scripts/smoke.sh` |
| 预览和访问码 | [preview-access.md](preview-access.md) | `npm run test:access`（`--browser` 走网页） |
| 管理统计（含新建 / 更新） | [statistics.md](statistics.md) | `npm run test:statistics`；浏览器 `node scripts/test-statistics-integration.js --browser`、`node scripts/test-statistics-updates.js --browser` |

其他功能（模板、多页面站点、资源管理页）有各自的 `scripts/test-*.js`，见 `package.json`。
