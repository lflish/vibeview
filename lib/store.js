const fs = require('fs');
const path = require('path');
const { customAlphabet } = require('nanoid');
const config = require('./config');

// URL 安全字符集，去掉了易混淆与非 nanoid 字符，长度 16 不可猜测
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const nano = customAlphabet(ALPHABET, 16);

const ID_RE = /^[0-9A-Za-z]{16}$/;

function newId() {
  return nano();
}

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// MIME / 扩展名 → 逻辑类型，返回 null 表示不支持
function typeForMime(mime, filename) {
  const m = (mime || '').toLowerCase();
  const ext = path.extname(filename || '').toLowerCase();
  if (m === 'text/html' || ext === '.html' || ext === '.htm') return 'html';
  if (m.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (m.startsWith('video/') || ['.mp4', '.webm'].includes(ext)) return 'video';
  return null;
}

function metaPath(id) {
  return path.join(config.storage.metaDir, `${id}.json`);
}

// 某条上传的文件落盘目录： <typeDir>/<id>/
function fileDir(type, id) {
  return path.join(config.dirForType(type), id);
}

function readMeta(id) {
  if (!isValidId(id)) return null;
  const p = metaPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeMeta(id, data) {
  fs.mkdirSync(config.storage.metaDir, { recursive: true });
  fs.writeFileSync(metaPath(id), JSON.stringify(data, null, 2));
}

// 上传文件的绝对路径（拼 meta 里记录的 filename）
function filePath(meta) {
  return path.join(fileDir(meta.type, meta.id), meta.filename);
}

// 删除一条上传：文件目录 + meta
function remove(id) {
  const meta = readMeta(id);
  if (!meta) return false;
  const dir = fileDir(meta.type, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(metaPath(id), { force: true });
  return true;
}

// 遍历 metaDir 汇总全部上传，按 createdAt 倒序
function listAll() {
  const dir = config.storage.metaDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = {
  newId,
  isValidId,
  typeForMime,
  metaPath,
  fileDir,
  filePath,
  readMeta,
  writeMeta,
  remove,
  listAll,
};
