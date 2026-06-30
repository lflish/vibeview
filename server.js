const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const store = require('./lib/store');
const viewer = require('./lib/viewer');
const { startCleanupScheduler } = require('./lib/cleanup');

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

// ---- 上传 token 鉴权中间件 ----
function requireToken(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const found = m ? config.findToken(m[1].trim()) : null;
  if (!found) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.uploadSource = found.name || 'unknown';
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

// ---- A. 上传接口 ----
app.post('/upload', requireToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'file too large' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'no file (field name must be "file")' });

    const id = req.uploadId;
    const filename = safeFilename(req.file.originalname);
    const meta = {
      id,
      type: req.uploadType,
      filename,
      mime: req.file.mimetype,
      size: req.file.size,
      source: req.uploadSource,
      createdAt: new Date().toISOString(),
    };
    store.writeMeta(id, meta);
    res.json({ url: `${config.baseUrl}/v/${id}` });
  });
});

// ---- B. 预览接口（公开） ----
app.get('/v/:id', (req, res) => {
  const { id } = req.params;
  if (!store.isValidId(id)) return res.status(404).send('Not found');
  const meta = store.readMeta(id);
  if (!meta) return res.status(404).send('Not found');

  if (meta.type === 'html') {
    res.type('html');
    return res.sendFile(store.filePath(meta));
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

app.get('/v/:id/raw', (req, res) => {
  const { id } = req.params;
  if (!store.isValidId(id)) return res.status(404).send('Not found');
  const meta = store.readMeta(id);
  if (!meta) return res.status(404).send('Not found');
  res.type(meta.mime || 'application/octet-stream');
  res.sendFile(store.filePath(meta));
});

// ---- C. 管理端（session 登录） ----
app.use(
  session({
    secret: config.admin.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
  })
);
app.use(express.urlencoded({ extended: false }));

function requireAdmin(req, res, next) {
  if (req.session && req.session.user) return next();
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

app.get('/admin/api/list', requireAdmin, (req, res) => {
  const items = store.listAll().map((m) => ({
    id: m.id,
    type: m.type,
    filename: m.filename,
    size: m.size,
    source: m.source,
    createdAt: m.createdAt,
    url: `${config.baseUrl}/v/${m.id}`,
  }));
  res.json({ items });
});

app.delete('/admin/api/item/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!store.isValidId(id)) return res.status(400).json({ error: 'bad id' });
  const ok = store.remove(id);
  res.json({ ok });
});

// ---- 首页 ----
app.get('/', (req, res) => {
  res.type('html').send('<h1>vibeview</h1><p>通用预览服务。上传见 README，管理端 <a href="/admin">/admin</a>。</p>');
});

// ---- 启动 ----
startCleanupScheduler();
app.listen(config.port, () => {
  console.log(`[vibeview] 已启动 → ${config.baseUrl} (端口 ${config.port})`);
});
