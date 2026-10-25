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
const { extractSite, SiteArchiveError } = require('./lib/site-archive');
const versions = require('./lib/versions');
const { createLocks } = require('./lib/locks');
const { createTemplates, TemplateError } = require('./lib/templates');
const templateSchema = require('./lib/template-schema');
const { render: renderTemplate } = require('./lib/template-render');
const xlsx = require('./lib/xlsx');
const templates = createTemplates({ directory: config.storage.templateDir });
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

// HTTPS 访问时开启 HSTS，避免之后再经明文 http 访问；管理端禁止被嵌入其他页面。
app.use((req, res, next) => {
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (req.path === '/admin' || req.path.startsWith('/admin/')) {
    res.set({
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
  }
  next();
});

// 确保存储目录存在
for (const d of [
  config.storage.htmlDir,
  config.storage.imageDir,
  config.storage.videoDir,
  config.storage.siteDir,
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
// 站点 zip 先落在 <site_dir>/.incoming/<id>.zip，解压到 <site_dir>/<id>/ 后删除。
const incomingDir = path.join(config.storage.siteDir, '.incoming');
function incomingZip(id) {
  return path.join(incomingDir, `${id}.zip`);
}
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const type = store.typeForMime(file.mimetype, file.originalname);
    if (!type) return cb(new Error('unsupported file type'));
    if (!req.uploadId) req.uploadId = store.newId();
    req.uploadType = type;
    const dir = type === 'site' ? incomingDir : store.fileDir(type, req.uploadId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, req.uploadType === 'site' ? path.basename(incomingZip(req.uploadId)) : safeFilename(file.originalname));
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
  // 索引行不含站点的 zip 名、文件数和版本信息，从元数据补齐
  const full = store.readMeta(m.id) || m;
  const description = m.description || metadata.descriptionFromFile(store.filePath(full.type === 'site' ? { ...full, filename: 'index.html' } : full), m.type);
  return {
    id: m.id,
    type: m.type,
    // 站点显示上传的 zip 名；入口固定是 index.html
    filename: m.type === 'site' ? full.archiveName || 'site.zip' : full.filename,
    ...(m.type === 'site' ? { fileCount: full.fileCount } : {}),
    size: m.size,
    source: m.source,
    description,
    ...classification.normalize(m),
    createdAt: m.createdAt,
    ...versions.summary(full),
    ...(full.template ? { template: { id: full.template.id, name: full.template.name, version: full.template.version } } : {}),
    exportable: !!(full.features && full.features.export && full.features.export.xlsx),
    access: previewAccess.info(full),
    url: `${config.baseUrl}/v/${m.id}`,
  };
}

// ---- 资源版本 ----
// 同一资源的更新、删版本串行执行，避免两次更新拿到同一个版本号。
const withVersionLock = createLocks();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 本次上传的版本说明与 git 信息（CLI 在 git 仓库里自动带上）
function versionNote(body = {}) {
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : '';
  const commit = typeof body.git_commit === 'string' ? body.git_commit.trim().toLowerCase() : '';
  const git = /^[0-9a-f]{7,40}$/.test(commit) ? { commit, dirty: ['1', 'true'].includes(String(body.git_dirty)) } : null;
  return { ...(message ? { message } : {}), ...(git ? { git } : {}) };
}

function previewUrl(meta, n) {
  const site = meta.type === 'site' ? '/' : '';
  return n === undefined || n === versions.current(meta)
    ? `${config.baseUrl}/v/${meta.id}${site}`
    : `${config.baseUrl}/v/${meta.id}/@${n}${site}`;
}

function versionList(meta) {
  const current = versions.current(meta);
  return {
    id: meta.id,
    type: meta.type,
    current,
    versions: versions.list(meta).map((entry) => ({
      n: entry.n,
      filename: meta.type === 'site' ? entry.archiveName || 'site.zip' : entry.filename,
      size: Number(entry.size) || 0,
      ...(meta.type === 'site' ? { fileCount: entry.fileCount } : {}),
      createdAt: entry.createdAt,
      message: entry.message || '',
      git: entry.git || null,
      current: entry.n === current,
      url: previewUrl(meta, entry.n),
    })),
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
    type: ['html', 'image', 'video', 'site'].includes(query.type) ? query.type : '',
    source: text(query.source),
    category: category === 'none' ? 'none' : classification.normalizeCategory(category),
    agent: classification.normalizeLabel(text(query.agent)),
    project: text(query.project) === '-' ? '-' : classification.normalizeLabel(text(query.project)),
    tag: classification.normalizeTags(text(query.tag))[0] || '',
    visit: ['never', 'stale30', 'recent7'].includes(query.visit) ? query.visit : '',
    template: /^[0-9A-Za-z]{16}$/.test(String(query.template || '')) ? String(query.template) : '',
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
  if (f.template && !(item.template && item.template.id === f.template)) return false;
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

// 上传失败时清掉已落盘的临时目录（站点还有待解压的 zip）
function cleanupFailedUpload(req) {
  if (!req.uploadId || !req.uploadType) return;
  if (req.uploadType === 'site') fs.rmSync(incomingZip(req.uploadId), { force: true });
  if (req.siteExtracted === false) return; // 解压目录不是本次创建的，不能删
  const dir = store.fileDir(req.uploadType, req.uploadId);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 更新目标的检查：只能更新自己的资源，类型不能变。返回 [状态码, 错误] 或 null。
function updateProblem(account, id, type) {
  if (!store.isValidId(id)) return [400, 'bad id'];
  const target = store.readMeta(id);
  if (!target) return [404, 'not found'];
  if (target.source !== account.name) return [403, 'forbidden: not your resource'];
  if (target.type !== type) return [400, `type mismatch: resource is ${target.type}, upload is ${type}`];
  return null;
}

// 新资源的访问策略：默认需要访问码；body 可指定 access_mode / access_days
async function accessPolicyFor(body) {
  const mode = body.access_mode;
  if (mode !== undefined && !['public', 'code'].includes(mode)) throw httpError(400, 'invalid access_mode');
  const days = body.access_days === undefined ? config.access.defaultDays : Number(body.access_days);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw httpError(400, 'access_days must be 1-3650');
  return mode === undefined && body.access_days === undefined
    ? previewAccess.initialPolicy()
    : previewAccess.update({}, { mode: mode || 'code', expiresAt: new Date(Date.now() + days * 86400000).toISOString() });
}

// 元数据里"当前版本用的模板与功能"跟随当前版本
function templateFields(meta, entry) {
  const next = { ...meta };
  if (entry.template) next.template = entry.template; else delete next.template;
  if (entry.features && Object.keys(entry.features).length) next.features = entry.features; else delete next.features;
  return next;
}

function uploadResponse(meta, extra = {}) {
  const site = meta.type === 'site';
  return {
    url: previewUrl(meta), id: meta.id, type: meta.type,
    ...(site ? { fileCount: meta.fileCount, size: versions.find(meta, versions.current(meta)).size } : {}),
    source: meta.source, description: meta.description, version: versions.current(meta),
    ...(meta.template ? { template: { name: meta.template.name, version: meta.template.version } } : {}),
    ...classification.normalize(meta), access: previewAccess.info(meta), ...extra,
  };
}

/**
 * 写入一个新资源或新版本。文件已经落在 store.fileDir(type, stagedId)。
 * ctx: { account, type, stagedId, body, cleanup, labelDefaults }
 * entry: 版本记录（filename、mime、size、createdAt、message、git、template、features…）
 */
async function saveResource(res, ctx, entry) {
  const targetId = typeof ctx.body.id === 'string' ? ctx.body.id.trim() : '';
  try {
    const q = accounts.checkQuota(ctx.account, entry.size, { newResource: !targetId });
    if (!q.ok) throw httpError(q.status || 429, q.error);
    if (targetId) {
      const problem = updateProblem(ctx.account, targetId, ctx.type);
      if (problem) throw httpError(problem[0], problem[1]);
      return await updateResource(res, ctx, targetId, entry);
    }
    const id = ctx.stagedId;
    const created = await accessPolicyFor(ctx.body);
    const storedPath = path.join(store.fileDir(ctx.type, id), entry.filename);
    const meta = templateFields({
      access: created.policy,
      id,
      type: ctx.type,
      filename: entry.filename,
      mime: entry.mime,
      size: entry.size,
      ...(ctx.type === 'site' ? { archiveName: entry.archiveName, fileCount: entry.fileCount } : {}),
      source: ctx.account.name,
      description: metadata.descriptionForUpload(storedPath, ctx.type, ctx.body.description),
      ...classification.forUpload(storedPath, ctx.type, { ...(ctx.labelDefaults || {}), ...nonEmpty(ctx.body) }),
      createdAt: entry.createdAt,
      current: 1,
      versions: [{ n: 1, ...entry }],
    }, entry);
    try { store.writeMeta(id, meta); } catch { throw httpError(500, 'unable to save upload metadata'); }
    res.set('Cache-Control', 'no-store');
    res.json(uploadResponse(meta, { updated: false, accessCode: created.code }));
  } catch (error) {
    ctx.cleanup();
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('[upload] save failed:', error.message);
    res.status(500).json({ error: 'unable to save upload' });
  }
}

function nonEmpty(body) {
  return Object.fromEntries(Object.entries(body || {}).filter(([, value]) => value !== '' && value !== undefined && value !== null));
}

// ---- A. 上传接口 ----
app.post('/upload', requireToken, (req, res) => {
  // 配额在文件落盘后检查：表单里的 id（更新已有资源）要等 multer 解析完才知道，更新不占文件数。
  upload(req, res, async (err) => {
    if (err) {
      cleanupFailedUpload(req);
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'file too large' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'no file (field name must be "file")' });
    const fail = (status, error) => { cleanupFailedUpload(req); return res.status(status).json({ error }); };

    // 带 id 表示更新这个资源：先检查，避免白白解压站点
    const targetId = typeof req.body.id === 'string' ? req.body.id.trim() : '';
    if (targetId) {
      const problem = updateProblem(req.account, targetId, req.uploadType);
      if (problem) return fail(problem[0], problem[1]);
    }

    // 自由排版的模板：只记录模板和默认分类，不改动上传的文件
    let template = null;
    const templateName = typeof req.body.template === 'string' ? req.body.template.trim() : '';
    if (templateName) {
      const found = templates.find(req.account, templateName);
      if (!found) return fail(404, `template not found: ${templateName}`);
      const manifest = templates.current(found).manifest;
      if (manifest.layout) return fail(400, `template ${templateName} has a fixed layout; use dview render ${templateName} --data <file>`);
      if (req.uploadType !== 'html' && req.uploadType !== 'site') return fail(400, 'templates apply to HTML pages and sites only');
      template = { found, manifest };
    }

    // 站点：解压后按解压总大小计配额
    let site = null;
    if (req.uploadType === 'site') {
      try {
        req.siteExtracted = false;
        site = await extractSite(incomingZip(req.uploadId), store.fileDir('site', req.uploadId), {
          maxFiles: config.storage.siteMaxFiles,
          maxBytes: config.storage.siteMaxUnpackedMb * 1024 * 1024,
        });
        req.siteExtracted = true;
      } catch (error) {
        cleanupFailedUpload(req);
        if (error instanceof SiteArchiveError) return res.status(400).json({ error: error.message });
        console.error('[upload] site extraction failed:', error.message);
        return res.status(500).json({ error: 'unable to unpack site' });
      } finally {
        fs.rmSync(incomingZip(req.uploadId), { force: true });
      }
    }

    const entry = {
      filename: site ? 'index.html' : safeFilename(req.file.originalname),
      mime: site ? 'text/html' : req.file.mimetype,
      size: site ? site.size : req.file.size,
      ...(site ? { archiveName: safeFilename(req.file.originalname), fileCount: site.fileCount } : {}),
      createdAt: new Date().toISOString(),
      ...versionNote(req.body),
      ...(template ? { template: { id: template.found.id, name: template.found.name, version: template.found.current } } : {}),
    };
    saveResource(res, {
      account: req.account,
      type: req.uploadType,
      stagedId: req.uploadId,
      body: req.body,
      cleanup: () => cleanupFailedUpload(req),
      labelDefaults: template ? { category: template.manifest.category, tags: template.manifest.tags } : null,
    }, entry);
  });
});

// 更新已有资源：把本次上传（已落在临时 id 目录）整体移到 <资源目录>/.versions/<n>/，再写元数据。
// 访问码、分类保持不变；只覆盖本次请求里出现的分类字段。描述原本取自页面标题时跟随新版本更新。
// 失败时抛出带 status 的错误，由 saveResource 清理临时目录。
async function updateResource(res, ctx, id, entry) {
  const staged = store.fileDir(ctx.type, ctx.stagedId);
  let placed = null;
  try {
    const updated = await withVersionLock(id, () => {
      const meta = store.readMeta(id);
      if (!meta || meta.source !== ctx.account.name || meta.type !== ctx.type) throw httpError(409, 'resource changed during upload');
      const existing = versions.list(meta);
      const n = Math.max(...existing.map((item) => item.n)) + 1;
      if (n > versions.MAX_VERSION) throw httpError(409, 'too many versions');
      const dest = store.versionDir(meta, n);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staged, dest);
      placed = dest;

      const { kept, removed } = versions.prune([...existing, { n, ...entry }], config.versions.maxPerResource, n);
      const patch = {};
      for (const field of classification.FIELDS) {
        if (Object.prototype.hasOwnProperty.call(ctx.body, field)) patch[field] = ctx.body[field];
      }
      const newFile = path.join(dest, entry.filename);
      const oldTitle = metadata.descriptionFromFile(store.filePath(meta), meta.type);
      let description = meta.description;
      if (Object.prototype.hasOwnProperty.call(ctx.body, 'description')) {
        description = metadata.descriptionForUpload(newFile, meta.type, ctx.body.description);
      } else if (!meta.description || meta.description === oldTitle) {
        description = metadata.descriptionFromFile(newFile, meta.type) || meta.description;
      }
      const next = templateFields({
        ...meta,
        ...classification.applyPatch(meta, patch),
        filename: entry.filename,
        mime: entry.mime,
        ...(meta.type === 'site' ? { archiveName: entry.archiveName, fileCount: entry.fileCount } : {}),
        size: versions.totalSize(kept),
        description,
        current: n,
        versions: kept,
        updatedAt: entry.createdAt,
      }, entry);
      store.writeMeta(id, next);
      placed = null;
      for (const old of removed) fs.rmSync(store.versionDir(meta, old.n), { recursive: true, force: true });
      return next;
    });
    res.set('Cache-Control', 'no-store');
    // 固定链接始终显示最新版；versionUrl 是这一版的永久地址
    const versionUrl = `${config.baseUrl}/v/${id}/@${updated.current}${updated.type === 'site' ? '/' : ''}`;
    res.json(uploadResponse(updated, { updated: true, versionUrl }));
  } catch (error) {
    if (placed) fs.rmSync(placed, { recursive: true, force: true });
    throw error;
  }
}

// 版本列表与删除：账户只能管自己的资源；当前版本和第 1 版不能删。
function listVersions(req, res) {
  const meta = store.readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (req.account && req.account.name !== meta.source) return res.status(403).json({ error: 'forbidden: not your resource' });
  res.set('Cache-Control', 'no-store');
  res.json(versionList(meta));
}

async function deleteVersion(req, res) {
  const { id } = req.params;
  const n = /^[1-9]\d{0,5}$/.test(req.params.n) ? Number(req.params.n) : null;
  if (!store.isValidId(id) || n === null) return res.status(400).json({ error: 'bad id or version' });
  try {
    const updated = await withVersionLock(id, () => {
      const meta = store.readMeta(id);
      if (!meta) throw httpError(404, 'not found');
      if (req.account && req.account.name !== meta.source) throw httpError(403, 'forbidden: not your resource');
      if (!versions.find(meta, n)) throw httpError(404, 'version not found');
      if (n === versions.current(meta)) throw httpError(400, 'cannot delete the current version');
      if (n === 1) throw httpError(400, 'the first version is always kept');
      const kept = versions.list(meta).filter((entry) => entry.n !== n);
      const next = { ...meta, versions: kept, size: versions.totalSize(kept) };
      store.writeMeta(id, next);
      fs.rmSync(store.versionDir(meta, n), { recursive: true, force: true });
      return next;
    });
    res.json({ ok: true, ...versionList(updated) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('[versions] delete failed:', error.message);
    res.status(500).json({ error: 'unable to delete version' });
  }
}

// ---- A2. 账户自助（Bearer token，只能管自己的资源） ----
app.get('/api/me', requireToken, (req, res) => {
  res.json({ account: accounts.publicAccountInfo(req.account) });
});

app.get('/api/me/items', requireToken, (req, res) => {
  const filters = listFilters(req.query);
  const items = withVisits(store.listBySource(req.account.name).map(mapItem)).filter((item) => matchesFilters(item, filters));
  res.json({ items, account: accounts.publicAccountInfo(req.account) });
});

app.get('/api/me/items/:id/versions', requireToken, listVersions);
app.delete('/api/me/items/:id/versions/:n', requireToken, deleteVersion);

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

// ---- A3. 页面模板（Bearer token）：自己的模板 + 全局模板 ----
// 模板包和渲染数据可能较大，用单独的 JSON 解析器（全局的 express.json 在后面，默认 100 KB）。
const TEMPLATE_DATA_FILE = '.dview-data.json';
const parseTemplateJson = express.json({ limit: '8mb' });
function templateJson(req, res, next) {
  parseTemplateJson(req, res, (error) => {
    if (!error) return next();
    res.status(error.status || 400).json({ error: error.type === 'entity.too.large' ? 'request too large (max 8 MB)' : 'invalid JSON body' });
  });
}
function templateFailure(res, error) {
  if (error instanceof TemplateError || error.status) {
    return res.status(error.status || 400).json({ error: error.message, ...(error.details ? { details: error.details } : {}) });
  }
  console.error('[templates]', error.message);
  res.status(500).json({ error: 'template operation failed' });
}
function jsonBody(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}

app.get('/api/templates', requireToken, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ templates: templates.list(req.account) });
});
app.get('/api/templates/match', requireToken, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 2000) : '';
  res.set('Cache-Control', 'no-store');
  res.json({ query: q, templates: templates.match(req.account, q) });
});
app.get('/api/templates/:name', requireToken, (req, res) => {
  const found = templates.find(req.account, req.params.name);
  if (!found) return res.status(404).json({ error: 'template not found' });
  res.set('Cache-Control', 'no-store');
  res.json(templates.detail(found, req.account));
});
app.get('/api/templates/:name/files', requireToken, (req, res) => {
  const found = templates.find(req.account, req.params.name);
  if (!found) return res.status(404).json({ error: 'template not found' });
  res.set('Cache-Control', 'no-store');
  res.json({ name: found.name, version: found.current, files: templates.readFiles(found) });
});
app.put('/api/templates/:name', requireToken, templateJson, async (req, res) => {
  const body = jsonBody(req);
  try {
    const result = await templates.push(req.account, req.params.name, body.files, {
      message: body.message,
      global: typeof body.global === 'boolean' ? body.global : undefined,
    });
    res.json(result);
  } catch (error) { templateFailure(res, error); }
});
app.delete('/api/templates/:name', requireToken, async (req, res) => {
  try { res.json(await templates.remove(req.account, req.params.name)); } catch (error) { templateFailure(res, error); }
});

// 渲染并上传：校验数据 → 嵌入模板 → 和普通上传一样新建资源或生成新版本（body.id）。
// dry_run 只返回 HTML，不保存。
app.post('/api/templates/:name/render', requireToken, templateJson, (req, res) => {
  const body = jsonBody(req);
  const found = templates.find(req.account, req.params.name);
  if (!found) return res.status(404).json({ error: 'template not found' });
  const { manifest } = templates.current(found);
  if (!manifest.layout) return res.status(400).json({ error: `template ${found.name} has no fixed layout; generate the HTML yourself and upload it with --template ${found.name}` });
  if (!Object.prototype.hasOwnProperty.call(body, 'data')) return res.status(400).json({ error: 'data is required' });
  const files = templates.readFiles(found);
  const problems = templateSchema.validate(JSON.parse(files[manifest.schema]), body.data);
  if (problems.length) return res.status(422).json({ error: 'data does not match the template schema', details: problems });
  const { html, title } = renderTemplate({ layout: files[manifest.layout], data: body.data, pageTitle: manifest.pageTitle, features: manifest.features });
  const ref = { id: found.id, name: found.name, version: found.current };
  if (body.dry_run === true) {
    res.set('Cache-Control', 'no-store');
    return res.json({ html, title, template: ref });
  }
  const targetId = typeof body.id === 'string' ? body.id.trim() : '';
  if (targetId) {
    const problem = updateProblem(req.account, targetId, 'html');
    if (problem) return res.status(problem[0]).json({ error: problem[1] });
  }
  // 页面和数据一起落在临时目录，之后和普通上传走同一条路径
  const stagedId = store.newId();
  const dir = store.fileDir('html', stagedId);
  const filename = `${found.name}.html`;
  const dataText = JSON.stringify(body.data);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), html);
    fs.writeFileSync(path.join(dir, TEMPLATE_DATA_FILE), dataText);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    return templateFailure(res, error);
  }
  const fields = { ...body };
  delete fields.data;
  delete fields.dry_run;
  delete fields.template;
  saveResource(res, {
    account: req.account,
    type: 'html',
    stagedId,
    body: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'number' || typeof value === 'boolean' ? String(value) : value])),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    labelDefaults: { category: manifest.category, tags: manifest.tags },
  }, {
    filename,
    mime: 'text/html',
    size: Buffer.byteLength(html) + Buffer.byteLength(dataText),
    createdAt: new Date().toISOString(),
    ...versionNote(body),
    template: ref,
    features: manifest.features,
  });
});

