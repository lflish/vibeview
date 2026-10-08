const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 测试/冒烟可用 DVIEW_CONFIG_PATH 或 CONFIG_PATH 指向临时 config.yaml
const CONFIG_PATH = path.resolve(
  process.env.DVIEW_CONFIG_PATH || process.env.CONFIG_PATH || path.join(__dirname, '..', 'config.yaml')
);

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('[config] 找不到 config.yaml，请先执行: cp config.example.yaml config.yaml 并填入配置');
  console.error(`[config] 当前查找路径: ${CONFIG_PATH}`);
  process.exit(1);
}

let raw;
try {
  raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
} catch (e) {
  console.error('[config] 解析 config.yaml 失败:', e.message);
  process.exit(1);
}

const server = raw.server || {};
const storage = raw.storage || {};
const tokens = Array.isArray(raw.tokens) ? raw.tokens : [];
const admin = raw.admin || {};
const preview = raw.preview || {};

function resolveDir(p, fallback) {
  // 绝对路径原样使用；相对路径相对「配置文件所在目录」解析，便于冒烟隔离 data/
  const base = path.dirname(CONFIG_PATH);
  return path.resolve(base, p || fallback);
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const proxyToRender = envBool(
  'DVIEW_PREVIEW_PROXY',
  preview.proxy_to_render === true
);

const config = {
  configPath: CONFIG_PATH,
  port: server.port || 3000,
  baseUrl: (server.base_url || `http://localhost:${server.port || 3000}`).replace(/\/$/, ''),
  storage: {
    htmlDir: resolveDir(storage.html_dir, './data/html'),
    imageDir: resolveDir(storage.image_dir, './data/images'),
    videoDir: resolveDir(storage.video_dir, './data/videos'),
    metaDir: resolveDir(storage.meta_dir, './data/meta'),
    retentionDays: storage.retention_days || 7,
    maxSizeMb: storage.max_size_mb || 50,
  },
  tokens,
  admin: {
    user: admin.user || 'admin',
    password: admin.password || '',
    sessionSecret: admin.session_secret || 'change-me',
  },
  preview: {
    proxyToRender,
    renderUrl: (process.env.DVIEW_RENDER_URL || preview.render_url || 'http://127.0.0.1:3001').replace(
      /\/$/,
      ''
    ),
    proxyTimeoutMs: Number(preview.proxy_timeout_ms || 30000),
  },
};

if (config.tokens.length === 0) {
  console.warn('[config] 警告: 未配置任何 token，上传接口将无法使用');
} else {
  const names = new Set();
  for (const t of config.tokens) {
    const n = t && t.name;
    if (!n) {
      console.warn('[config] 警告: 存在未命名 token，建议为每个 token 设置唯一 name（即账户标识）');
      continue;
    }
    if (names.has(n)) {
      console.warn(`[config] 警告: token name 重复「${n}」，用量与配额会按同名合并`);
    }
    names.add(n);
  }
}
if (!config.admin.password) {
  console.warn('[config] 警告: 未设置管理端密码 admin.password');
}
if (config.preview.proxyToRender) {
  console.log(`[config] 预览反代已启用 → ${config.preview.renderUrl}`);
}

// 用上传 token 反查原始配置项（不含禁用/配额逻辑；鉴权请用 accounts.findActiveByToken）
config.findToken = function (token) {
  if (!token) return null;
  return config.tokens.find((t) => t.token === token) || null;
};

// 按 type 返回对应的存储根目录
config.dirForType = function (type) {
  if (type === 'html') return config.storage.htmlDir;
  if (type === 'image') return config.storage.imageDir;
  if (type === 'video') return config.storage.videoDir;
  return null;
};

module.exports = config;
