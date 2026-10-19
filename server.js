const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const store = require('./lib/store');
const accounts = require('./lib/accounts');
const metadata = require('./lib/metadata');
const classification = require('./lib/classification');
const resourceIndex = require('./lib/resource-index');
const statistics = require('./lib/statistics');
const visits = require('./lib/visit-stats');
const { isBot } = require('./lib/visits');
const { startCleanupScheduler } = require('./lib/cleanup');
const { mountPreviewRoutes } = require('./lib/preview-routes');
const { createPreviewProxy } = require('./lib/preview-proxy');
const { createPreviewAccess, constantEqual } = require('./lib/preview-access');
const { createAdminLoginProtection } = require('./lib/admin-login');
// 预览访问计数：爬虫与带管理员会话 cookie 的打开单独计数，不算作访客。
// 预览路由挂在 session 中间件之前，这里只看 cookie 是否存在（只有登录成功才会下发）。
function hasAdminCookie(req) {
  return /(?:^|;\s*)connect\.sid=/.test(String(req.headers.cookie || ''));
}
function recordVisit(kind, meta, req) {
  const labels = { ...meta, ...classification.normalize(meta) };
  if (kind === 'view' || kind === 'challenge') {
    if (isBot(req.get('user-agent'))) return visits.record(labels, 'bots');
    if (kind === 'view') return visits.record(labels, hasAdminCookie(req) ? 'admin_views' : 'views');
    return visits.record(labels, 'challenges');
  }
  const map = { expired: 'expired_hits', unlock_ok: 'unlock_ok', unlock_fail: 'unlock_fail', rate_limited: 'rate_limited' };
  if (map[kind]) visits.record(labels, map[kind]);
}
const previewAccess = createPreviewAccess({
  store,
  options: config.access,
  codeSecret: config.access.codeSecret || config.admin.sessionSecret,
  secureCookie: config.baseUrl.startsWith('https://'),
  onEvent: recordVisit,
});
const adminLogin = createAdminLoginProtection(config.admin);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

// 确保存储目录存在
for (const d of [
  config.storage.htmlDir,
  config.storage.imageDir,
  config.storage.videoDir,
  config.storage.metaDir,
]) {
  fs.mkdirSync(d, { recursive: true });
}

// ---- 上传 token 鉴权（token = 账户） ----
function requireToken(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const account = m ? accounts.findActiveByToken(m[1].trim()) : null;
  if (!account) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.account = account;
  req.uploadSource = account.name;
  next();
}

// 修正 multer 默认 latin1 文件名编码，并去除路径成分
function safeFilename(original) {
  let name = original;
  try {
    name = Buffer.from(original, 'latin1').toString('utf8');
  } catch {
    /* 保持原值 */
  }
  return path.basename(name).replace(/[/\\]/g, '_') || 'file';
}

// ---- multer：先判类型再决定目录，沿用同一个 id ----
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const type = store.typeForMime(file.mimetype, file.originalname);
    if (!type) return cb(new Error('unsupported file type'));
    if (!req.uploadId) req.uploadId = store.newId();
    req.uploadType = type;
    const dir = store.fileDir(type, req.uploadId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, safeFilename(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.storage.maxSizeMb * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, store.typeForMime(file.mimetype, file.originalname) !== null);
  },
}).single('file');

function mapItem(m) {
  const description = m.description || metadata.descriptionFromFile(store.filePath(m), m.type);
  return {
    id: m.id,
    type: m.type,
    filename: m.filename,
    size: m.size,
    source: m.source,
    description,
    ...classification.normalize(m),
    createdAt: m.createdAt,
    access: previewAccess.info(store.readMeta(m.id) || m),
    url: `${config.baseUrl}/v/${m.id}`,
  };
}

// 给列表补上打开次数与最后访问时间（批量查询）。
function withVisits(items) {
  const totals = visits.totalsFor(items.map((item) => item.id));
  return items.map((item) => ({ ...item, visits: totals.get(item.id) || { views: 0, firstViewedAt: null, lastViewedAt: null } }));
}

// 启动时把已有 JSON 元数据迁移/修复到 SQLite 索引；JSON 仍是权威数据源。
statistics.initialize();
visits.start();
resourceIndex.attachVisits(visits.file);
resourceIndex.rebuild(store.listAll().map((item) => ({
  ...item,
  description: item.description || metadata.descriptionFromFile(store.filePath(item), item.type),
})));

