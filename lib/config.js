const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(__dirname, '..', 'config.yaml');

if (!fs.existsSync(CONFIG_PATH)) {
  console.error('[config] 找不到 config.yaml，请先执行: cp config.example.yaml config.yaml 并填入配置');
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

function resolveDir(p, fallback) {
  return path.resolve(__dirname, '..', p || fallback);
}

const config = {
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
};

if (config.tokens.length === 0) {
  console.warn('[config] 警告: 未配置任何 token，上传接口将无法使用');
}
if (!config.admin.password) {
  console.warn('[config] 警告: 未设置管理端密码 admin.password');
}

// 用上传 token 反查来源名称，找不到返回 null
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
