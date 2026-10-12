// 渲染 sidecar：仅 /v、/v/:id/raw、/healthz；不读 config.yaml / 无账户逻辑
const express = require('express');
const { createPreviewStore } = require('./lib/preview-store');
const { mountPreviewRoutes } = require('./lib/preview-routes');
const crypto = require('node:crypto');

const port = Number(process.env.RENDER_PORT || 3001);
const dataRoot = process.env.RENDER_DATA_ROOT || '/data';

const storeApi = createPreviewStore(dataRoot);
const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'render', dataRoot: storeApi.dataRoot });
});

// Protected previews accept only the trusted main-service gateway.
app.use('/v/:id', (req, res, next) => {
  const meta = storeApi.readMeta(req.params.id);
  if (!meta) return res.status(404).send('Not found');
  if (meta.access?.mode === 'public') return next();
  const expected = Buffer.from(process.env.RENDER_GATEWAY_TOKEN || '');
  const received = Buffer.from(req.get('x-preview-gateway') || '');
  if (!expected.length || received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.status(403).send('Preview gateway authentication required');
  }
  res.set('Cache-Control', 'private, no-store');
  next();
});
mountPreviewRoutes(app, storeApi);

app.listen(port, '0.0.0.0', () => {
  console.log(`[vibeview-render] listening on 0.0.0.0:${port} dataRoot=${storeApi.dataRoot}`);
});