// 列表筛选参数：分类维度统一做与上传时相同的规范化，保证能精确匹配。
function listFilters(query = {}) {
  const text = (value) => String(value || '').trim().slice(0, 120);
  const category = text(query.category);
  return {
    q: text(query.q).toLowerCase(),
    type: ['html', 'image', 'video'].includes(query.type) ? query.type : '',
    source: text(query.source),
    category: category === 'none' ? 'none' : classification.normalizeCategory(category),
    agent: classification.normalizeLabel(text(query.agent)),
    project: text(query.project) === '-' ? '-' : classification.normalizeLabel(text(query.project)),
    tag: classification.normalizeTags(text(query.tag))[0] || '',
    visit: ['never', 'stale30', 'recent7'].includes(query.visit) ? query.visit : '',
  };
}

function matchesFilters(item, f) {
  if (f.type && item.type !== f.type) return false;
  if (f.source && item.source !== f.source) return false;
  if (f.category && item.category !== (f.category === 'none' ? '' : f.category)) return false;
  if (f.agent && item.agent !== f.agent) return false;
  if (f.project && item.project !== (f.project === '-' ? '' : f.project)) return false;
  if (f.visit && item.visits) {
    const last = item.visits.lastViewedAt || '';
    if (f.visit === 'never' && item.visits.views) return false;
    if (f.visit === 'stale30' && last >= new Date(Date.now() - 30 * 86400000).toISOString()) return false;
    if (f.visit === 'recent7' && last < new Date(Date.now() - 7 * 86400000).toISOString()) return false;
  }
  if (f.tag && !item.tags.includes(f.tag)) return false;
  if (f.q) {
    const haystack = [item.filename, item.description, item.source, item.id, item.type, item.url,
      item.category, item.agent, item.model, item.project, ...item.tags]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');
    if (!haystack.includes(f.q)) return false;
  }
  return true;
}

function countFacets(items) {
  const facets = { category: new Map(), agent: new Map(), project: new Map(), tag: new Map() };
  const bump = (map, value) => map.set(value, (map.get(value) || 0) + 1);
  for (const item of items) {
    bump(facets.category, item.category);
    bump(facets.agent, item.agent);
    bump(facets.project, item.project);
    for (const tag of item.tags) bump(facets.tag, tag);
  }
  const list = (map) => [...map].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return Object.fromEntries(Object.entries(facets).map(([key, map]) => [key, list(map)]));
}

// 上传失败时清掉已落盘的临时目录
function cleanupFailedUpload(req) {
  if (!req.uploadId || !req.uploadType) return;
  const dir = store.fileDir(req.uploadType, req.uploadId);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- A. 上传接口 ----
app.post('/upload', requireToken, (req, res) => {
  // 文件数配额可在落盘前预检；存储配额需等 multer 给出 size
  const usage = accounts.usageFor(req.account.name);
  if (req.account.maxFiles != null && usage.count >= req.account.maxFiles) {
    return res.status(429).json({
      error: `quota exceeded: max_files=${req.account.maxFiles} (current ${usage.count})`,
    });
  }

  upload(req, res, async (err) => {
    if (err) {
      cleanupFailedUpload(req);
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'file too large' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'no file (field name must be "file")' });

    const q = accounts.checkQuota(req.account, req.file.size);
    if (!q.ok) {
      cleanupFailedUpload(req);
      return res.status(q.status || 429).json({ error: q.error });
    }

    const id = req.uploadId;
    const filename = safeFilename(req.file.originalname);
    let createdAccess;
    try {
      const mode = req.body.access_mode;
      if (mode !== undefined && !['public', 'code'].includes(mode)) throw new Error('invalid access_mode');
      const days = req.body.access_days === undefined ? config.access.defaultDays : Number(req.body.access_days);
      if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('access_days must be 1-3650');
      createdAccess = mode === undefined && req.body.access_days === undefined
        ? await previewAccess.initialPolicy()
        : await previewAccess.update({}, { mode: mode || 'code', expiresAt: new Date(Date.now() + days * 86400000).toISOString() });
    } catch (error) {
      cleanupFailedUpload(req);
      return res.status(400).json({ error: error.message });
    }
    const storedPath = store.filePath({ id, type: req.uploadType, filename });
    const meta = {
      access: createdAccess.policy,
      id,
      type: req.uploadType,
      filename,
      mime: req.file.mimetype,
      size: req.file.size,
      source: req.uploadSource,
      description: metadata.descriptionForUpload(storedPath, req.uploadType, req.body && req.body.description),
      ...classification.forUpload(storedPath, req.uploadType, req.body || {}),
      createdAt: new Date().toISOString(),
    };
    try {
      store.writeMeta(id, meta);
    } catch (error) {
      cleanupFailedUpload(req);
      return res.status(500).json({ error: 'unable to save upload metadata' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ url: `${config.baseUrl}/v/${id}`, id, source: meta.source, description: meta.description,
      ...classification.normalize(meta), access: previewAccess.info(meta), accessCode: createdAccess.code });
  });
});

// ---- A2. 账户自助（Bearer token，只能管自己的资源） ----
app.get('/api/me', requireToken, (req, res) => {
  res.json({ account: accounts.publicAccountInfo(req.account) });
});

app.get('/api/me/items', requireToken, (req, res) => {
  const filters = listFilters(req.query);
  const items = withVisits(store.listBySource(req.account.name).map(mapItem)).filter((item) => matchesFilters(item, filters));
  res.json({ items, account: accounts.publicAccountInfo(req.account) });
});

app.delete('/api/me/items/:id', requireToken, (req, res) => {
  const { id } = req.params;
  if (!store.isValidId(id)) return res.status(400).json({ error: 'bad id' });
  const meta = store.readMeta(id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (meta.source !== req.account.name) {
    return res.status(403).json({ error: 'forbidden: not your resource' });
  }
  const ok = store.remove(id, 'owner');
  res.json({ ok });
});

// ---- B. 预览接口：访问验证在直出与 sidecar 代理前统一执行 ----
app.post('/v/:id/unlock', express.urlencoded({ extended: false, limit: '1kb' }), previewAccess.unlock);
app.use('/v/:id', previewAccess.requireAccess);
// proxy_to_render=true：反代到 sidecar；失败返回 502，禁止静默回退到本进程直出
if (config.preview.proxyToRender) {
  app.use('/v', createPreviewProxy(config.preview));
} else {
  mountPreviewRoutes(app, store);
}

// 浅健康检查（默认不探测 sidecar）
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    role: 'main',
    previewProxy: config.preview.proxyToRender,
  });
});

