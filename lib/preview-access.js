const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const { createAttemptLimiter } = require('./access-attempts');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function constantEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Codes are verified by hash; the sealed copy only lets the admin read them back.
// The key stays in config, outside data/ and the render sidecar's mount.
function createCodeSealer(secret) {
  if (!secret) return { seal: () => undefined, open: () => null };
  const key = Buffer.from(crypto.hkdfSync('sha256', String(secret), 'vibeview', 'access-code-v1', 32));
  return {
    seal(code, salt) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(salt));
      const data = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), data].map(part => typeof part === 'string' ? part : part.toString('base64url')).join('.');
    },
    open(sealed, salt) {
      try {
        const [version, iv, tag, data, extra] = String(sealed || '').split('.');
        if (version !== 'v1' || extra !== undefined) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(salt));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
      } catch { return null; }
    },
  };
}

async function newPolicy(expiresAt, sealer) {
  const code = Array.from({ length: 12 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(code, salt, 32)).toString('hex');
  const sealed = sealer ? sealer.seal(code, salt) : undefined;
  return { code, policy: { mode: 'code', salt, hash, ...(sealed ? { sealed } : {}), version: crypto.randomBytes(16).toString('hex'), expiresAt } };
}

function accessInfo(meta, options) {
  const policy = meta.access;
  const required = policy ? policy.mode !== 'public' : options.protectLegacy;
  const configured = !!(policy && policy.mode === 'code' && policy.hash && policy.salt && policy.version);
  const expiresAt = policy && policy.expiresAt || null;
  const expired = required && !!expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now());
  return { required, configured, expiresAt, expired, recoverable: configured && !!policy.sealed };
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// 站点内要返回的页面路径（验证后跳回）：只接受本站点下的普通相对路径。
function safeNext(value) {
  const next = typeof value === 'string' ? value : '';
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{0,500}(\?[^#\s<>"]{0,500})?$/.test(next) && !next.startsWith('//') && !/(^|\/)\.\.?(\/|\?|$)/.test(next) ? next : '';
}

function challenge(id, message = '', next = '') {
  // Never include resource titles/descriptions or content in the verification page.
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>预览访问验证</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8fb;color:#1e293b;font:15px system-ui}main{margin:20px;padding:28px;background:white;border:1px solid #d5dde7;border-radius:12px;max-width:360px}h1{font-size:20px}p{color:#5f6b7d;line-height:1.6}label{display:block;margin-bottom:8px}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #d5dde7;border-radius:6px;font:inherit}button{width:100%;padding:11px;margin-top:14px;background:#2563eb;color:white;border:0;border-radius:6px;font:inherit}.error{color:#b42318}</style>
<main><h1>此预览需要访问码</h1><p>请输入分享者提供的访问码。访问码过期后，请联系分享者更新。</p>${message ? `<p class="error" role="alert">${message}</p>` : ''}<form method="post" action="/v/${id}/unlock">${next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : ''}<label for="code">访问码</label><input id="code" name="code" type="password" autocomplete="off" maxlength="64" required autofocus><button>验证并预览</button></form></main></html>`;
}

function createPreviewAccess({ store, options, codeSecret = '', secureCookie = false, onEvent = () => {} }) {
  const sealer = createCodeSealer(codeSecret);
  // 访问统计回调：只在页面打开（GET /v/:id）和验证时触发，/raw 等子资源不计数。
  const emit = (kind, meta, req) => { try { onEvent(kind, meta, req); } catch { /* 统计失败不影响访问 */ } };
  // A restart deliberately revokes preview grants; no access codes are kept in memory.
  const grantKey = crypto.randomBytes(32);
  const attempts = createAttemptLimiter({ file: options.attemptsFile, maxAttempts: options.maxAttempts, windowMs: options.retryWindowMinutes * 60000 || 600000 });
  const cookieName = 'dview_access';
  let activeHashes = 0;
  const hmac = value => crypto.createHmac('sha256', grantKey).update(value).digest('base64url');
  const info = meta => accessInfo(meta, options);
  function headers(res) {
    res.set('Cache-Control', 'private, no-store');
    // no-referrer makes browser form POSTs send Origin: null. Keep the
    // challenge's same-origin POST verifiable without exposing referrers
    // to other sites. Protected content gets no-referrer below.
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.vary('Cookie');
  }
  // 返回有效的授权（含到期时间），否则 null。
  function validGrant(req, meta) {
    try {
      const cookies = String(req.headers.cookie || '').split(';').map(part => part.trim());
      const token = cookies.find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      if (!token || token.length > 1024) return null;
      const [value, signature, extra] = token.split('.');
      if (extra || !constantEqual(hmac(value), signature)) return null;
      const grant = JSON.parse(Buffer.from(value, 'base64url').toString());
      return grant.id === meta.id && grant.version === meta.access.version && grant.exp > Date.now() ? grant : null;
    } catch { return null; }
  }
  // 多页面站点的路径凭证：/v/<id>/~<token>/...。沙箱页面里的子资源请求（尤其模块脚本和 fetch）
  // 不会带 cookie，所以验证通过后把短期凭证放进路径，页面里的相对链接会自动带上。
  // 凭证与 cookie 同时到期，绑定资源和访问码版本；重置访问码或重启服务都会使它失效。
  const siteSignature = (meta, exp) => hmac(`site|${meta.id}|${meta.access.version}|${exp}`).slice(0, 22);
  const siteToken = (meta, exp) => `${exp.toString(36)}.${siteSignature(meta, exp)}`;
  function validSiteToken(meta, token) {
    const [stamp, signature, extra] = String(token).split('.');
    const exp = parseInt(stamp, 36);
    return !extra && /^[0-9a-z]{1,12}$/.test(stamp || '') && exp > Date.now() && constantEqual(siteSignature(meta, exp), signature);
  }
  // Uploaded HTML and raw SVG/HTML execute in an opaque origin, apart from admin.
  // Applies to public previews too, or their scripts could call admin APIs with the admin cookie.
  function sandbox(req, res, meta) {
    if (meta.type === 'html' || meta.type === 'site' || req.path !== '/') {
      res.set('Content-Security-Policy', "sandbox allow-scripts; frame-ancestors 'none'; base-uri 'none'");
    } else res.removeHeader('Content-Security-Policy');
  }
  function requireAccess(req, res, next) {
    const meta = store.readMeta(req.params.id);
    if (!meta) return res.status(404).send('Not found');
    if (meta.type === 'site') return requireSiteAccess(req, res, next, meta);
    const state = info(meta);
    const isPage = req.method === 'GET' && req.path === '/';
    if (!state.required) {
      if (isPage) emit('view', meta, req);
      sandbox(req, res, meta);
      return next();
    }
    headers(res);
    if (!state.configured || state.expired || !validGrant(req, meta)) {
      if (isPage) {
        emit('challenge', meta, req);
        if (state.expired) emit('expired', meta, req);
      }
      const message = state.expired ? '访问码已过期，请联系分享者更新。' : !state.configured ? '请联系分享者在管理端生成访问码。' : '';
      if (req.method !== 'GET' || req.path !== '/') return res.status(403).type('text').send('Preview access required');
      return res.status(401).type('html').send(challenge(meta.id, message));
    }
    req.previewProtected = true;
    if (isPage) emit('view', meta, req);
    res.set('Referrer-Policy', 'no-referrer');
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
    sandbox(req, res, meta);
    next();
  }
  // 站点：入口和子页面共用一套访问规则。req.url 在挂载点 /v/:id 下，形如 /、/about.html、/~<token>/app.js。
  function requireSiteAccess(req, res, next, meta) {
    const state = info(meta);
    const match = req.url.match(/^\/~([^/?]*)(.*)$/);
    const token = match ? match[1] : null;
    // 去掉路径凭证，后面的路由和 sidecar 只看到站点内的路径
    if (match) req.url = match[2].startsWith('/') ? match[2] : `/${match[2]}`;
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '600' });
      if (req.get('access-control-request-headers')) res.set('Access-Control-Allow-Headers', req.get('access-control-request-headers'));
      return res.status(204).end();
    }
    // 站点入口（/v/<id>/）的一次打开计一次访问；子页面、资源和跳转不计。
    const entry = req.method === 'GET' && !match && req.path === '/';
    if (!state.required) {
      if (entry && req.originalUrl.split('?')[0].endsWith('/')) emit('view', meta, req);
      sandbox(req, res, meta);
      return next();
    }
    headers(res);
    if (!reading) return res.status(403).type('text').send('Preview access required');
    if (match) {
      if (state.configured && !state.expired && validSiteToken(meta, token)) {
        req.previewProtected = true;
        res.set('Referrer-Policy', 'no-referrer');
        delete req.headers['if-none-match'];
        delete req.headers['if-modified-since'];
        sandbox(req, res, meta);
        return next();
      }
      // 凭证过期或无效：页面跳回不带凭证的地址重新验证，资源直接拒绝
      if (req.get('sec-fetch-mode') === 'navigate') return res.redirect(302, `/v/${meta.id}${req.url}`);
      return res.status(403).type('text').send('Preview access required');
    }
    const grant = state.configured && !state.expired ? validGrant(req, meta) : null;
    if (!grant) {
      if (entry) {
        emit('challenge', meta, req);
        if (state.expired) emit('expired', meta, req);
      }
      const message = state.expired ? '访问码已过期，请联系分享者更新。' : !state.configured ? '请联系分享者在管理端生成访问码。' : '';
      return res.status(401).type('html').send(challenge(meta.id, message, req.path === '/' ? '' : safeNext(req.url)));
    }
    if (entry) emit('view', meta, req);
    res.redirect(302, `/v/${meta.id}/~${siteToken(meta, grant.exp)}${req.url}`);
  }
  async function unlock(req, res, next) {
    headers(res);
    const meta = store.readMeta(req.params.id);
    if (!meta) return res.status(404).send('Not found');
    const state = info(meta);
    if (!state.required) return res.redirect(303, `/v/${meta.id}`);
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== options.baseUrl) {
      return res.status(403).send('Invalid origin');
    }
    const now = Date.now();
    if (activeHashes >= 4) {
      emit('rate_limited', meta, req);
      res.set('Retry-After', '2');
      return res.status(429).type('html').send(challenge(meta.id, '尝试次数过多，请稍后重试。'));
    }
    let attempt;
    try { attempt = attempts.take(meta.id); }
    catch (error) { return next(error); }
    if (!attempt.allowed) {
      emit('rate_limited', meta, req);
      res.set('Retry-After', String(attempt.retryAfter));
      return res.status(429).type('html').send(challenge(meta.id, '尝试次数过多，请稍后重试。'));
    }
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!state.configured || state.expired || !code || code.length > 64) {
      emit('unlock_fail', meta, req);
      return res.status(403).type('html').send(challenge(meta.id, state.expired ? '访问码已过期，请联系分享者更新。' : '访问码无效，请联系分享者确认。'));
    }
    activeHashes++;
    try {
      const hash = (await scrypt(code, meta.access.salt, 32)).toString('hex');
      // Re-read after hashing so a concurrent reset/expiry cannot issue an old grant.
      const current = store.readMeta(meta.id);
      if (!constantEqual(hash, meta.access.hash) || !current || current.access?.version !== meta.access.version || info(current).expired) {
        emit('unlock_fail', meta, req);
        return res.status(403).type('html').send(challenge(meta.id, '访问码无效，请联系分享者确认。'));
      }
      attempts.clear(meta.id);
      emit('unlock_ok', meta, req);
      const exp = Math.min(now + options.grantMinutes * 60000, state.expiresAt ? Date.parse(state.expiresAt) : Infinity);
      const value = Buffer.from(JSON.stringify({ id: meta.id, version: meta.access.version, exp })).toString('base64url');
      res.cookie(cookieName, `${value}.${hmac(value)}`, { path: `/v/${meta.id}`, httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: exp - now });
      const back = meta.type === 'site' ? safeNext(req.body?.next) : '';
      res.redirect(303, `/v/${meta.id}${back}`);
    } catch (error) { next(error); }
    finally { activeHashes--; }
  }
  async function initialPolicy() {
    if (!options.defaultRequired) return { policy: { mode: 'public' } };
    return newPolicy(new Date(Date.now() + options.defaultDays * 86400000).toISOString(), sealer);
  }
  async function update(meta, input) {
    if (!input || !['code', 'public'].includes(input.mode)) throw new Error('mode must be code or public');
    if (input.mode === 'public') return { policy: { mode: 'public' } };
    let expiresAt;
    if (input.expiresAt === null) expiresAt = null;
    else if (typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt))) expiresAt = new Date(input.expiresAt).toISOString();
    else if (input.expiresAt === undefined) expiresAt = new Date(Date.now() + options.defaultDays * 86400000).toISOString();
    else throw new Error('expiresAt must be an ISO date or null');
    if (input.reset === true || !info(meta).configured) return newPolicy(expiresAt, sealer);
    return { policy: { ...meta.access, mode: 'code', expiresAt, version: crypto.randomBytes(16).toString('hex') } };
  }
  // Returns the current code for admin sharing, or null when it predates sealing or the key changed.
  function reveal(meta) {
    if (!info(meta).configured || !meta.access.sealed) return null;
    return sealer.open(meta.access.sealed, meta.access.salt);
  }
  return { info, initialPolicy, update, requireAccess, unlock, reveal };
}

module.exports = { createPreviewAccess, accessInfo, constantEqual };
