// 渲染 sidecar：仅 /v、/v/:id/raw、/healthz；不读 config.yaml / 无账户逻辑
const express = require('express');
const { createPreviewStore } = require('./lib/preview-store');
const { mountPreviewRoutes } = require('./lib/preview-routes');

const port = Number(process.env.RENDER_PORT || 3001);
const dataRoot = process.env.RENDER_DATA_ROOT || '/data';

const storeApi = createPreviewStore(dataRoot);
const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, role: 'render', dataRoot: storeApi.dataRoot });
});

mountPreviewRoutes(app, storeApi);

app.listen(port, '0.0.0.0', () => {
  console.log(`[vibeview-render] listening on 0.0.0.0:${port} dataRoot=${storeApi.dataRoot}`);
});