// ---- C. 管理端（session 登录） ----
// Only expose these shared assets; login needs them before authentication.
for (const asset of ['theme.css', 'theme.js']) {
  app.get(`/admin/${asset}`, (_req, res) => {
    res.sendFile(path.join(__dirname, 'views', asset));
  });
}
app.use(
  session({
    secret: config.admin.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
  })
);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (origin && origin !== config.baseUrl && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'invalid origin' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user) return next();
  // API 返回 JSON，避免 fetch 跟到登录页 HTML
  if (req.path.startsWith('/admin/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.redirect('/admin/login');
}

// 访问统计：按天的打开次数、访问码漏斗、热门资源、按项目分布，以及访问码状态快照。
function visitSummary(query = {}) {
  const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 120) : '');
  const filters = {
    source: text(query.source),
    type: ['html', 'image', 'video'].includes(query.type) ? query.type : '',
    project: text(query.project) === '-' ? '-' : classification.normalizeLabel(text(query.project)),
  };
  const current = store.listAll().map((meta) => ({ ...meta, ...classification.normalize(meta) }))
    .filter((item) => (!filters.source || item.source === filters.source) && (!filters.type || item.type === filters.type)
      && (!filters.project || item.project === (filters.project === '-' ? '' : filters.project)));
  // 默认访问码有效期为 7 天，「即将到期」取 3 天，避免新上传的资源全部被算进去。
  const soon = Date.now() + 3 * 86400000;
  const accessStatus = { public: 0, active: 0, expiringSoon: 0, expired: 0, unconfigured: 0 };
  for (const item of current) {
    const access = previewAccess.info(item);
    if (!access.required) accessStatus.public++;
    else if (!access.configured) accessStatus.unconfigured++;
    else if (access.expired) accessStatus.expired++;
    else {
      accessStatus.active++;
      if (access.expiresAt && Date.parse(access.expiresAt) <= soon) accessStatus.expiringSoon++;
    }
  }
  const result = visits.summary({ from: query.from, to: query.to, ...filters }, current);
  return { ...result, timezone: config.statistics.timezone, filters, current: current.length, accessStatus };
}

app.get('/admin/statistics', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'statistics.html'));
});
for (const [route, query] of [
  ['/admin/api/statistics', req => statistics.summary(req.query)],
  ['/admin/api/statistics/day', req => statistics.day(req.query)],
  ['/admin/api/statistics/visits', req => visitSummary(req.query)],
]) {
  app.get(route, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, requireAdmin, (req, res, next) => {
    try { res.json(query(req)); }
    catch (error) {
      if (error.status === 400) return res.status(400).json({ error: error.message });
      next(error);
    }
  });
}