// 导出 Excel：用这一版保存的数据和功能配置生成，和页面上"导出 Excel"得到的文件相同。
function exportXlsx(req, res) {
  const meta = store.readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'not found' });
  if (req.account && req.account.name !== meta.source) return res.status(403).json({ error: 'forbidden: not your resource' });
  const n = req.query.version === undefined ? versions.current(meta)
    : /^[1-9]\d{0,5}$/.test(String(req.query.version)) ? Number(req.query.version) : null;
  const entry = n === null ? null : versions.find(meta, n);
  if (!entry) return res.status(404).json({ error: 'version not found' });
  const spec = entry.features && entry.features.export && entry.features.export.xlsx;
  if (!spec) return res.status(409).json({ error: 'this page has no Excel export' });
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(store.versionDir(meta, n), TEMPLATE_DATA_FILE), 'utf8')); } catch {
    return res.status(409).json({ error: 'page data is missing' });
  }
  const bytes = xlsx.buildXlsx(xlsx.exportTable(data, spec));
  const name = String(meta.description || meta.id).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) + '.xlsx';
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
  });
  res.send(Buffer.from(bytes));
}
app.get('/api/me/items/:id/export.xlsx', requireToken, exportXlsx);

// ---- B. 预览接口：访问验证在直出与 sidecar 代理前统一执行 ----
app.post('/v/:id/unlock', express.urlencoded({ extended: false, limit: '4kb' }), previewAccess.unlock);
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
    // 'auto'：经 HTTPS（含反向代理转发的 X-Forwarded-Proto）登录时带 Secure，浏览器不会再经 http 发送。
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 12 * 60 * 60 * 1000 },
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
    type: ['html', 'image', 'video', 'site'].includes(query.type) ? query.type : '',
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

  // 索引里没有模板字段，按模板筛选时走下面的全量路径
  const indexed = filters.template ? null : resourceIndex.listPage({ page: requestedPage, pageSize, sort, order, ...filters });
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

