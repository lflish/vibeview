// 共享预览路由：host 直出与 render sidecar 共用
const fs = require('fs');
const path = require('path');
const viewer = require('./viewer');
const { validSegment, mimeFor } = require('./preview-store');
const versions = require('./versions');

function previewSecurityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
}

// 请求路径里的查询串（重定向时原样保留）
function queryOf(req) {
  const i = req.originalUrl.indexOf('?');
  return i === -1 ? '' : req.originalUrl.slice(i);
}

// 多页面站点：按相对路径读站点目录（当前版本或某个历史版本）下的文件。
// 页面在沙箱（opaque origin）里运行，模块脚本和 fetch 都是跨源请求，所以允许任意来源读取；
// 受保护站点的访问凭证在路径里（见 preview-access），不依赖 cookie。
function serveSite(req, res, root, rest) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const parts = rest.split('/');
  const wantsDir = rest === '' || rest.endsWith('/');
  if (wantsDir) parts.pop();
  if (!root || !parts.every(validSegment) || parts.some((part) => part.startsWith('.'))) return res.status(404).send('Not found');
  let file = path.join(root, ...parts);
  let stat;
  try { stat = fs.statSync(file); } catch { stat = null; }
  if (stat && stat.isDirectory()) {
    // 目录要带结尾斜杠，页面里的相对路径才能正确解析
    if (!wantsDir) return res.redirect(302, `${encodeURIComponent(parts[parts.length - 1])}/${queryOf(req)}`);
    file = path.join(file, 'index.html');
    try { stat = fs.statSync(file); } catch { stat = null; }
  }
  // 用 root 发送：点文件检查只针对站点内的相对路径（历史版本本身在 .versions/ 下）
  if (!stat || !stat.isFile()) {
    if (fs.existsSync(path.join(root, '404.html'))) return res.status(404).sendFile('404.html', { root, dotfiles: 'deny' });
    return res.status(404).send('Not found');
  }
  res.sendFile(path.relative(root, file), { root, dotfiles: 'deny' });
}

// 单个资源的某个版本：HTML 直出，图片/视频用包裹页，raw 返回原始文件。
function servePage(res, storeApi, meta, n) {
  const entry = versions.find(meta, n);
  const file = entry && storeApi.filePath(meta, n);
  if (!file) return res.status(404).send('Not found');
  const tag = n === versions.current(meta) ? undefined : n;
  if (meta.type === 'html') {
    res.type('html');
    return res.sendFile(file);
  }
  if (meta.type === 'image') {
    res.type('html');
    return res.send(viewer.renderImage(meta.id, entry.filename, tag));
  }
  if (meta.type === 'video') {
    res.type('html');
    return res.send(viewer.renderVideo(meta.id, entry.filename, tag));
  }
  res.status(404).send('Not found');
}

function serveRaw(res, storeApi, meta, n) {
  const entry = versions.find(meta, n);
  const file = entry && storeApi.filePath(meta, n);
  if (!file) return res.status(404).send('Not found');
  res.type(mimeFor(meta.type, entry.filename, entry.mime || meta.mime));
  res.sendFile(file);
}

/**
 * 路径：/v/<id>（当前版本）、/v/<id>/@<n>（第 n 版）、/v/<id>/raw、/v/<id>/@<n>/raw；
 * 站点为 /v/<id>/... 与 /v/<id>/@<n>/...。
 * @param {import('express').Express} app
 * @param {{ isValidId: Function, readMeta: Function, filePath: Function, fileDir: Function, versionDir: Function }} storeApi
 */
function mountPreviewRoutes(app, storeApi) {
  app.get('/v/:id', previewSecurityHeaders, (req, res) => {
    const { id } = req.params;
    if (!storeApi.isValidId(id)) return res.status(404).send('Not found');
    const meta = storeApi.readMeta(id);
    if (!meta) return res.status(404).send('Not found');

    if (meta.type === 'site') {
      // /v/<id> → /v/<id>/，让站点里的相对路径落在自己的目录下
      if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(302, `/v/${id}/${queryOf(req)}`);
      return serveSite(req, res, storeApi.versionDir(meta), '');
    }
    servePage(res, storeApi, meta, versions.current(meta));
  });

  app.get('/v/:id/*', previewSecurityHeaders, (req, res) => {
    const { id } = req.params;
    if (!storeApi.isValidId(id)) return res.status(404).send('Not found');
    const meta = storeApi.readMeta(id);
    if (!meta) return res.status(404).send('Not found');
    const rest = req.params[0];
    const slash = rest.indexOf('/');
    const n = versions.parseSegment(slash === -1 ? rest : rest.slice(0, slash));
    if (n !== null && !versions.find(meta, n)) return res.status(404).send('Not found');

    if (meta.type === 'site') {
      if (n === null) return serveSite(req, res, storeApi.versionDir(meta), rest);
      // /v/<id>/@3 → /v/<id>/@3/
      if (slash === -1) return res.redirect(302, `${rest}/${queryOf(req)}`);
      return serveSite(req, res, storeApi.versionDir(meta, n), rest.slice(slash + 1));
    }
    const tail = n === null ? rest : slash === -1 ? '' : rest.slice(slash + 1);
    const version = n === null ? versions.current(meta) : n;
    if (n !== null && tail === '') return servePage(res, storeApi, meta, version);
    if (tail === 'raw') return serveRaw(res, storeApi, meta, version);
    res.status(404).send('Not found');
  });
}

module.exports = { mountPreviewRoutes, previewSecurityHeaders };