app.get('/admin/login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/admin/login', requireSameOrigin, (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const limit = adminLogin.check(req);
  if (!limit.allowed) {
    res.set('Retry-After', String(limit.retryAfter));
    const page = fs.readFileSync(path.join(__dirname, 'views', 'login.html'), 'utf8')
      .replace('data-login-retry-after="0"', `data-login-retry-after="${limit.retryAfter}"`);
    return res.status(429).type('html').send(page);
  }
  const { user, password } = req.body || {};
  const userMatches = typeof user === 'string' && constantEqual(user, config.admin.user);
  const passwordMatches = typeof password === 'string' && constantEqual(password, config.admin.password);
  if (userMatches && passwordMatches && config.admin.password) {
    adminLogin.succeeded(req);
    return req.session.regenerate(error => {
      if (error) return next(error);
      req.session.user = user;
      req.session.save(error => error ? next(error) : res.redirect('/admin'));
    });
  }
  adminLogin.failed(req);
  res.redirect('/admin/login?error=1');
});

app.post('/admin/logout', (req, res) => {
  // 同时清掉会话 cookie，否则退出后的预览仍会被当作管理员访问而不计入打开次数。
  req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect('/admin/login'); });
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});
// 管理页的样式和脚本，与页面一样需要登录。
for (const asset of ['admin.css', 'admin.js']) {
  app.get(`/admin/${asset}`, requireAdmin, (_req, res) => {
    res.sendFile(path.join(__dirname, 'views', asset));
  });
}

async function changeAccess(req, res) {
  const meta = store.readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (req.account && req.account.name !== meta.source) return res.status(403).json({ error: 'forbidden' });
  try {
    const result = await previewAccess.update(meta, req.body);
    const latest = store.readMeta(meta.id);
    if (!latest) return res.status(404).json({ error: 'not found' });
    const updated = { ...latest, access: result.policy };
    store.writeMeta(meta.id, updated);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, access: previewAccess.info(updated), accessCode: result.code });
  } catch (error) { res.status(400).json({ error: error.message }); }
}
app.patch('/admin/api/item/:id/access', requireAdmin, requireSameOrigin, changeAccess);
app.get('/admin/api/item/:id/access-code', requireAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const meta = store.readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  const access = previewAccess.info(meta);
  if (!access.required) return res.status(409).json({ error: 'public', access });
  const code = previewAccess.reveal(meta);
  if (!code) return res.status(409).json({ error: 'not recoverable', access });
  res.json({ accessCode: code, access, url: `${config.baseUrl}/v/${meta.id}` });
});
app.patch('/api/me/items/:id/access', requireToken, changeAccess);

// 修改分类元数据：只更新请求中出现的字段；description 置空时回退为页面标题。
function changeLabels(req, res) {
  const meta = store.readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (req.account && req.account.name !== meta.source) return res.status(403).json({ error: 'forbidden' });
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const editable = [...classification.FIELDS, 'description'];
  if (!editable.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    return res.status(400).json({ error: `no editable fields (${editable.join(', ')})` });
  }
  const updated = { ...meta, ...classification.applyPatch(meta, body) };
  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    updated.description = metadata.descriptionForUpload(store.filePath(meta), meta.type, body.description);
  }
  store.writeMeta(meta.id, updated);
  res.json({ ok: true, item: mapItem(updated) });
}
app.patch('/admin/api/item/:id/meta', requireAdmin, requireSameOrigin, changeLabels);

// 批量整理：对最多 100 个资源设置分类 / 项目，或追加标签；未出现的字段保持原值。
app.patch('/admin/api/items/meta', requireAdmin, requireSameOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length || ids.length > 100) return res.status(400).json({ error: 'ids must contain 1-100 items' });
  if (ids.some((id) => !store.isValidId(id))) return res.status(400).json({ error: 'bad id' });
  const patch = {};
  for (const field of ['category', 'project']) {
    if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field];
  }
  const addTags = classification.normalizeTags(body.addTags);
  if (!Object.keys(patch).length && !addTags.length) {
    return res.status(400).json({ error: 'nothing to change (category, project, addTags)' });
  }
  let updated = 0;
  let missing = 0;
  for (const id of ids) {
    const meta = store.readMeta(id);
    if (!meta) { missing++; continue; }
    const labels = classification.applyPatch(meta, patch);
    if (addTags.length) labels.tags = classification.normalizeTags([...labels.tags, ...addTags]);
    store.writeMeta(id, { ...meta, ...labels });
    updated++;
  }
  res.json({ ok: true, updated, missing });
});
app.patch('/api/me/items/:id/meta', requireToken, changeLabels);

