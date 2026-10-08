// Host → render sidecar 反向代理（无静默回退）
const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * @param {{ renderUrl: string, proxyTimeoutMs?: number }} opts
 * @returns {import('express').RequestHandler}
 */
function createPreviewProxy(opts) {
  const target = new URL(opts.renderUrl.replace(/\/$/, ''));
  const timeoutMs = opts.proxyTimeoutMs || 30000;
  const lib = target.protocol === 'https:' ? https : http;

  return function previewProxy(req, res) {
    // req.url 在 app.use('/v', ...) 下是去掉挂载点后的路径；需还原 /v 前缀
    const suffix = req.url === '/' ? '' : req.url;
    const pathAndQuery = `/v${suffix}`;

    const headers = { ...req.headers, host: target.host };
    delete headers['connection'];

    const proxyReq = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: pathAndQuery,
        method: req.method,
        headers,
        timeout: timeoutMs,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).type('text').send('Preview render timed out');
      }
    });

    proxyReq.on('error', (err) => {
      console.error('[preview-proxy] render unreachable:', err.message);
      if (!res.headersSent) {
        res.status(502).type('text').send('Preview render unavailable');
      }
    });

    req.pipe(proxyReq);
  };
}

module.exports = { createPreviewProxy };
