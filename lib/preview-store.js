// 只读预览存储：按统一 data_root 布局读 meta/文件，不加载 config.yaml
const fs = require('fs');
const path = require('path');

const ID_RE = /^[0-9A-Za-z]{16}$/;

function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
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

  function filePath(meta) {
    const dir = fileDir(meta.type, meta.id);
    if (!dir) return null;
    return path.join(dir, meta.filename);
  }

  return {
    dataRoot: root,
    isValidId,
    readMeta,
    filePath,
    fileDir,
    metaPath,
  };
}

module.exports = { isValidId, createPreviewStore, ID_RE };
