const fs = require('fs');
const path = require('path');
const { customAlphabet } = require('nanoid');
const config = require('./config');
const { isValidId, typeFor, mimeFor } = require('./preview-store');
const { isZipUpload } = require('./site-archive');
const resourceIndex = require('./resource-index');
const statistics = require('./statistics');
const visits = require('./visit-stats');
const versions = require('./versions');

// URL 安全字符集，去掉了易混淆与非 nanoid 字符，长度 16 不可猜测
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const nano = customAlphabet(ALPHABET, 16);

function newId() {
  return nano();
}

// 扩展名（无扩展名时参考白名单 MIME）→ 逻辑类型，返回 null 表示不支持。zip 是多页面站点。
function typeForMime(mime, filename) {
  if (isZipUpload(mime, filename)) return 'site';
  return typeFor(filename, mime);
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
  const temporary = `${metaPath(id)}.${process.pid}.tmp`;
  const intent = statistics.prepareUpload(data);
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
    fs.renameSync(temporary, metaPath(id));
  } catch (error) {
    statistics.cancelUpload(intent);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  statistics.commitUpload(data, intent);
  resourceIndex.upsert(data);
  visits.syncResource(data);
}

// 第 n 版的目录；n 省略时为当前版本。
function versionDir(meta, n = versions.current(meta)) {
  return versions.dir(fileDir(meta.type, meta.id), n);
}

// 上传文件的绝对路径（站点是入口 index.html）；n 省略时为当前版本，meta 顶层的 filename 总是当前版本的。
function filePath(meta, n) {
  const entry = n === undefined ? { filename: meta.filename } : versions.find(meta, n);
  return entry ? path.join(versionDir(meta, n), entry.filename) : null;
}

// 删除一条上传：文件目录 + meta
function remove(id, reason = 'admin') {
  const meta = readMeta(id);
  if (!meta) return false;
  const intent = statistics.prepareDelete(meta, reason);
  const dir = fileDir(meta.type, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(metaPath(id), { force: true });
  statistics.commitDelete(intent);
  resourceIndex.remove(id);
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

// 按账户/来源列出（source === 账户 name）
function listBySource(source) {
  if (!source) return [];
  return listAll().filter((m) => m.source === source);
}

module.exports = {
  newId,
  isValidId,
  typeForMime,
  mimeFor,
  metaPath,
  fileDir,
  versionDir,
  filePath,
  readMeta,
  writeMeta,
  remove,
  listAll,
  listBySource,
};
