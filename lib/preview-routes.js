// 共享预览路由：host 直出与 render sidecar 共用
const viewer = require('./viewer');

function previewSecurityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
}

/**
 * @param {import('express').Express} app
 * @param {{ isValidId: Function, readMeta: Function, filePath: Function }} storeApi
 */
function mountPreviewRoutes(app, storeApi) {
  app.get('/v/:id', previewSecurityHeaders, (req, res) => {
    const { id } = req.params;
    if (!storeApi.isValidId(id)) return res.status(404).send('Not found');
    const meta = storeApi.readMeta(id);
    if (!meta) return res.status(404).send('Not found');

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

  app.get('/v/:id/raw', previewSecurityHeaders, (req, res) => {
    const { id } = req.params;
    if (!storeApi.isValidId(id)) return res.status(404).send('Not found');
    const meta = storeApi.readMeta(id);
    if (!meta) return res.status(404).send('Not found');
    const fp = storeApi.filePath(meta);
    if (!fp) return res.status(404).send('Not found');
    res.type(meta.mime || 'application/octet-stream');
    res.sendFile(fp);
  });
}

module.exports = { mountPreviewRoutes, previewSecurityHeaders };
