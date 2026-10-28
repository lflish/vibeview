// 只读预览存储：按统一 data_root 布局读 meta/文件，不加载 config.yaml
const fs = require('fs');
const path = require('path');
const versions = require('./versions');

const ID_RE = /^[0-9A-Za-z]{16}$/;

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// 站点内相对路径的一段：上传解压和预览路由用同一规则。"~" 开头留给预览地址里的访问凭证。
// 单文件资源的扩展名白名单：类型与原始文件的响应 MIME 都由服务端决定，不信任客户端上报的 MIME。
const FORMATS = {
  '.html': { type: 'html', mime: 'text/html; charset=utf-8' },
  '.htm': { type: 'html', mime: 'text/html; charset=utf-8' },
  '.png': { type: 'image', mime: 'image/png' },
  '.jpg': { type: 'image', mime: 'image/jpeg' },
  '.jpeg': { type: 'image', mime: 'image/jpeg' },
  '.gif': { type: 'image', mime: 'image/gif' },
  '.webp': { type: 'image', mime: 'image/webp' },
  '.svg': { type: 'image', mime: 'image/svg+xml' },
  '.mp4': { type: 'video', mime: 'video/mp4' },
  '.webm': { type: 'video', mime: 'video/webm' },
};
// 文件名没有扩展名时才参考客户端 MIME，且只接受与白名单完全对应的值。
const EXT_BY_MIME = {
  'text/html': '.html',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

function formatFor(filename, mime) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext) return FORMATS[ext] || null;
  const fallback = EXT_BY_MIME[String(mime || '').split(';')[0].trim().toLowerCase()];
  return fallback ? FORMATS[fallback] : null;
}

/** 单文件资源的类型：'html' | 'image' | 'video'，不支持时返回 null */
function typeFor(filename, mime) {
  const format = formatFor(filename, mime);
  return format ? format.type : null;
}

/** 原始文件的响应 MIME；历史数据无法识别或与资源类型不符时按二进制下发 */
function mimeFor(type, filename, mime) {
  const format = formatFor(filename, mime);
  return format && format.type === type ? format.mime : 'application/octet-stream';
}

function validSegment(segment) {
  return typeof segment === 'string' && !!segment && segment.length <= 200 && segment !== '.' && segment !== '..'
    && !segment.startsWith('~') && !/[\u0000-\u001f\u007f\\/:*?"<>|]/.test(segment);
}

/**
 * @param {string} dataRoot 容器内通常为 /data；本地可为 ./data
 */
function createPreviewStore(dataRoot) {
  const root = path.resolve(dataRoot);
  const dirs = {
    html: path.join(root, 'html'),
    image: path.join(root, 'images'),
    video: path.join(root, 'videos'),
    site: path.join(root, 'sites'),
    meta: path.join(root, 'meta'),
  };

  function metaPath(id) {
    return path.join(dirs.meta, `${id}.json`);
  }

  function fileDir(type, id) {
    const base = dirs[type];
    if (!base) return null;
    return path.join(base, id);
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

  // 第 n 版的目录；n 省略时为当前版本。
  function versionDir(meta, n = versions.current(meta)) {
    const dir = fileDir(meta.type, meta.id);
    return dir ? versions.dir(dir, n) : null;
  }

  // 文件路径；n 省略时为当前版本（meta 顶层的 filename 总是当前版本的）。
  function filePath(meta, n) {
    const entry = n === undefined ? { filename: meta.filename } : versions.find(meta, n);
    const dir = versionDir(meta, n);
    return dir && entry ? path.join(dir, entry.filename) : null;
  }

  return {
    dataRoot: root,
    isValidId,
    readMeta,
    filePath,
    fileDir,
    versionDir,
    metaPath,
  };
}

module.exports = { isValidId, validSegment, createPreviewStore, ID_RE, typeFor, mimeFor };
