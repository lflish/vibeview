const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const store = require('./lib/store');
const accounts = require('./lib/accounts');
const metadata = require('./lib/metadata');
const resourceIndex = require('./lib/resource-index');
const { startCleanupScheduler } = require('./lib/cleanup');
const { mountPreviewRoutes } = require('./lib/preview-routes');
const { createPreviewProxy } = require('./lib/preview-proxy');
const { createPreviewAccess } = require('./lib/preview-access');
const previewAccess = createPreviewAccess({ store, options: config.access, secureCookie: config.baseUrl.startsWith('https://') });

const app = express();
app.disable('x-powered-by');

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
    createdAt: m.createdAt,
    access: previewAccess.info(store.readMeta(m.id) || m),
    url: `${config.baseUrl}/v/${m.id}`,
  };
}

// 启动时把已有 JSON 元数据迁移/修复到 SQLite 索引；JSON 仍是权威数据源。
resourceIndex.rebuild(store.listAll().map((item) => ({
  ...item,
  description: item.description || metadata.descriptionFromFile(store.filePath(item), item.type),
})));

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
    const meta = {
      access: createdAccess.policy,
      id,
      type: req.uploadType,
      filename,
      mime: req.file.mimetype,
      size: req.file.size,
      source: req.uploadSource,
      description: metadata.descriptionForUpload(
        store.filePath({ id, type: req.uploadType, filename }),
        req.uploadType,
        req.body && req.body.description
      ),
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
      access: previewAccess.info(meta), accessCode: createdAccess.code });
  });
});

// ---- A2. 账户自助（Bearer token，只能管自己的资源） ----
app.get('/api/me', requireToken, (req, res) => {
  res.json({ account: accounts.publicAccountInfo(req.account) });
});

app.get('/api/me/items', requireToken, (req, res) => {
  const items = store.listBySource(req.account.name).map(mapItem);
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
  const ok = store.remove(id);
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

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/admin/login', (req, res) => {
  const { user, password } = req.body || {};
  if (user === config.admin.user && password === config.admin.password && config.admin.password) {
    req.session.user = user;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin.html'));
});

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
app.patch('/api/me/items/:id/access', requireToken, changeAccess);

app.get('/admin/api/list', requireAdmin, (req, res) => {
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
  const requestedPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const q = String(req.query.q || '').trim().slice(0, 120).toLowerCase();
  const type = ['html', 'image', 'video'].includes(req.query.type) ? req.query.type : '';
  const source = String(req.query.source || '').trim().slice(0, 120);
  const sort = ['time', 'name', 'size', 'type', 'source'].includes(req.query.sort)
    ? req.query.sort
    : 'time';
  const order = req.query.order === 'asc' ? 'asc' : 'desc';

  const indexed = resourceIndex.listPage({ page: requestedPage, pageSize, q, type, source, sort, order });
  if (indexed) {
    return res.json({
      ...indexed,
      items: indexed.items.map(mapItem),
      sources: resourceIndex.sources() || [],
    });
  }

  const all = store.listAll().map(mapItem);
  const sources = [...new Set(all.map((item) => item.source).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh'));
  const filtered = all.filter((item) => {
    if (type && item.type !== type) return false;
    if (source && item.source !== source) return false;
    if (q) {
      const haystack = [item.filename, item.description, item.source, item.id, item.type, item.url]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const direction = order === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    let left;
    let right;
    if (sort === 'name') {
      left = String(a.filename || '');
      right = String(b.filename || '');
    } else if (sort === 'size') {
      left = Number(a.size) || 0;
      right = Number(b.size) || 0;
    } else if (sort === 'type') {
      left = String(a.type || '');
      right = String(b.type || '');
    } else if (sort === 'source') {
      left = String(a.source || '');
      right = String(b.source || '');
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
  res
    .type('html')
    .send(
      '<h1>vibeview</h1><p>通用预览服务。上传见 README，管理端 <a href="/admin">/admin</a>。</p>'
    );
});

// ---- 启动 ----
startCleanupScheduler();
app.listen(config.port, () => {
  const mode = config.preview.proxyToRender
    ? `preview→${config.preview.renderUrl}`
    : 'preview=local';
  console.log(`[vibeview] 已启动 → ${config.baseUrl} (端口 ${config.port}, ${mode})`);
});
