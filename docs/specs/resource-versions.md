# 资源版本化

状态：草案。日期：2026-10-22。

## 目标与范围

现在每次上传都会生成新的 ID。需求页改 5 轮，就会出现 5 个链接、5 个访问码，发出去的旧链接看不到最新内容。

本版让同一个资源可以多次更新：

- 链接固定：`/v/<id>` 始终显示最新版本
- 每次更新保存一个版本，可以查看历史版本
- 访问码、分类、标签在更新时保持不变
- 项目里用 `.dview.json` 记住"本地文件 → 资源 ID"，agent 上传时自动更新，而不是新建

本版不做：版本对比视图（放到 review-comments）、版本数量配额以外的清理策略、跨账户更新。

## 设计

### 存储

```
data/<type>/<id>/v1/<filename>
data/<type>/<id>/v2/<filename>
meta/<id>.json        # 增加 versions 数组和 current
```

`meta` 新增字段：

```json
{
  "current": 2,
  "versions": [
    { "n": 1, "filename": "prd.html", "size": 12034, "createdAt": "...", "message": "", "git": null },
    { "n": 2, "filename": "prd.html", "size": 13501, "createdAt": "...", "message": "补充错误提示", "git": { "commit": "eb84159", "dirty": false } }
  ]
}
```

- 旧资源没有 `versions` 字段，读取时当作只有一个版本，文件位置不变，不做强制迁移
- 资源类型在不同版本之间不能变（html 不能更新成图片），站点和单文件 HTML 也不能互换
- 一个资源最多保留的版本数由配置 `versions.maxPerResource` 决定（默认 50），超出时删除最早的版本；第一个版本和被确认签字的版本不删
- 资源占用的配额 = 所有版本的大小之和

### 预览路由

| 路径 | 内容 |
| --- | --- |
| `/v/<id>` | 当前版本 |
| `/v/<id>@<n>` | 第 n 个版本（单文件） |
| `/v/<id>@<n>/...` | 第 n 个版本（站点） |

访问码对所有版本都有效。访问码过期只影响访问，不删除版本。

### 接口

- `POST /upload` 增加可选字段 `id`：带上时表示更新这个资源，只能更新自己账户的资源；增加可选字段 `message`、`git_commit`、`git_dirty`
- `GET /api/me/items/:id/versions`：版本列表
- `DELETE /api/me/items/:id/versions/:n`：删除某个版本（不能删当前版本）
- 管理端同样提供这几个接口

返回值在原来的基础上增加 `version`（这次上传后的版本号）和 `updated: true/false`。

### CLI

```bash
dview upload prd.html                     # 有 .dview.json 映射就更新，否则新建
dview upload prd.html -m "补充错误提示"     # 带更新说明
dview upload prd.html --new               # 强制新建
dview upload prd.html --id a8f3k2         # 指定更新某个资源
dview versions a8f3k2                     # 版本列表
```

`.dview.json` 放在 git 仓库根目录，提交进仓库：

```json
{
  "items": {
    "docs/prd/login.html": "a8f3k2",
    "docs/prototype/": "x9d1m7"
  }
}
```

- 路径相对于仓库根目录
- 新建资源后，CLI 自动写入映射
- 映射的资源已经被删除或不属于当前账户时，提示用户，不自动新建
- 在 git 仓库里上传时，自动带上当前 commit 和是否有未提交改动

### 管理端

资源详情增加版本列表：版本号、时间、大小、说明、commit，可以打开任意版本、删除非当前版本。

## 验收

- [ ] 用 `--id` 更新后，原链接显示新内容，访问码不变
- [ ] `/v/<id>@1` 能打开第一个版本，站点的相对路径在历史版本下也正常
- [ ] 没有 `versions` 字段的旧资源可以正常打开，第一次更新后变成 v2
- [ ] 更新别人的资源返回 403；类型不一致返回 400
- [ ] 超过保留上限时删除最早的版本，第一个版本保留
- [ ] `.dview.json` 映射存在时自动更新，`--new` 时新建并更新映射
- [ ] 配额按所有版本累计
- [ ] 统计里，更新记为一次上传事件，并标明是更新

## 待定问题

1. 单个资源默认保留 50 个版本是否合适？
2. 更新时，访问码有效期要不要自动顺延？
3. 统计页的"上传数"要不要区分新建和更新？

## 变更记录

（确认后填写）