app.get('/admin/api/list', requireAdmin, (req, res) => {
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const filters = listFilters(req.query);
  const sort = ['time', 'name', 'size', 'type', 'source', 'category', 'project', 'agent', 'views', 'viewed'].includes(req.query.sort)
    ? req.query.sort
    : 'time';
  const order = req.query.order === 'asc' ? 'asc' : 'desc';

  const indexed = resourceIndex.listPage({ page: requestedPage, pageSize, sort, order, ...filters });
  if (indexed) {
    return res.json({
      ...indexed,
      items: withVisits(indexed.items.map(mapItem)),
      visitsAvailable: resourceIndex.hasVisits(),
      visitsSince: visits.startedAt(),
      sources: resourceIndex.sources() || [],
      categories: classification.CATEGORIES,
      facets: resourceIndex.facets() || {},
    });
  }

  const all = withVisits(store.listAll().map(mapItem));
  const sources = [...new Set(all.map((item) => item.source).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
  const filtered = all.filter((item) => matchesFilters(item, filters));
  const direction = order === 'asc' ? 1 : -1;
  const sortKey = { name: 'filename', size: 'size', type: 'type', source: 'source',
    category: 'category', project: 'project', agent: 'agent' }[sort];
  filtered.sort((a, b) => {
    let left;
    let right;
    if (sort === 'size') {
      left = Number(a.size) || 0;
      right = Number(b.size) || 0;
    } else if (sort === 'views') {
      left = a.visits.views;
      right = b.visits.views;
    } else if (sort === 'viewed') {
      left = a.visits.lastViewedAt || '';
      right = b.visits.lastViewedAt || '';
    } else if (sortKey) {
      left = String(a[sortKey] || '');
      right = String(b[sortKey] || '');
    } else {
      left = new Date(a.createdAt).getTime() || 0;
      right = new Date(b.createdAt).getTime() || 0;
    }
    let result;
    if (typeof left === 'string') result = left.localeCompare(right, 'zh');
    else result = left - right;
    return result === 0 ? String(a.id).localeCompare(String(b.id)) * direction : result * direction;
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  res.json({
    items: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
    sources,
    categories: classification.CATEGORIES,
    facets: countFacets(all),
    visitsAvailable: visits.isAvailable(),
    visitsSince: visits.startedAt(),
  });
});

app.delete('/admin/api/item/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!store.isValidId(id)) return res.status(400).json({ error: 'bad id' });
  const ok = store.remove(id);
  res.json({ ok });
});

// 批量删除用于资源较多时的日常清理；每次最多处理 100 个合法 id。
app.delete('/admin/api/items', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  if (!ids.length || ids.length > 100) {
    return res.status(400).json({ error: 'ids must contain 1-100 items' });
  }
  const uniqueIds = [...new Set(ids.map((id) => String(id)))];
  if (uniqueIds.some((id) => !store.isValidId(id))) {
    return res.status(400).json({ error: 'bad id' });
  }
  let deleted = 0;
  let missing = 0;
  for (const id of uniqueIds) {
    if (store.remove(id)) deleted++;
    else missing++;
  }
  res.json({ ok: true, deleted, missing });
});

// 账户列表 + 用量
app.get('/admin/api/accounts', requireAdmin, (req, res) => {
  res.json({
    accounts: accounts.listAccountsWithUsage(),
    defaults: {
      retentionDays: config.storage.retentionDays,
      maxSizeMb: config.storage.maxSizeMb,
    },
  });
});

// 启用 / 停用账户（写入 data/account-state.json，不改 config.yaml）
app.post('/admin/api/accounts/:name/disable', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = accounts.setDisabled(name, true);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.post('/admin/api/accounts/:name/enable', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = accounts.setDisabled(name, false);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

// ---- 首页 ----
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'home.html'));
});

// ---- 启动 ----
startCleanupScheduler();
// 退出前把内存中的访问计数写入磁盘（PM2 重启发送 SIGINT）。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    visits.stop();
    process.exit(0);
  });
}
app.listen(config.port, () => {
  const mode = config.preview.proxyToRender
    ? `preview→${config.preview.renderUrl}`
    : 'preview=local';
  console.log(`[vibeview] 已启动 → ${config.baseUrl} (端口 ${config.port}, ${mode})`);
});
