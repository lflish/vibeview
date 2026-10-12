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

async function newPolicy(expiresAt) {
  const code = Array.from({ length: 12 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(code, salt, 32)).toString('hex');
  return { code, policy: { mode: 'code', salt, hash, version: crypto.randomBytes(16).toString('hex'), expiresAt } };
}

function accessInfo(meta, options) {
  const policy = meta.access;
  const required = policy ? policy.mode !== 'public' : options.protectLegacy;
  const configured = !!(policy && policy.mode === 'code' && policy.hash && policy.salt && policy.version);
  const expiresAt = policy && policy.expiresAt || null;
  const expired = required && !!expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now());
  return { required, configured, expiresAt, expired };
}

function challenge(id, message = '') {
  // Never include resource titles/descriptions or content in the verification page.
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>预览访问验证</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8fb;color:#1e293b;font:15px system-ui}main{margin:20px;padding:28px;background:white;border:1px solid #d5dde7;border-radius:12px;max-width:360px}h1{font-size:20px}p{color:#5f6b7d;line-height:1.6}label{display:block;margin-bottom:8px}input{box-sizing:border-box;width:100%;padding:11px;border:1px solid #d5dde7;border-radius:6px;font:inherit}button{width:100%;padding:11px;margin-top:14px;background:#2563eb;color:white;border:0;border-radius:6px;font:inherit}.error{color:#b42318}</style>
<main><h1>此预览需要访问码</h1><p>请输入分享者提供的访问码。访问码过期后，请联系分享者更新。</p>${message ? `<p class="error" role="alert">${message}</p>` : ''}<form method="post" action="/v/${id}/unlock"><label for="code">访问码</label><input id="code" name="code" type="password" autocomplete="off" maxlength="64" required autofocus><button>验证并预览</button></form></main></html>`;
}

function createPreviewAccess({ store, options, secureCookie = false }) {
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
  function validGrant(req, meta) {
    try {
      const cookies = String(req.headers.cookie || '').split(';').map(part => part.trim());
      const token = cookies.find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      if (!token || token.length > 1024) return false;
      const [value, signature, extra] = token.split('.');
      if (extra || !constantEqual(hmac(value), signature)) return false;
      const grant = JSON.parse(Buffer.from(value, 'base64url').toString());
      return grant.id === meta.id && grant.version === meta.access.version && grant.exp > Date.now();
    } catch { return false; }
  }
  function requireAccess(req, res, next) {
    const meta = store.readMeta(req.params.id);
    if (!meta) return res.status(404).send('Not found');
    const state = info(meta);
    if (!state.required) return next();
    headers(res);
    if (!state.configured || state.expired || !validGrant(req, meta)) {
      const message = state.expired ? '访问码已过期，请联系分享者更新。' : !state.configured ? '请联系分享者在管理端生成访问码。' : '';
      if (req.method !== 'GET' || req.path !== '/') return res.status(403).type('text').send('Preview access required');
      return res.status(401).type('html').send(challenge(meta.id, message));
    }
    req.previewProtected = true;
    res.set('Referrer-Policy', 'no-referrer');
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
    // Uploaded HTML and raw SVG/HTML execute in an opaque origin, apart from admin.
    if (meta.type === 'html' || req.path !== '/') {
      res.set('Content-Security-Policy', "sandbox allow-scripts; frame-ancestors 'none'; base-uri 'none'");
    } else res.removeHeader('Content-Security-Policy');
    next();
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
      res.set('Retry-After', '2');
      return res.status(429).type('html').send(challenge(meta.id, '尝试次数过多，请稍后重试。'));
    }
    let attempt;
    try { attempt = attempts.take(meta.id); }
    catch (error) { return next(error); }
    if (!attempt.allowed) {
      res.set('Retry-After', String(attempt.retryAfter));
      return res.status(429).type('html').send(challenge(meta.id, '尝试次数过多，请稍后重试。'));
    }
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!state.configured || state.expired || !code || code.length > 64) {
      return res.status(403).type('html').send(challenge(meta.id, state.expired ? '访问码已过期，请联系分享者更新。' : '访问码无效，请联系分享者确认。'));
    }
    activeHashes++;
    try {
      const hash = (await scrypt(code, meta.access.salt, 32)).toString('hex');
      // Re-read after hashing so a concurrent reset/expiry cannot issue an old grant.
      const current = store.readMeta(meta.id);
      if (!constantEqual(hash, meta.access.hash) || !current || current.access?.version !== meta.access.version || info(current).expired) {
        return res.status(403).type('html').send(challenge(meta.id, '访问码无效，请联系分享者确认。'));
      }
      attempts.clear(meta.id);
      const exp = Math.min(now + options.grantMinutes * 60000, state.expiresAt ? Date.parse(state.expiresAt) : Infinity);
      const value = Buffer.from(JSON.stringify({ id: meta.id, version: meta.access.version, exp })).toString('base64url');
      res.cookie(cookieName, `${value}.${hmac(value)}`, { path: `/v/${meta.id}`, httpOnly: true, secure: secureCookie, sameSite: 'strict', maxAge: exp - now });
      res.redirect(303, `/v/${meta.id}`);
    } catch (error) { next(error); }
    finally { activeHashes--; }
  }
  async function initialPolicy() {
    if (!options.defaultRequired) return { policy: { mode: 'public' } };
    return newPolicy(new Date(Date.now() + options.defaultDays * 86400000).toISOString());
  }
  async function update(meta, input) {
    if (!input || !['code', 'public'].includes(input.mode)) throw new Error('mode must be code or public');
    if (input.mode === 'public') return { policy: { mode: 'public' } };
    let expiresAt;
    if (input.expiresAt === null) expiresAt = null;
    else if (typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt))) expiresAt = new Date(input.expiresAt).toISOString();
    else if (input.expiresAt === undefined) expiresAt = new Date(Date.now() + options.defaultDays * 86400000).toISOString();
    else throw new Error('expiresAt must be an ISO date or null');
    if (input.reset === true || !info(meta).configured) return newPolicy(expiresAt);
    return { policy: { ...meta.access, mode: 'code', expiresAt, version: crypto.randomBytes(16).toString('hex') } };
  }
  return { info, initialPolicy, update, requireAccess, unlock };
}

module.exports = { createPreviewAccess, accessInfo, constantEqual };