app.get('/admin/api/item/:id/export.xlsx', requireAdmin, exportXlsx);

// 模板（管理员）：列表、测试触发、详情、示例预览、设为全局或取消。
// 使用情况按资源元数据统计：当前版本由哪个模板生成。
function templateUsage() {
  const usage = new Map();
  for (const meta of store.listAll()) {
    const id = meta.template && meta.template.id;
    if (!id) continue;
    const used = usage.get(id) || { pages: 0, lastUsedAt: null };
    used.pages += 1;
    const at = meta.updatedAt || meta.createdAt || null;
    if (at && (!used.lastUsedAt || at > used.lastUsedAt)) used.lastUsedAt = at;
    usage.set(id, used);
  }
  return usage;
}

app.get('/admin/api/templates', requireAdmin, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ templates: templates.adminList(templateUsage()) });
});
// 和该账户调用 GET /api/templates/match 的结果相同
app.get('/admin/api/templates/match', requireAdmin, (req, res) => {
  const account = accounts.findByName(typeof req.query.account === 'string' ? req.query.account : '');
  if (!account) return res.status(404).json({ error: 'account not found' });
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 2000) : '';
  res.set('Cache-Control', 'no-store');
  res.json({ query: q, account: account.name, templates: templates.match(account, q) });
});
app.get('/admin/api/templates/:id', requireAdmin, (req, res) => {
  const meta = templates.byId(req.params.id);
  if (!meta) return res.status(404).json({ error: 'template not found' });
  res.set('Cache-Control', 'no-store');
  res.json({ ...templates.detail(meta), ...templates.adminFields(meta, templateUsage()) });
});
// 用 example.json 渲染当前版本。模板由上传方编写，所以和预览页一样放进沙箱：
// 没有 allow-same-origin，页面脚本读不到管理端的 cookie，也调不了管理接口。
app.get('/admin/api/templates/:id/preview', requireAdmin, (req, res) => {
  const meta = templates.byId(req.params.id);
  if (!meta) return res.status(404).json({ error: 'template not found' });
  const { manifest } = templates.current(meta);
  if (!manifest.layout) return res.status(404).json({ error: 'free-layout template has no preview' });
  const files = templates.readFiles(meta);
  const data = manifest.example ? JSON.parse(files[manifest.example]) : {};
  const { html } = renderTemplate({ layout: files[manifest.layout], data, pageTitle: manifest.pageTitle, features: manifest.features });
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "sandbox allow-scripts; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    'X-Frame-Options': 'SAMEORIGIN',
    'Cache-Control': 'no-store',
  });
  res.send(html);
});
app.patch('/admin/api/templates/:id', requireAdmin, requireSameOrigin, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.global !== 'boolean') return res.status(400).json({ error: 'global must be true or false' });
  try { res.json(await templates.setGlobal(req.params.id, body.global)); } catch (error) { templateFailure(res, error); }
});
app.get('/admin/api/item/:id/versions', requireAdmin, listVersions);
app.delete('/admin/api/item/:id/versions/:n', requireAdmin, requireSameOrigin, deleteVersion);

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
app.listen(config.port, config.host, () => {
  const mode = config.preview.proxyToRender
    ? `preview→${config.preview.renderUrl}`
    : 'preview=local';
  console.log(`[vibeview] 已启动 → ${config.baseUrl} (${config.host || '*'}:${config.port}, ${mode})`);
});
