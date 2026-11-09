# 上传、更新和版本

## 子功能

- 上传 HTML、图片、视频、多页面站点（zip 或目录）；返回 `id`、`url`、`accessCode`
- 用 `id` 更新同一资源，生成新版本，链接和访问码不变；`/v/<id>/@<n>` 打开历史版本
- 删除历史版本（当前版本和第 1 版不能删）；配额（文件数、存储）

## 怎么到达

`POST $BASE/upload`（Bearer token）；CLI `bin/dview upload <文件> [--id <id>] --json`；版本列表 `GET /api/me/items/:id/versions`。

## 怎么操作和验证

1. 上传 `page.html` → 200，记下 `id`；打开 `url` 能看到页面（受保护时先输访问码）。
2. `-F id=<id>` 再传一个不同内容 → 返回 `updated: true` 和 `versionUrl`；原链接显示新内容，`/@1` 显示旧内容。
3. 用 `TOKEN_B` 更新 alice 的资源 → 403；类型不一致（HTML 资源传图片）→ 400。
4. `DELETE /api/me/items/:id/versions/<当前版本号>` → 400；删其他版本 → 200。

## 注意事项

- 新版本号 = 现有最大号 + 1；删除的版本号不会复用。
- 更新不占文件数，只计存储配额。
