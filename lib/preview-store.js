// 只读预览存储：按统一 data_root 布局读 meta/文件，不加载 config.yaml
const fs = require('fs');
const path = require('path');
const versions = require('./versions');

const ID_RE = /^[0-9A-Za-z]{16}$/;

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// 站点内相对路径的一段：上传解压和预览路由用同一规则。"~" 开头留给预览地址里的访问凭证。
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

module.exports = { isValidId, validSegment, createPreviewStore, ID_RE };
