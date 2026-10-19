// 共享预览路由：host 直出与 render sidecar 共用
const fs = require('fs');
const path = require('path');
const viewer = require('./viewer');
const { validSegment } = require('./preview-store');

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

// 多页面站点：按相对路径读 <site_dir>/<id>/ 下的文件。
// 页面在沙箱（opaque origin）里运行，模块脚本和 fetch 都是跨源请求，所以允许任意来源读取；
// 受保护站点的访问凭证在路径里（见 preview-access），不依赖 cookie。
function serveSite(req, res, storeApi, meta, rest) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const root = storeApi.fileDir('site', meta.id);
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
  if (!stat || !stat.isFile()) {
    const notFound = path.join(root, '404.html');
    if (fs.existsSync(notFound)) return res.status(404).sendFile(notFound);
    return res.status(404).send('Not found');
  }
  res.sendFile(file, { dotfiles: 'deny' });
}

/**
 * @param {import('express').Express} app
 * @param {{ isValidId: Function, readMeta: Function, filePath: Function, fileDir: Function }} storeApi
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
      return serveSite(req, res, storeApi, meta, '');
    }
    if (meta.type === 'html') {
      res.type('html');
      return res.sendFile(storeApi.filePath(meta));
    }
    if (meta.type === 'image') {
      res.type('html');
      return res.send(viewer.renderImage(id, meta.filename));
    }
    if (meta.type === 'video') {
      res.type('html');
      return res.send(viewer.renderVideo(id, meta.filename));
    }
    res.status(404).send('Not found');
  });

  app.get('/v/:id/*', previewSecurityHeaders, (req, res) => {
    const { id } = req.params;
    if (!storeApi.isValidId(id)) return res.status(404).send('Not found');
    const meta = storeApi.readMeta(id);
    if (!meta) return res.status(404).send('Not found');
    if (meta.type === 'site') return serveSite(req, res, storeApi, meta, req.params[0]);
    if (req.params[0] !== 'raw') return res.status(404).send('Not found');
    const fp = storeApi.filePath(meta);
    if (!fp) return res.status(404).send('Not found');
    res.type(meta.mime || 'application/octet-stream');
    res.sendFile(fp);
  });
}

module.exports = { mountPreviewRoutes, previewSecurityHeaders };
